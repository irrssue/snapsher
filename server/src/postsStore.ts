import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, type PostRow } from "./db.js";
import { avatarsDir, avatarUrlFor } from "./avatarsStore.js";
import { areFriends, friendIdsFor } from "./friendsStore.js";
import { likeStatsFor, type LikeStats } from "./likesStore.js";
import { commentCountFor } from "./commentsStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const uploadsDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o750 });
// `mkdirSync`'s mode applies only at creation and is masked by the process
// umask; a directory that already existed keeps whatever mode it was made with.
// Re-asserting it here is what makes 0750 true of the homeserver's copy too,
// rather than only of a freshly created one.
fs.chmodSync(uploadsDir, 0o750);

/** One photo per 12 hours — the whole point of the product, enforced here. */
const POST_INTERVAL_MS = 12 * 60 * 60 * 1000;

const FEED_LIMIT = 100;

/**
 * The profile grid was the one read with no cap at all, so any member could ask
 * for any other member's entire post history 600 times per quarter hour, and
 * `likeStatsFor`/`commentCountFor` would compile a fresh prepared statement for
 * every distinct post count they had never seen before. The 12-hour rule bounds
 * a history to ~730 posts a year, so this is a robustness bound rather than an
 * urgent one — but it also makes that statement-cache key space finite, which
 * is what stops it growing for the life of the process.
 */
const PROFILE_GRID_LIMIT = 300;

/**
 * Row-level access control for posts.
 *
 * SQLite has no `CREATE POLICY`, so the equivalent is enforced by making this
 * module the only place that touches the `posts` table and giving every
 * exported function an `Actor`. There is no callable path that reads or writes
 * a post row without naming the user it is acting for, which is what keeps a
 * request from reaching another account's rows even if a route forgets a check.
 *
 * The policies themselves:
 *   - feed        — a member may read their own posts and their friends' posts
 *   - quota       — a user may only ever see their own posting window
 *   - create      — the author is taken from the session, never from the body
 *   - delete      — the post's own author, and nobody else
 *   - profile grid / photo bytes — the author or one of their friends
 *
 * That last one used to read "public within the app", on the reasoning that a
 * profile already shows its avatar and post count to any member. It was wrong,
 * and it was the single largest hole in the app: about.md says a stranger's
 * profile shows avatar, username and post count — not the photos. The grid
 * handed out photoUrl, description and createdAt for up to 300 posts of any
 * user id, and `resolvePhotoFor` took an `Actor` it never looked at, so one
 * fresh account plus `seq 1 5000` was a complete archive of every photo and
 * caption on the instance. Friendship is the visibility boundary everywhere
 * else — the feed, likes, comment threads — and now it is the boundary here
 * too. Avatars stay public within the app; they are on the profile header
 * about.md explicitly makes visible.
 */
export type Actor = { userId: number };

/**
 * A read or write refused by one of the policies above. `status` and `code`
 * ride along so routes stay thin — same shape as `LikeError`/`CommentError`.
 */
export class PostAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type PublicPost = {
  id: string;
  username: string;
  avatarUrl: string | null;
  description: string | null;
  photoUrl: string;
  createdAt: number;
  likedByMe: boolean;
  isOwner: boolean;
  /** Only ever set when `isOwner` is true — nobody else may learn a post's like count. */
  likeCount?: number;
  /** Public, unlike likeCount — anyone who can open the thread can already count it. */
  commentCount: number;
};

type FeedRow = Pick<PostRow, "id" | "user_id" | "description" | "photo_file" | "created_at"> & {
  username: string;
  avatar_file: string | null;
};

export class QuotaExceededError extends Error {
  constructor(readonly nextAllowedAt: number) {
    super("Posting quota not yet available.");
  }
}

function toPublicPost(
  row: FeedRow,
  actor: Actor,
  stats: LikeStats | undefined,
  commentCount: number,
): PublicPost {
  const isOwner = row.user_id === actor.userId;
  return {
    id: String(row.id),
    username: row.username,
    // Sourced straight from the users row on every read, so a re-uploaded
    // avatar shows up in the feed immediately without touching posts.
    avatarUrl: avatarUrlFor(row.avatar_file),
    // Posts shared without a description have none at all — the client drops
    // the description bubble entirely rather than rendering an empty one.
    description: row.description,
    photoUrl: `/uploads/${row.photo_file}`,
    createdAt: row.created_at,
    likedByMe: stats?.likedByMe ?? false,
    isOwner,
    ...(isOwner ? { likeCount: stats?.count ?? 0 } : {}),
    commentCount,
  };
}

const FEED_COLUMNS = `posts.id, posts.user_id, posts.description, posts.photo_file, posts.created_at, users.username, users.avatar_file`;

/**
 * The `?` placeholders for the author list are spliced in per-call since
 * better-sqlite3 has no array binding — `listFeedFor` builds this with one
 * `?` per id in `authorIds` before preparing it.
 *
 * Because the SQL text varies, this can't be prepared once at module load like
 * every other statement here; instead each distinct placeholder count is
 * compiled once and kept, so a user with a stable friend list stops paying for
 * a fresh parse on every feed load. The map is bounded by the number of
 * distinct friend-list sizes in use, which is at most the number of accounts.
 */
const feedStatements = new Map<number, ReturnType<typeof db.prepare>>();

function selectFeedStatement(authorCount: number) {
  const cached = feedStatements.get(authorCount);
  if (cached) return cached;

  const placeholders = new Array(authorCount).fill("?").join(", ");
  const statement = db.prepare(
    `SELECT ${FEED_COLUMNS}
       FROM posts
       JOIN users ON users.id = posts.user_id
      WHERE posts.user_id IN (${placeholders})
      ORDER BY posts.created_at DESC
      LIMIT ?`,
  );
  feedStatements.set(authorCount, statement);
  return statement;
}
const selectPostById = db.prepare(
  `SELECT ${FEED_COLUMNS}
     FROM posts
     JOIN users ON users.id = posts.user_id
    WHERE posts.id = ?`,
);
/**
 * The 12-hour window is read off the *user*, never off `MAX(posts.created_at)`.
 *
 * Deriving it from the posts table was correct only while posts were permanent.
 * With a delete route it becomes a refund: share a photo, delete it, share
 * another — the cooldown resets every time, and the one rule the product exists
 * to enforce is gone. `users.last_post_at` is spent by the insert and never
 * touched by a delete, so the window outlives the row that bought it.
 */
const selectLastPostAt = db.prepare("SELECT last_post_at FROM users WHERE id = ?");
const markPostedAt = db.prepare("UPDATE users SET last_post_at = ? WHERE id = ?");
const selectPostCount = db.prepare("SELECT COUNT(*) AS count FROM posts WHERE user_id = ?");
const selectUserPosts = db.prepare(
  "SELECT id, description, photo_file, created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
);
const selectPhotoOwner = db.prepare(
  "SELECT user_id FROM posts WHERE photo_file = ?",
);
const selectPostOwner = db.prepare("SELECT user_id, photo_file FROM posts WHERE id = ?");
/**
 * The `user_id` is in the WHERE clause as well as being checked by the caller.
 * Belt and braces on the one statement in this module that destroys data: the
 * ownership check and the delete are two separate reads of the same row, and
 * this is what makes the second one incapable of removing a post the first one
 * didn't approve.
 */
const deletePostStmt = db.prepare("DELETE FROM posts WHERE id = ? AND user_id = ?");
const insertPost = db.prepare(
  "INSERT INTO posts (user_id, description, photo_file, created_at) VALUES (?, ?, ?, ?)",
);

function assertActor(actor: Actor) {
  if (!Number.isInteger(actor?.userId) || actor.userId <= 0) {
    throw new Error("postsStore called without a valid actor.");
  }
}

function nextAllowedAt(userId: number): number {
  const row = selectLastPostAt.get(userId) as { last_post_at: number } | undefined;
  // A missing row means the account was deleted mid-request; 0 is the same
  // answer as "never posted", and every caller either has a session that is
  // about to fail or a write that the foreign key will refuse anyway.
  const lastPostAt = row?.last_post_at ?? 0;
  return lastPostAt > 0 ? lastPostAt + POST_INTERVAL_MS : 0;
}

/**
 * Home feed policy: a member sees their own posts plus posts from accepted
 * friends only — never the whole member base. [[Actor]] alone used to be
 * enough to read every row here; it no longer is now that friendship gates
 * visibility, which is why the author list below is computed per call rather
 * than cached.
 */
export function listFeedFor(actor: Actor): PublicPost[] {
  assertActor(actor);
  const authorIds = [actor.userId, ...friendIdsFor(actor)];
  const rows = selectFeedStatement(authorIds.length).all(
    ...authorIds,
    FEED_LIMIT,
  ) as FeedRow[];
  const postIds = rows.map((row) => row.id);
  const stats = likeStatsFor(actor, postIds);
  const commentCounts = commentCountFor(postIds);
  return rows.map((row) =>
    toPublicPost(row, actor, stats.get(row.id), commentCounts.get(row.id) ?? 0),
  );
}

/**
 * `serverNow` ships alongside the window because `nextAllowedAt` is an absolute
 * timestamp on *this* machine's clock. A client that compares it against its own
 * `Date.now()` is really comparing two clocks: a device running half an hour
 * fast counts down to zero early, enables Share, and gets a 429 for its trouble.
 * Sending the server's own reading lets the client measure the offset once and
 * subtract it out.
 */
export function quotaFor(actor: Actor) {
  assertActor(actor);
  const allowedAt = nextAllowedAt(actor.userId);
  const now = Date.now();
  // `postCount` rides along here rather than a route of its own: it's the same
  // "read your own row" policy as the rest of this function, and the profile
  // screen that shows it already fetches the quota on load.
  const { count } = selectPostCount.get(actor.userId) as { count: number };
  return { nextAllowedAt: allowedAt, canPost: now >= allowedAt, serverNow: now, postCount: count };
}

/**
 * The quota re-check, the insert and the window being spent all share one
 * transaction, so two requests racing each other can't both read "you may post"
 * and each land a row — and so a crash between the insert and the update can't
 * leave a post that cost its author nothing.
 */
const insertWithinQuota = db.transaction(
  (userId: number, description: string | null, photoFile: string, createdAt: number) => {
    const allowedAt = nextAllowedAt(userId);
    if (createdAt < allowedAt) throw new QuotaExceededError(allowedAt);
    const id = insertPost.run(userId, description, photoFile, createdAt).lastInsertRowid;
    markPostedAt.run(createdAt, userId);
    return id;
  },
);

export function createPostFor(
  actor: Actor,
  input: { description: string | null; photoFile: string },
): { post: PublicPost; nextAllowedAt: number } {
  assertActor(actor);

  const createdAt = Date.now();
  const id = insertWithinQuota(actor.userId, input.description, input.photoFile, createdAt);

  return {
    // A brand-new post has no likes or comments yet, so there's nothing to batch-fetch.
    post: toPublicPost(selectPostById.get(id) as FeedRow, actor, undefined, 0),
    nextAllowedAt: createdAt + POST_INTERVAL_MS,
  };
}

/** Peek at the quota without writing, so an over-quota request fails cheaply. */
export function nextAllowedAtFor(actor: Actor): number {
  assertActor(actor);
  return nextAllowedAt(actor.userId);
}

/**
 * Unlike `quotaFor`, not scoped to an actor: a post count is public on
 * anyone's profile, so this backs the public profile view for a user id
 * that isn't necessarily the caller.
 */
export function postCountFor(userId: number): number {
  const { count } = selectPostCount.get(userId) as { count: number };
  return count;
}

export type PostSummary = {
  id: string;
  photoUrl: string;
  createdAt: number;
  description: string | null;
  likedByMe: boolean;
  isOwner: boolean;
  /** Only ever set when `isOwner` is true — nobody else may learn a post's like count. */
  likeCount?: number;
  /** Public, unlike likeCount — anyone who can open the thread can already count it. */
  commentCount: number;
};

/** Whether `actor` is inside the friends-only boundary around `userId`'s photos. */
function canSeePostsOf(actor: Actor, userId: number): boolean {
  return userId === actor.userId || areFriends(actor, userId);
}

/**
 * The grid on a profile screen — your own, or a friend's.
 *
 * A stranger gets a `PostAccessError`, not an empty list: an empty grid beside
 * a post count of 40 reads as a bug, and the client has a locked state to show
 * instead. The count itself stays public (see `postCountFor`), because that is
 * exactly what about.md says a profile shows anyone. The photos are what it
 * doesn't.
 *
 * Every interaction reachable from this grid — like, likers, comment threads —
 * was already gated on friendship by `likesStore`/`commentsStore`, which is
 * what made the old behaviour so visibly wrong from the client's side: it
 * rendered controls whose every use was guaranteed to 404. With visibility and
 * interactivity now the same boundary, anything you can see here you can act
 * on, and there is nothing for a `canInteract` flag to say.
 */
export function listPostsFor(actor: Actor, userId: number): PostSummary[] {
  assertActor(actor);
  if (!canSeePostsOf(actor, userId)) {
    throw new PostAccessError("You can only see photos from friends.", 403, "not_friends");
  }

  const rows = selectUserPosts.all(userId, PROFILE_GRID_LIMIT) as Pick<
    PostRow,
    "id" | "description" | "photo_file" | "created_at"
  >[];
  const postIds = rows.map((row) => row.id);
  const stats = likeStatsFor(actor, postIds);
  const isOwner = userId === actor.userId;

  // `commentCountFor` does no visibility check of its own — it trusts the
  // caller to have filtered first. The guard above is that filter: everyone who
  // reaches this line can open every thread on this grid, which is the whole
  // justification for the badge (about.md: the count saves a scroll, it doesn't
  // reveal anything a reader couldn't already count).
  const commentCounts = commentCountFor(postIds);
  return rows.map((row) => {
    const rowStats = stats.get(row.id);
    return {
      id: String(row.id),
      photoUrl: `/uploads/${row.photo_file}`,
      createdAt: row.created_at,
      description: row.description,
      likedByMe: rowStats?.likedByMe ?? false,
      isOwner,
      ...(isOwner ? { likeCount: rowStats?.count ?? 0 } : {}),
      commentCount: commentCounts.get(row.id) ?? 0,
    };
  });
}

/**
 * Resolves an upload filename to a path on disk — for the post's own author or
 * one of their friends, and nobody else.
 *
 * The `Actor` was a parameter this function accepted and then ignored,
 * verifying only that the filename backed *some* post row. Every photo URL in
 * the app is a bare UUID under `/uploads`, so that check amounted to "is this a
 * real photo", and any signed-in member holding any URL got the bytes. Serving
 * the file has to answer the same question as showing it in the grid, or the
 * grid's permission check is decoration.
 *
 * `null` for both "no such file" and "not yours to see", because the caller
 * answers 404 either way and a rejection must never confirm a file exists.
 */
export function resolvePhotoFor(actor: Actor, photoFile: string): string | null {
  assertActor(actor);

  const post = selectPhotoOwner.get(photoFile) as Pick<PostRow, "user_id"> | undefined;
  if (!post) return null;
  if (!canSeePostsOf(actor, post.user_id)) return null;

  return path.join(uploadsDir, photoFile);
}

/**
 * Deletes one of the actor's own posts and hands back the photo file the caller
 * now has to remove from disk.
 *
 * `null` covers both "no such post" and "not yours", which the route answers
 * with the same 404 — an author learning that post #812 exists but belongs to
 * someone else is an existence oracle over sequential ids for no benefit.
 *
 * Likes and comments go with it through `ON DELETE CASCADE` (see db.ts).
 * `users.last_post_at` deliberately does not: see the note on that column for
 * why refunding the window here would end the 12-hour rule.
 */
export function deletePostFor(actor: Actor, postId: number): string | null {
  assertActor(actor);

  const row = selectPostOwner.get(postId) as
    | Pick<PostRow, "user_id" | "photo_file">
    | undefined;
  if (!row || row.user_id !== actor.userId) return null;

  deletePostStmt.run(postId, actor.userId);
  return row.photo_file;
}

/**
 * Removes upload files that no database row points at any more.
 *
 * Nothing here is transactional across the filesystem and the database, and it
 * can't be: deleting an account, deleting a post and replacing an avatar all
 * commit the row first and then `rm` the file, because that ordering is the
 * safe one — a file left behind is wasted disk, whereas a row pointing at a
 * file that is already gone is a broken photo in someone's feed. A failed or
 * interrupted `rm` therefore leaks, and account deletion leaks up to one file
 * per post at once.
 *
 * `MIN_ORPHAN_AGE_MS` is what keeps this from racing the upload path, which
 * writes the file *before* the row exists: a photo written a second ago with no
 * row yet is almost certainly a request still in flight, not an orphan. An hour
 * is far longer than any request can live.
 */
const MIN_ORPHAN_AGE_MS = 60 * 60 * 1000;

const selectAllPhotoFiles = db.prepare("SELECT photo_file FROM posts");
const selectAllAvatarFiles = db.prepare(
  "SELECT avatar_file FROM users WHERE avatar_file IS NOT NULL",
);

async function sweepOrphans(dir: string, referenced: Set<string>, now: number) {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[uploads] could not read ${dir}`, err);
    return;
  }

  for (const entry of entries) {
    // `uploads/avatars` is a directory inside `uploads`, and is swept on its
    // own pass with its own reference set.
    if (!entry.isFile()) continue;
    if (referenced.has(entry.name)) continue;

    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs < MIN_ORPHAN_AGE_MS) continue;
      await fs.promises.rm(filePath, { force: true });
      console.log(`[uploads] removed orphaned file ${entry.name}`);
    } catch (err) {
      // One unreadable or undeletable file must not stop the rest of the sweep.
      console.warn(`[uploads] could not remove ${entry.name}`, err);
    }
  }
}

/**
 * Hourly, alongside the session and verification sweepers. Reads the two
 * filename columns in full rather than statting each file against the database:
 * the 12-hour rule bounds the whole corpus to ~730 rows per account per year,
 * so both sets fit in memory by construction.
 */
export function startUploadSweeper() {
  const sweep = () => {
    const now = Date.now();
    const photos = new Set(
      (selectAllPhotoFiles.all() as Pick<PostRow, "photo_file">[]).map((row) => row.photo_file),
    );
    const avatars = new Set(
      (selectAllAvatarFiles.all() as { avatar_file: string }[]).map((row) => row.avatar_file),
    );
    // Deliberately not awaited: this is a background task, and `sweepOrphans`
    // resolves its own failures rather than rejecting. The `.catch` is there
    // because an unhandled rejection out here would take the process down (see
    // index.ts) and take every in-memory rate-limit counter with it.
    void Promise.all([
      sweepOrphans(uploadsDir, photos, now),
      sweepOrphans(avatarsDir, avatars, now),
    ]).catch((err) => console.warn("[uploads] sweep failed", err));
  };
  sweep();
  const timer = setInterval(sweep, 60 * 60 * 1000);
  timer.unref();
}

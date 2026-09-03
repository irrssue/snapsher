import { db } from "./db.js";
import { avatarUrlFor } from "./avatarsStore.js";
import { areFriends } from "./friendsStore.js";

/**
 * Row-level access control for likes, on the same principle as postsStore and
 * friendsStore: every exported function takes the acting user, so a route
 * can't accidentally act on behalf of someone it didn't authenticate.
 *
 * The policies:
 *   - like/unlike — only on a post the actor may already see (own or a friend's)
 *   - who-liked   — only the post's author may ever see that list or its count
 */
export type Actor = { userId: number };

export type PublicLiker = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

export class LikeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function assertActor(actor: Actor) {
  if (!Number.isInteger(actor?.userId) || actor.userId <= 0) {
    throw new Error("likesStore called without a valid actor.");
  }
}

const selectPostAuthor = db.prepare("SELECT user_id FROM posts WHERE id = ?");
const selectLike = db.prepare("SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?");
const insertLike = db.prepare(
  "INSERT OR IGNORE INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)",
);
const deleteLike = db.prepare("DELETE FROM likes WHERE post_id = ? AND user_id = ?");
const countLikes = db.prepare("SELECT COUNT(*) AS count FROM likes WHERE post_id = ?");
// `likes` has no id of its own — the (post_id, user_id) pair is the key — so
// `user_id` is what breaks a tie on `created_at`. Two taps inside the same
// millisecond are otherwise ordered however SQLite happens to return them,
// which is stable in practice and guaranteed nowhere: cosmetic while this list
// is whole, wrong the moment anything pages through it.
const selectLikers = db.prepare(`
  SELECT users.id, users.username, users.avatar_file
    FROM likes
    JOIN users ON users.id = likes.user_id
   WHERE likes.post_id = ?
   ORDER BY likes.created_at DESC, likes.user_id DESC
`);

/** Same audience as the feed itself — a post's author or one of their friends. */
function assertCanView(actor: Actor, postId: number): number {
  const post = selectPostAuthor.get(postId) as { user_id: number } | undefined;
  if (!post) throw new LikeError("That post doesn't exist.", 404);
  if (post.user_id !== actor.userId && !areFriends(actor, post.user_id)) {
    throw new LikeError("That post doesn't exist.", 404);
  }
  return post.user_id;
}

/**
 * `count` comes back only when the actor is the post's own author, on the same
 * rule as `likersFor` below: a like count is the author's to see and nobody
 * else's. The author does need it here, though — their own tap changes a number
 * already on their screen, and without a server-sourced value the optimistic
 * count drifts from reality the moment anyone else likes the same post.
 */
export function toggleLike(actor: Actor, postId: number): { liked: boolean; count?: number } {
  assertActor(actor);
  const authorId = assertCanView(actor, postId);
  const isAuthor = authorId === actor.userId;

  const liked = !selectLike.get(postId, actor.userId);
  if (liked) {
    insertLike.run(postId, actor.userId, Date.now());
  } else {
    deleteLike.run(postId, actor.userId);
  }

  if (!isAuthor) return { liked };
  const { count } = countLikes.get(postId) as { count: number };
  return { liked, count };
}

/**
 * The full "who liked this" list, restricted to the post's own author and
 * deliberately not reachable for anyone else, friend or not. Naming the
 * individual likers is something only this function ever does; a bare count
 * reaches the author by two other routes (`PublicPost.likeCount` on the feed
 * and `toggleLike` above), and never reaches anybody else by any of them.
 */
export function likersFor(actor: Actor, postId: number): PublicLiker[] {
  assertActor(actor);
  const post = selectPostAuthor.get(postId) as { user_id: number } | undefined;
  if (!post || post.user_id !== actor.userId) {
    throw new LikeError("That post doesn't exist.", 404);
  }
  const rows = selectLikers.all(postId) as {
    id: number;
    username: string;
    avatar_file: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    avatarUrl: avatarUrlFor(row.avatar_file),
  }));
}

export type LikeStats = { count: number; likedByMe: boolean };

/**
 * One statement per distinct post count. The `?` placeholders have to be
 * spliced into the SQL text — better-sqlite3 has no array binding — so this
 * can't be prepared once at module load; caching by count means a feed of a
 * given size is only ever parsed once instead of on every load. The map is
 * bounded by the feed limit, so at most ~100 entries.
 */
const likeStatsStatements = new Map<number, ReturnType<typeof db.prepare>>();

function likeStatsStatement(postCount: number) {
  const cached = likeStatsStatements.get(postCount);
  if (cached) return cached;

  const placeholders = new Array(postCount).fill("?").join(", ");
  const statement = db.prepare(
    `SELECT post_id, COUNT(*) AS count,
            SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS liked_by_me
       FROM likes
      WHERE post_id IN (${placeholders})
      GROUP BY post_id`,
  );
  likeStatsStatements.set(postCount, statement);
  return statement;
}

/**
 * Batched like stats for a page of posts, so rendering a feed of N posts
 * doesn't cost N round trips to the likes table.
 */
export function likeStatsFor(actor: Actor, postIds: number[]): Map<number, LikeStats> {
  assertActor(actor);
  const stats = new Map<number, LikeStats>();
  if (postIds.length === 0) return stats;

  const rows = likeStatsStatement(postIds.length).all(actor.userId, ...postIds) as {
    post_id: number;
    count: number;
    liked_by_me: number;
  }[];

  for (const row of rows) {
    stats.set(row.post_id, { count: row.count, likedByMe: row.liked_by_me > 0 });
  }
  return stats;
}

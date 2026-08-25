import { db } from "./db.js";
import { avatarUrlFor } from "./avatarsStore.js";
import { areFriends } from "./friendsStore.js";

/**
 * Row-level access control for comments, on the same principle as postsStore,
 * friendsStore and likesStore: every exported function takes the acting user,
 * so a route can't accidentally act on behalf of someone it didn't
 * authenticate, and this module is the only thing that touches the table.
 *
 * The policies:
 *   - read   — only on a post the actor may already see (their own or a friend's)
 *   - write  — same audience; the author is taken from the session, never the body
 *   - delete — the comment's own writer, or the owner of the post it sits on
 *
 * Unlike a like count, a comment count is public: anyone who can open the
 * thread can already count the replies in it by scrolling, so `commentCountFor`
 * below just saves them the scroll rather than exposing anything new.
 */
export type Actor = { userId: number };

/** Long enough for a real reply, short enough that a thread stays readable. */
export const MAX_COMMENT_LENGTH = 500;

export type PublicComment = {
  id: number;
  username: string;
  avatarUrl: string | null;
  body: string;
  createdAt: number;
  /** Whether this request's user may delete it — their own, or on their post. */
  canDelete: boolean;
};

export class CommentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function assertActor(actor: Actor) {
  if (!Number.isInteger(actor?.userId) || actor.userId <= 0) {
    throw new Error("commentsStore called without a valid actor.");
  }
}

const selectPostAuthor = db.prepare("SELECT user_id FROM posts WHERE id = ?");
const selectComments = db.prepare(`
  SELECT comments.id, comments.user_id, comments.body, comments.created_at,
         users.username, users.avatar_file
    FROM comments
    JOIN users ON users.id = comments.user_id
   WHERE comments.post_id = ?
   ORDER BY comments.created_at ASC, comments.id ASC
`);
const insertComment = db.prepare(
  "INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
);
const selectCommentById = db.prepare(
  "SELECT id, post_id, user_id FROM comments WHERE id = ?",
);
const deleteCommentStmt = db.prepare("DELETE FROM comments WHERE id = ?");
const selectOneComment = db.prepare(`
  SELECT comments.id, comments.user_id, comments.body, comments.created_at,
         users.username, users.avatar_file
    FROM comments
    JOIN users ON users.id = comments.user_id
   WHERE comments.id = ?
`);

type CommentJoinRow = {
  id: number;
  user_id: number;
  body: string;
  created_at: number;
  username: string;
  avatar_file: string | null;
};

/**
 * Same audience as the feed and the like button — a post's author or one of
 * their friends. The 404 is identical to the one for a post that doesn't exist,
 * so a refusal never confirms that it does.
 */
function assertCanView(actor: Actor, postId: number): number {
  const post = selectPostAuthor.get(postId) as { user_id: number } | undefined;
  if (!post) throw new CommentError("That post doesn't exist.", 404);
  if (post.user_id !== actor.userId && !areFriends(actor, post.user_id)) {
    throw new CommentError("That post doesn't exist.", 404);
  }
  return post.user_id;
}

function toPublicComment(row: CommentJoinRow, actor: Actor, postAuthorId: number): PublicComment {
  return {
    id: row.id,
    username: row.username,
    avatarUrl: avatarUrlFor(row.avatar_file),
    body: row.body,
    createdAt: row.created_at,
    // Your own words, or anything said on your own post. The second half
    // matters because this app has no block and no report: a post's author
    // moderating their own thread is the only such control that exists.
    canDelete: row.user_id === actor.userId || postAuthorId === actor.userId,
  };
}

export function listComments(actor: Actor, postId: number): PublicComment[] {
  assertActor(actor);
  const postAuthorId = assertCanView(actor, postId);
  const rows = selectComments.all(postId) as CommentJoinRow[];
  return rows.map((row) => toPublicComment(row, actor, postAuthorId));
}

export function addComment(actor: Actor, postId: number, body: unknown): PublicComment {
  assertActor(actor);
  const postAuthorId = assertCanView(actor, postId);

  if (typeof body !== "string") {
    throw new CommentError("A comment is required.", 400);
  }
  const trimmed = body.trim();
  if (!trimmed) {
    throw new CommentError("A comment can't be empty.", 400);
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new CommentError(
      `A comment must be ${MAX_COMMENT_LENGTH} characters or fewer.`,
      400,
    );
  }

  const id = insertComment.run(postId, actor.userId, trimmed, Date.now()).lastInsertRowid;
  return toPublicComment(selectOneComment.get(id) as CommentJoinRow, actor, postAuthorId);
}

/**
 * One statement per distinct post count, on the same caching rule as
 * `likeStatsStatement` in likesStore.ts — the `?` placeholders have to be
 * spliced into the SQL text since better-sqlite3 has no array binding.
 */
const commentCountStatements = new Map<number, ReturnType<typeof db.prepare>>();

function commentCountStatement(postCount: number) {
  const cached = commentCountStatements.get(postCount);
  if (cached) return cached;

  const placeholders = new Array(postCount).fill("?").join(", ");
  const statement = db.prepare(
    `SELECT post_id, COUNT(*) AS count
       FROM comments
      WHERE post_id IN (${placeholders})
      GROUP BY post_id`,
  );
  commentCountStatements.set(postCount, statement);
  return statement;
}

/**
 * Batched comment counts for a page of posts, so rendering a feed of N posts
 * doesn't cost N round trips to the comments table. No actor/visibility check
 * here — the caller (the feed) has already filtered to posts it may show.
 */
export function commentCountFor(postIds: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  if (postIds.length === 0) return counts;

  const rows = commentCountStatement(postIds.length).all(...postIds) as {
    post_id: number;
    count: number;
  }[];

  for (const row of rows) {
    counts.set(row.post_id, row.count);
  }
  return counts;
}

export function deleteComment(actor: Actor, postId: number, commentId: number): void {
  assertActor(actor);
  const postAuthorId = assertCanView(actor, postId);

  const comment = selectCommentById.get(commentId) as
    | { id: number; post_id: number; user_id: number }
    | undefined;
  // The post id from the URL is checked against the row rather than trusted,
  // so a comment can't be deleted by naming some other post the actor happens
  // to be allowed to see.
  if (!comment || comment.post_id !== postId) {
    throw new CommentError("That comment no longer exists.", 404);
  }
  if (comment.user_id !== actor.userId && postAuthorId !== actor.userId) {
    throw new CommentError("That comment no longer exists.", 404);
  }

  deleteCommentStmt.run(commentId);
}

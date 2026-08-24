import { db } from "./db.js";
import { avatarUrlFor } from "./avatarsStore.js";
import { friendIdsFor } from "./friendsStore.js";

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
const selectLikers = db.prepare(`
  SELECT users.id, users.username, users.avatar_file
    FROM likes
    JOIN users ON users.id = likes.user_id
   WHERE likes.post_id = ?
   ORDER BY likes.created_at DESC
`);

/** Same audience as the feed itself — a post's author or one of their friends. */
function assertCanView(actor: Actor, postId: number): number {
  const post = selectPostAuthor.get(postId) as { user_id: number } | undefined;
  if (!post) throw new LikeError("That post doesn't exist.", 404);
  if (post.user_id !== actor.userId && !friendIdsFor(actor).includes(post.user_id)) {
    throw new LikeError("That post doesn't exist.", 404);
  }
  return post.user_id;
}

export function toggleLike(actor: Actor, postId: number): { liked: boolean } {
  assertActor(actor);
  assertCanView(actor, postId);

  if (selectLike.get(postId, actor.userId)) {
    deleteLike.run(postId, actor.userId);
    return { liked: false };
  }
  insertLike.run(postId, actor.userId, Date.now());
  return { liked: true };
}

/**
 * The full "who liked this" list, restricted to the post's own author — this
 * is the one place in the app that reveals like counts at all, and it's
 * deliberately not reachable for anyone else, friend or not.
 */
export function likersFor(actor: Actor, postId: number): PublicLiker[] {
  assertActor(actor);
  const authorId = selectPostAuthor.get(postId) as { user_id: number } | undefined;
  if (!authorId || authorId.user_id !== actor.userId) {
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
 * Batched like stats for a page of posts, so rendering a feed of N posts
 * doesn't cost N round trips to the likes table.
 */
export function likeStatsFor(actor: Actor, postIds: number[]): Map<number, LikeStats> {
  assertActor(actor);
  const stats = new Map<number, LikeStats>();
  if (postIds.length === 0) return stats;

  const placeholders = new Array(postIds.length).fill("?").join(", ");
  const rows = db
    .prepare(
      `SELECT post_id, COUNT(*) AS count,
              SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS liked_by_me
         FROM likes
        WHERE post_id IN (${placeholders})
        GROUP BY post_id`,
    )
    .all(actor.userId, ...postIds) as { post_id: number; count: number; liked_by_me: number }[];

  for (const row of rows) {
    stats.set(row.post_id, { count: row.count, likedByMe: row.liked_by_me > 0 });
  }
  return stats;
}

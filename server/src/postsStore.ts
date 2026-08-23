import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, type PostRow } from "./db.js";
import { avatarUrlFor } from "./avatarsStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const uploadsDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o750 });

/** One photo per 12 hours — the whole point of the product, enforced here. */
const POST_INTERVAL_MS = 12 * 60 * 60 * 1000;

const FEED_LIMIT = 100;

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
 *   - feed        — any signed-in member may read every member's posts
 *   - quota       — a user may only ever see their own posting window
 *   - create      — the author is taken from the session, never from the body
 *   - photo bytes — readable only if it belongs to a post the actor may read
 */
export type Actor = { userId: number };

export type PublicPost = {
  id: string;
  username: string;
  avatarUrl: string | null;
  description: string | null;
  photoUrl: string;
  createdAt: number;
};

type FeedRow = Pick<PostRow, "id" | "description" | "photo_file" | "created_at"> & {
  username: string;
  avatar_file: string | null;
};

export class QuotaExceededError extends Error {
  constructor(readonly nextAllowedAt: number) {
    super("Posting quota not yet available.");
  }
}

function toPublicPost(row: FeedRow): PublicPost {
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
  };
}

const FEED_COLUMNS = `posts.id, posts.description, posts.photo_file, posts.created_at, users.username, users.avatar_file`;

const selectFeed = db.prepare(
  `SELECT ${FEED_COLUMNS}
     FROM posts
     JOIN users ON users.id = posts.user_id
    ORDER BY posts.created_at DESC
    LIMIT ?`,
);
const selectPostById = db.prepare(
  `SELECT ${FEED_COLUMNS}
     FROM posts
     JOIN users ON users.id = posts.user_id
    WHERE posts.id = ?`,
);
const selectLastPostAt = db.prepare(
  "SELECT created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
);
const selectPhotoOwner = db.prepare(
  "SELECT user_id FROM posts WHERE photo_file = ?",
);
const insertPost = db.prepare(
  "INSERT INTO posts (user_id, description, photo_file, created_at) VALUES (?, ?, ?, ?)",
);

function assertActor(actor: Actor) {
  if (!Number.isInteger(actor?.userId) || actor.userId <= 0) {
    throw new Error("postsStore called without a valid actor.");
  }
}

function nextAllowedAt(userId: number): number {
  const last = selectLastPostAt.get(userId) as Pick<PostRow, "created_at"> | undefined;
  return last ? last.created_at + POST_INTERVAL_MS : 0;
}

export function listFeedFor(actor: Actor): PublicPost[] {
  assertActor(actor);
  return (selectFeed.all(FEED_LIMIT) as FeedRow[]).map(toPublicPost);
}

export function quotaFor(actor: Actor) {
  assertActor(actor);
  const allowedAt = nextAllowedAt(actor.userId);
  return { nextAllowedAt: allowedAt, canPost: Date.now() >= allowedAt };
}

/**
 * The quota re-check and the insert share one transaction so two requests
 * racing each other can't both read "you may post" and each land a row.
 */
const insertWithinQuota = db.transaction(
  (userId: number, description: string | null, photoFile: string, createdAt: number) => {
    const allowedAt = nextAllowedAt(userId);
    if (createdAt < allowedAt) throw new QuotaExceededError(allowedAt);
    return insertPost.run(userId, description, photoFile, createdAt).lastInsertRowid;
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
    post: toPublicPost(selectPostById.get(id) as FeedRow),
    nextAllowedAt: createdAt + POST_INTERVAL_MS,
  };
}

/** Peek at the quota without writing, so an over-quota request fails cheaply. */
export function nextAllowedAtFor(actor: Actor): number {
  assertActor(actor);
  return nextAllowedAt(actor.userId);
}

/**
 * Resolves an upload filename to a path on disk, but only for a signed-in
 * actor and only when the file actually backs a post — a loose file dropped
 * into the uploads directory is not reachable.
 *
 * Under the current feed policy every member may read every member's photos,
 * so the actor is not narrowing the result today; it is the parameter a
 * narrower policy (followers-only, private posts) would filter on, and the
 * caller answers 404 either way so a rejection never confirms the file exists.
 */
export function resolvePhotoFor(actor: Actor, photoFile: string): string | null {
  assertActor(actor);

  const post = selectPhotoOwner.get(photoFile) as Pick<PostRow, "user_id"> | undefined;
  if (!post) return null;

  return path.join(uploadsDir, photoFile);
}

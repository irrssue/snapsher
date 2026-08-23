import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, type PostRow } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const uploadsDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

/** One photo per 12 hours — the whole point of the product, enforced here. */
const POST_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const PHOTO_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const EXTENSION_BY_FORMAT: Record<string, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

type FeedRow = Pick<PostRow, "id" | "description" | "photo_file" | "created_at"> & {
  username: string;
};

function toPublicPost(row: FeedRow) {
  return {
    id: String(row.id),
    username: row.username,
    // Posts shared without a description have none at all — the client drops
    // the description bubble entirely rather than rendering an empty one.
    description: row.description,
    photoUrl: `/uploads/${row.photo_file}`,
    createdAt: row.created_at,
  };
}

function nextAllowedAt(userId: number) {
  const lastPost = db
    .prepare("SELECT created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(userId) as Pick<PostRow, "created_at"> | undefined;

  return lastPost ? lastPost.created_at + POST_INTERVAL_MS : 0;
}

export const postsRouter = Router();

postsRouter.get("/", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT posts.id, posts.description, posts.photo_file, posts.created_at, users.username
       FROM posts
       JOIN users ON users.id = posts.user_id
       ORDER BY posts.created_at DESC
       LIMIT 100`,
    )
    .all() as FeedRow[];

  res.json({ posts: rows.map(toPublicPost) });
});

postsRouter.get("/quota", (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    return res.status(401).json({ error: "Not signed in." });
  }

  const allowedAt = nextAllowedAt(userId);
  res.json({ nextAllowedAt: allowedAt, canPost: Date.now() >= allowedAt });
});

postsRouter.post("/", (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    return res.status(401).json({ error: "Not signed in." });
  }

  const { photo, description } = req.body ?? {};

  if (typeof photo !== "string") {
    return res.status(400).json({ error: "A photo is required." });
  }

  const match = PHOTO_DATA_URL_RE.exec(photo);
  if (!match) {
    return res.status(400).json({ error: "That file isn't a supported image." });
  }

  if (description != null && typeof description !== "string") {
    return res.status(400).json({ error: "Description must be text." });
  }
  const trimmedDescription = typeof description === "string" ? description.trim() : "";
  if (trimmedDescription.length > MAX_DESCRIPTION_LENGTH) {
    return res
      .status(400)
      .json({ error: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` });
  }

  const allowedAt = nextAllowedAt(userId);
  if (Date.now() < allowedAt) {
    return res.status(429).json({
      error: "You've already shared a photo in the last 12 hours.",
      nextAllowedAt: allowedAt,
    });
  }

  const [, format, base64] = match;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0) {
    return res.status(400).json({ error: "That photo appears to be empty." });
  }
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    return res.status(413).json({ error: "That photo is too large." });
  }

  const photoFile = `${crypto.randomUUID()}.${EXTENSION_BY_FORMAT[format]}`;
  fs.writeFileSync(path.join(uploadsDir, photoFile), bytes);

  const createdAt = Date.now();
  let result;
  try {
    result = db
      .prepare(
        "INSERT INTO posts (user_id, description, photo_file, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(userId, trimmedDescription || null, photoFile, createdAt);
  } catch (err) {
    // Don't leave an orphaned file behind if the row never landed.
    fs.rmSync(path.join(uploadsDir, photoFile), { force: true });
    throw err;
  }

  const row = db
    .prepare(
      `SELECT posts.id, posts.description, posts.photo_file, posts.created_at, users.username
       FROM posts
       JOIN users ON users.id = posts.user_id
       WHERE posts.id = ?`,
    )
    .get(result.lastInsertRowid) as FeedRow;

  res.status(201).json({
    post: toPublicPost(row),
    nextAllowedAt: createdAt + POST_INTERVAL_MS,
  });
});

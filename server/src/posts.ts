import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { config } from "./config.js";
import { rateLimit } from "./rateLimit.js";
import { requireAuth } from "./sessions.js";
import { asyncRoute } from "./security.js";
import {
  createPostFor,
  listFeedFor,
  nextAllowedAtFor,
  quotaFor,
  QuotaExceededError,
  resolvePhotoFor,
  uploadsDir,
  type Actor,
} from "./postsStore.js";
import { likersFor, toggleLike, LikeError } from "./likesStore.js";
import { addComment, CommentError, deleteComment, listComments } from "./commentsStore.js";
import {
  carriesExifMetadata,
  CONTENT_TYPE_BY_EXTENSION,
  EXTENSION_BY_FORMAT,
  PHOTO_DATA_URL_RE,
  sniffFormat,
  withinPixelBudget,
  type ImageFormat,
} from "./images.js";

const MAX_DESCRIPTION_LENGTH = 300;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Only ever a UUID plus one of our three extensions — no path separators, no dots. */
const PHOTO_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

function actorOf(req: express.Request): Actor {
  return { userId: req.auth!.user.id };
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const postsRouter = Router();

postsRouter.use(requireAuth);

postsRouter.get("/", (req, res) => {
  res.json({ posts: listFeedFor(actorOf(req)) });
});

postsRouter.get("/quota", (req, res) => {
  res.json(quotaFor(actorOf(req)));
});

postsRouter.post(
  "/",
  rateLimit(config.rateLimits.createPost),
  // Photos arrive as base64 data URLs in the JSON body, so this one route gets
  // a much larger cap than the 16kb the rest of the API accepts.
  express.json({ limit: "12mb" }),
  asyncRoute(async (req, res) => {
    const actor = actorOf(req);
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

    // Reject an over-quota post before spending anything on decoding or disk.
    const allowedAt = nextAllowedAtFor(actor);
    if (Date.now() < allowedAt) {
      return res.status(429).json({
        error: "You've already shared a photo in the last 12 hours.",
        nextAllowedAt: allowedAt,
      });
    }

    const [, declaredFormat, base64] = match;
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength === 0) {
      return res.status(400).json({ error: "That photo appears to be empty." });
    }
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      return res.status(413).json({ error: "That photo is too large." });
    }
    if (sniffFormat(bytes) !== declaredFormat) {
      return res.status(400).json({ error: "That file isn't a supported image." });
    }

    // Two header-only checks, both answering with the same 400 as the
    // magic-byte check above so a rejection still discloses nothing:
    //   - the byte cap says nothing about pixel count, so a small file that
    //     declares an enormous frame passes everything above and then knocks
    //     over every browser that later loads this profile. An unreadable
    //     header is refused too — a size that can't be read can't be bounded.
    //   - bytes still carrying an Exif block did not come from our client,
    //     which re-encodes through a <canvas>; storing them re-serves the
    //     uploader's GPS coordinates to everyone who can see the photo.
    // Both are explained in full in images.ts.
    if (
      !withinPixelBudget(bytes, declaredFormat as ImageFormat) ||
      carriesExifMetadata(bytes, declaredFormat as ImageFormat)
    ) {
      return res.status(400).json({ error: "That file isn't a supported image." });
    }

    const photoFile = `${crypto.randomUUID()}.${EXTENSION_BY_FORMAT[declaredFormat as ImageFormat]}`;
    const photoPath = path.join(uploadsDir, photoFile);
    // Written asynchronously: a synchronous write of up to 8 MB blocks the
    // event loop for its whole duration, which stalls every other request in
    // flight — including the feed loads of everyone else on the server.
    await fs.promises.writeFile(photoPath, bytes, { mode: 0o640 });

    try {
      const created = createPostFor(actor, {
        description: trimmedDescription || null,
        photoFile,
      });
      res.status(201).json(created);
    } catch (err) {
      // Don't leave an orphaned file behind if the row never landed.
      await fs.promises.rm(photoPath, { force: true });

      if (err instanceof QuotaExceededError) {
        return res.status(429).json({
          error: "You've already shared a photo in the last 12 hours.",
          nextAllowedAt: err.nextAllowedAt,
        });
      }
      throw err;
    }
  }),
);

postsRouter.post(
  "/:id/like",
  rateLimit(config.rateLimits.like),
  express.json({ limit: "1kb" }),
  (req, res) => {
    const postId = parseId(req.params.id);
    if (postId === null) return res.status(404).json({ error: "Not found." });

    try {
      res.json(toggleLike(actorOf(req), postId));
    } catch (err) {
      if (err instanceof LikeError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  },
);

/**
 * Who liked a post — the only place this app ever names them, and deliberately
 * restricted to the post's own author, the same audience allowed a bare count.
 */
postsRouter.get("/:id/likers", (req, res) => {
  const postId = parseId(req.params.id);
  if (postId === null) return res.status(404).json({ error: "Not found." });

  try {
    res.json({ likers: likersFor(actorOf(req), postId) });
  } catch (err) {
    if (err instanceof LikeError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

/**
 * Comments. Readable by the same audience as the post itself, and returned as a
 * plain list — there is no count endpoint and no count field anywhere, which is
 * the same rule the like button follows and the reason `about.md` gives for
 * both: the interaction exists, the score-keeping doesn't.
 */
postsRouter.get("/:id/comments", (req, res) => {
  const postId = parseId(req.params.id);
  if (postId === null) return res.status(404).json({ error: "Not found." });

  try {
    res.json({ comments: listComments(actorOf(req), postId) });
  } catch (err) {
    if (err instanceof CommentError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

postsRouter.post(
  "/:id/comments",
  rateLimit(config.rateLimits.createComment),
  express.json({ limit: "4kb" }),
  (req, res) => {
    const postId = parseId(req.params.id);
    if (postId === null) return res.status(404).json({ error: "Not found." });

    try {
      // The body is validated inside the store, beside the length limit it is
      // checked against, so the rule lives in one place.
      res.status(201).json({ comment: addComment(actorOf(req), postId, req.body?.body) });
    } catch (err) {
      if (err instanceof CommentError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  },
);

postsRouter.delete("/:id/comments/:commentId", (req, res) => {
  const postId = parseId(req.params.id);
  const commentId = parseId(req.params.commentId);
  if (postId === null || commentId === null) {
    return res.status(404).json({ error: "Not found." });
  }

  try {
    deleteComment(actorOf(req), postId, commentId);
    res.status(204).end();
  } catch (err) {
    if (err instanceof CommentError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

/**
 * Photos are served through the app rather than as blind static files, so that
 * reading one requires a session and goes through the same row-level check as
 * the post it belongs to. Previously any URL-holder — signed in or not — could
 * fetch every photo on the server.
 */
export const uploadsRouter = Router();

uploadsRouter.use(requireAuth);

uploadsRouter.get("/:file", (req, res) => {
  const file = req.params.file;
  if (!PHOTO_FILE_RE.test(file)) return res.status(404).json({ error: "Not found." });

  const photoPath = resolvePhotoFor(actorOf(req), file);
  if (!photoPath) return res.status(404).json({ error: "Not found." });

  res.type(CONTENT_TYPE_BY_EXTENSION[file.split(".").pop()!]);
  res.setHeader("Content-Disposition", "inline");
  // Content is immutable per filename, but it is nobody else's to cache.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(photoPath, { dotfiles: "deny" }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Not found." });
  });
});

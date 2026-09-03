import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { config } from "./config.js";
import { authenticatedKey, rateLimit } from "./rateLimit.js";
import { requireAuth } from "./sessions.js";
import { asyncRoute } from "./security.js";
import {
  createPostFor,
  deletePostFor,
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
  stripMetadata,
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

function parseId(raw: unknown): number | null {
  // Express 5 permits a repeated path parameter to be exposed as an array.
  // IDs are one scalar segment only; accepting an array by coercion would turn
  // a malformed route into a different identifier than the client sent.
  if (typeof raw !== "string") return null;
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

/**
 * The 12-hour window, checked before the body is read.
 *
 * This is a middleware rather than the first few lines of the handler because
 * of where `express.json` sits: as a handler check it ran *after* body-parser
 * had already buffered, base64-decoded and JSON-parsed up to 12 MB from a
 * caller we were about to refuse anyway. Someone with a valid session and a
 * spent window could push 12 MB through the parser as fast as the rate limiter
 * allowed and always get a 429 for it. Ahead of the parser, the same request
 * costs one indexed read and the socket is closed on it.
 *
 * The transaction in `insertWithinQuota` is still the authority — this is an
 * optimisation, and two requests racing each other both pass here.
 */
const refuseWhenOverQuota: express.RequestHandler = (req, res, next) => {
  const allowedAt = nextAllowedAtFor(actorOf(req));
  if (Date.now() < allowedAt) {
    return res.status(429).json({
      error: "You've already shared a photo in the last 12 hours.",
      nextAllowedAt: allowedAt,
    });
  }
  next();
};

postsRouter.post(
  "/",
  // Keyed on the account, not the address: everyone behind one NAT used to
  // share a single ten-posts-an-hour budget. See `authenticatedKey`.
  rateLimit(config.rateLimits.createPost, authenticatedKey),
  refuseWhenOverQuota,
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

    // The byte cap says nothing about pixel count, so a small file that
    // declares an enormous frame passes everything above and then knocks over
    // every browser that later loads this profile. An unreadable header is
    // refused on the same 400 as the magic-byte check above, so a rejection
    // still discloses nothing — and a size that can't be read can't be bounded.
    if (!withinPixelBudget(bytes, declaredFormat as ImageFormat)) {
      return res.status(400).json({ error: "That file isn't a supported image." });
    }

    // What actually reaches the disk is the upload with its Exif, XMP and
    // comment blocks removed: a photo carries the coordinates it was taken at,
    // and storing it verbatim would re-serve them to everyone who can see it.
    // `null` means the file's structure couldn't be walked, so its metadata
    // can't be accounted for. Both are explained in full in images.ts.
    const stored = stripMetadata(bytes, declaredFormat as ImageFormat);
    if (!stored) {
      return res.status(400).json({ error: "That file isn't a supported image." });
    }

    const photoFile = `${crypto.randomUUID()}.${EXTENSION_BY_FORMAT[declaredFormat as ImageFormat]}`;
    const photoPath = path.join(uploadsDir, photoFile);
    // Written asynchronously: a synchronous write of up to 8 MB blocks the
    // event loop for its whole duration, which stalls every other request in
    // flight — including the feed loads of everyone else on the server.
    await fs.promises.writeFile(photoPath, stored, { mode: 0o640 });

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

/**
 * Deleting your own photo — the only way anything ever leaves this app, and the
 * retraction the pixel-budget and Exif checks in images.ts previously had to
 * stand in for.
 *
 * It does *not* give the 12-hour window back. `deletePostFor` explains why in
 * full: the quota lives on the user row precisely so this route can't become
 * post → delete → post again.
 */
postsRouter.delete(
  "/:id",
  asyncRoute(async (req, res) => {
    const postId = parseId(req.params.id);
    // Same 404 as a post belonging to someone else, so a stranger walking
    // sequential ids learns nothing about which of them exist.
    if (postId === null) return res.status(404).json({ error: "That post doesn't exist." });

    const photoFile = deletePostFor(actorOf(req), postId);
    if (!photoFile) return res.status(404).json({ error: "That post doesn't exist." });

    // The row is what the user asked to be rid of and it is already gone; a
    // file that outlives it is wasted disk the hourly sweeper in postsStore
    // collects, not a reason to tell them the delete failed and leave them
    // pressing a button on a post that no longer exists.
    try {
      await fs.promises.rm(path.join(uploadsDir, photoFile), { force: true });
    } catch (err) {
      console.warn(`[posts] could not remove ${photoFile} after deleting its post`, err);
    }

    res.status(204).end();
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
 * Comments. Readable by the same audience as the post itself.
 *
 * A count *is* published — `commentCount` on every post and grid summary this
 * file serves — and `about.md` says why that is not the same concession as a
 * like count: anyone who can open a thread could already count the replies by
 * scrolling it, so the badge saves the scroll and reveals nothing. A like count
 * has no such reading; nothing on screen tells anyone but the author what it
 * is, which is why that one stays the author's alone.
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
  // Per-account, not per-address — see `authenticatedKey`.
  rateLimit(config.rateLimits.createComment, authenticatedKey),
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

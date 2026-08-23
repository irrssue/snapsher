import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { config } from "./config.js";
import { rateLimit } from "./rateLimit.js";
import { requireAuth } from "./sessions.js";
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
import {
  CONTENT_TYPE_BY_EXTENSION,
  EXTENSION_BY_FORMAT,
  PHOTO_DATA_URL_RE,
  sniffFormat,
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
  (req, res) => {
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

    const photoFile = `${crypto.randomUUID()}.${EXTENSION_BY_FORMAT[declaredFormat as ImageFormat]}`;
    const photoPath = path.join(uploadsDir, photoFile);
    fs.writeFileSync(photoPath, bytes, { mode: 0o640 });

    try {
      const created = createPostFor(actor, {
        description: trimmedDescription || null,
        photoFile,
      });
      res.status(201).json(created);
    } catch (err) {
      // Don't leave an orphaned file behind if the row never landed.
      fs.rmSync(photoPath, { force: true });

      if (err instanceof QuotaExceededError) {
        return res.status(429).json({
          error: "You've already shared a photo in the last 12 hours.",
          nextAllowedAt: err.nextAllowedAt,
        });
      }
      throw err;
    }
  },
);

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

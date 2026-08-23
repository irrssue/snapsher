import path from "node:path";
import { Router } from "express";
import { requireAuth } from "./sessions.js";
import { AVATAR_FILE_RE, avatarsDir } from "./avatarsStore.js";
import { CONTENT_TYPE_BY_EXTENSION } from "./images.js";

/**
 * Unlike a post's photo, an avatar isn't scoped to who may read it — every
 * signed-in member already sees every other member's username on every post,
 * so a profile picture is public within the app the same way. Only the
 * filename shape is checked; there is no ownership row to enforce.
 */
export const avatarsRouter = Router();

avatarsRouter.use(requireAuth);

avatarsRouter.get("/:file", (req, res) => {
  const file = req.params.file;
  if (!AVATAR_FILE_RE.test(file)) return res.status(404).json({ error: "Not found." });

  const avatarPath = path.join(avatarsDir, file);
  res.type(CONTENT_TYPE_BY_EXTENSION[file.split(".").pop()!]);
  res.setHeader("Content-Disposition", "inline");
  // Content is immutable per filename, but re-uploading gives a new filename,
  // so the same UUID is safe to cache hard.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(avatarPath, { dotfiles: "deny" }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Not found." });
  });
});

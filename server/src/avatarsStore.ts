import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const avatarsDir = path.join(__dirname, "..", "uploads", "avatars");
fs.mkdirSync(avatarsDir, { recursive: true, mode: 0o750 });
// Re-asserted for the same reason as `uploadsDir` in postsStore.ts: the mode
// passed to `mkdirSync` only applies to a directory this call actually creates.
fs.chmodSync(avatarsDir, 0o750);

/** Only ever a UUID plus one of our three extensions — no path separators, no dots. */
export const AVATAR_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export function avatarUrlFor(avatarFile: string | null): string | null {
  return avatarFile ? `/uploads/avatars/${avatarFile}` : null;
}

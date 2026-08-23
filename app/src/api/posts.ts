import type { Post, PostQuota } from "../types";

async function parseBody(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || "Something went wrong. Please try again.");
  }
  return body;
}

export async function fetchPosts(): Promise<Post[]> {
  const res = await fetch("/api/posts", { credentials: "include" });
  return (await parseBody(res)).posts;
}

export async function fetchQuota(): Promise<PostQuota | null> {
  const res = await fetch("/api/posts/quota", { credentials: "include" });
  if (!res.ok) return null;
  return res.json();
}

export async function createPost(input: {
  photo: string;
  description: string;
}): Promise<{ post: Post; nextAllowedAt: number }> {
  const res = await fetch("/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseBody(res);
}

const MAX_EDGE = 1440;
const JPEG_QUALITY = 0.85;

/**
 * Downscale a picked file and re-encode it as a JPEG data URL, so a phone-sized
 * photo doesn't travel to the server at its original many-megabyte size.
 */
export async function readPhotoAsDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't read that photo.");

  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

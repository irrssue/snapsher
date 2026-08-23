import type { Post, PostQuota } from "../types";
import { api } from "./http";

export async function fetchPosts(): Promise<Post[]> {
  const { posts } = await api<{ posts: Post[] }>("/api/posts");
  return posts;
}

export async function fetchQuota(): Promise<PostQuota> {
  // Deliberately not swallowing failures: a quota that silently fell back to
  // "you can post now" is what hid a broken session until the share button was
  // already pressed.
  return api<PostQuota>("/api/posts/quota");
}

export async function createPost(input: {
  photo: string;
  description: string;
}): Promise<{ post: Post; nextAllowedAt: number }> {
  return api<{ post: Post; nextAllowedAt: number }>("/api/posts", {
    method: "POST",
    body: input,
  });
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

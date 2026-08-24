import type { Comment, Liker, Post, PostQuota } from "../types";
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

/**
 * `count` comes back only on the caller's own posts — a like count belongs to
 * the author and nobody else, so for a friend's post the field is simply absent
 * and there is nothing to reconcile.
 */
export async function toggleLike(
  postId: string,
): Promise<{ liked: boolean; count?: number }> {
  return api<{ liked: boolean; count?: number }>(`/api/posts/${postId}/like`, { method: "POST" });
}

export async function fetchLikers(postId: string): Promise<Liker[]> {
  const { likers } = await api<{ likers: Liker[] }>(`/api/posts/${postId}/likers`);
  return likers;
}

/**
 * There is no matching "how many comments" call, and deliberately so: the list
 * itself is the only thing the server will answer with. Reading a thread is the
 * one place its length is observable, exactly as with likers.
 */
export async function fetchComments(postId: string): Promise<Comment[]> {
  const { comments } = await api<{ comments: Comment[] }>(`/api/posts/${postId}/comments`);
  return comments;
}

export async function addComment(postId: string, body: string): Promise<Comment> {
  const { comment } = await api<{ comment: Comment }>(`/api/posts/${postId}/comments`, {
    method: "POST",
    body: { body },
  });
  return comment;
}

export async function deleteComment(postId: string, commentId: number): Promise<void> {
  await api(`/api/posts/${postId}/comments/${commentId}`, { method: "DELETE" });
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

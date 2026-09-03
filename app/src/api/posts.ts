import type { Comment, Liker, Post, PostQuota } from "../types";
import {
  assertPickableImage,
  ImageRejected,
  TOO_MANY_PIXELS_MESSAGE,
  undecodableMessage,
  withinPixelBudget,
} from "../images";
import { api, expectArray, expectBoolean, expectNumber, expectObject } from "./http";

export async function fetchPosts(): Promise<Post[]> {
  const { posts } = await api<{ posts: Post[] }>("/api/posts");
  return expectArray<Post>(posts, "feed");
}

export async function fetchQuota(): Promise<PostQuota> {
  // Deliberately not swallowing failures: a quota that silently fell back to
  // "you can post now" is what hid a broken session until the share button was
  // already pressed.
  const quota = await api<PostQuota>("/api/posts/quota");
  // Every countdown in the app subtracts these two, so a missing or non-numeric
  // one renders as "NaN:NaN:NaN" rather than as the failure it is.
  expectNumber(quota?.nextAllowedAt, "quota.nextAllowedAt");
  expectNumber(quota?.serverNow, "quota.serverNow");
  expectNumber(quota?.postCount, "quota.postCount");
  return quota;
}

export async function createPost(input: {
  photo: string;
  description: string;
}): Promise<{ post: Post; nextAllowedAt: number }> {
  const result = await api<{ post: Post; nextAllowedAt: number }>("/api/posts", {
    method: "POST",
    body: input,
  });
  expectObject<Post>(result?.post, "created post");
  expectNumber(result?.nextAllowedAt, "created post nextAllowedAt");
  return result;
}

/**
 * Irreversible, and deliberately does not give the 12-hour window back — the
 * server tracks the quota on the user row rather than on the posts table, so
 * deleting the most recent photo can't be used to buy another turn.
 */
export async function deletePost(postId: string): Promise<void> {
  await api(`/api/posts/${postId}`, { method: "DELETE" });
}

/**
 * `count` comes back only on the caller's own posts — a like count belongs to
 * the author and nobody else, so for a friend's post the field is simply absent
 * and there is nothing to reconcile.
 */
export async function toggleLike(
  postId: string,
): Promise<{ liked: boolean; count?: number }> {
  const result = await api<{ liked: boolean; count?: number }>(`/api/posts/${postId}/like`, {
    method: "POST",
  });
  expectBoolean(result?.liked, "like result");
  return result;
}

export async function fetchLikers(postId: string): Promise<Liker[]> {
  const { likers } = await api<{ likers: Liker[] }>(`/api/posts/${postId}/likers`);
  return expectArray<Liker>(likers, "likers");
}

/**
 * There is no matching "how many comments" call, and deliberately so: the list
 * itself is the only thing the server will answer with. Reading a thread is the
 * one place its length is observable, exactly as with likers.
 */
export async function fetchComments(postId: string): Promise<Comment[]> {
  const { comments } = await api<{ comments: Comment[] }>(`/api/posts/${postId}/comments`);
  return expectArray<Comment>(comments, "comments");
}

export async function addComment(postId: string, body: string): Promise<Comment> {
  const { comment } = await api<{ comment: Comment }>(`/api/posts/${postId}/comments`, {
    method: "POST",
    body: { body },
  });
  return expectObject<Comment>(comment, "created comment");
}

export async function deleteComment(postId: string, commentId: number): Promise<void> {
  await api(`/api/posts/${postId}/comments/${commentId}`, { method: "DELETE" });
}

const MAX_EDGE = 1440;
const JPEG_QUALITY = 0.85;

/**
 * Downscale a picked file and re-encode it as a JPEG data URL, so a phone-sized
 * photo doesn't travel to the server at its original many-megabyte size.
 *
 * Throws `ImageRejected` with a message worth showing when the file is not
 * something we should be decoding at all.
 */
export async function readPhotoAsDataUrl(file: File): Promise<string> {
  assertPickableImage(file);

  let bitmap: ImageBitmap;
  try {
    // `from-image` rather than the default: a photo held sideways records its
    // rotation as an Exif tag instead of in the pixels, and every browser that
    // ignores the tag here would upload it lying on its side — permanently,
    // since the canvas re-encode below is what the server stores and the tag
    // does not survive it.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // The one check no amount of header-reading can do in advance: whether
    // *this* browser has a decoder for these bytes. HEIC is the case that
    // actually comes up, and it gets a message that says so.
    throw new ImageRejected(undecodableMessage(file));
  }
  // The dimensions aren't knowable until here, and the canvas below is a second
  // allocation the same size as the bitmap — so this is the last point before
  // the memory is actually spent.
  if (!withinPixelBudget(bitmap.width, bitmap.height)) {
    bitmap.close();
    throw new ImageRejected(TOO_MANY_PIXELS_MESSAGE);
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Couldn't read that photo.");
  }

  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

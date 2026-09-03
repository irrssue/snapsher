import { useState } from "react";
import type { PostSummary } from "../types";
import { PostPreviewModal } from "./PostPreviewModal";

type PostGridProps = {
  posts: PostSummary[];
  /** Owner of every photo in the grid — shown in the preview opened on click. */
  username: string;
  avatarUrl: string | null;
  /** Passed through to the preview; its absence is what hides Delete there. */
  onPostDeleted?: (postId: string) => void;
  /** Bubbles a comment add/delete out so the list backing this grid can refetch. */
  onCountsChanged?: () => void;
  /**
   * "No posts yet." is the wrong sentence on your own profile and a slightly
   * cold one on someone else's, so the owner of the grid names it.
   */
  emptyLabel?: string;
};

/** Instagram-style 3-across grid of a profile's photos, cropped to squares. */
export function PostGrid({
  posts,
  username,
  avatarUrl,
  onPostDeleted,
  onCountsChanged,
  emptyLabel = "No photos yet.",
}: PostGridProps) {
  // The id rather than the post itself: a snapshot goes stale the moment the
  // list behind it is refetched, so an open preview kept showing counts from
  // before the comment that triggered the refetch — and would happily outlive
  // the post it describes. Looking it up each render closes the preview by
  // itself once the post is gone.
  const [previewPostId, setPreviewPostId] = useState<string | null>(null);
  const previewPost = posts.find((post) => post.id === previewPostId) ?? null;

  if (posts.length === 0) {
    return <p className="py-8 text-center text-sm text-neutral-400">{emptyLabel}</p>;
  }

  return (
    <>
      <div className="grid w-full grid-cols-3 gap-0.5">
        {posts.map((post) => (
          <button
            key={post.id}
            type="button"
            onClick={() => setPreviewPostId(post.id)}
            // Every cell used to announce the same "View photo", so tabbing a
            // thirty-photo grid was thirty identical stops.
            aria-label={
              post.description
                ? `View photo: ${post.description}`
                : `View photo from ${new Date(post.createdAt).toLocaleDateString()}`
            }
            className="aspect-square cursor-pointer overflow-hidden bg-field"
          >
            <img
              src={post.photoUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          </button>
        ))}
      </div>

      {previewPost && (
        <PostPreviewModal
          post={previewPost}
          username={username}
          avatarUrl={avatarUrl}
          onClose={() => setPreviewPostId(null)}
          onDeleted={
            onPostDeleted &&
            ((postId) => {
              setPreviewPostId(null);
              onPostDeleted(postId);
            })
          }
          onCountsChanged={onCountsChanged}
        />
      )}
    </>
  );
}

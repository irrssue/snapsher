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
};

/** Instagram-style 3-across grid of a profile's photos, cropped to squares. */
export function PostGrid({
  posts,
  username,
  avatarUrl,
  onPostDeleted,
  onCountsChanged,
}: PostGridProps) {
  // The id rather than the post itself: a snapshot goes stale the moment the
  // list behind it is refetched, so an open preview kept showing counts from
  // before the comment that triggered the refetch — and would happily outlive
  // the post it describes. Looking it up each render closes the preview by
  // itself once the post is gone.
  const [previewPostId, setPreviewPostId] = useState<string | null>(null);
  const previewPost = posts.find((post) => post.id === previewPostId) ?? null;

  if (posts.length === 0) {
    return <p className="py-8 text-center text-sm text-neutral-400">No posts yet.</p>;
  }

  return (
    <>
      <div className="grid w-full grid-cols-3 gap-0.5">
        {posts.map((post) => (
          <button
            key={post.id}
            type="button"
            onClick={() => setPreviewPostId(post.id)}
            aria-label="View photo"
            className="aspect-square cursor-pointer overflow-hidden bg-neutral-800"
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

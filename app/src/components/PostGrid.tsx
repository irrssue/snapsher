import { useState } from "react";
import type { PostSummary } from "../types";
import { PostPreviewModal } from "./PostPreviewModal";

type PostGridProps = {
  posts: PostSummary[];
  /** Owner of every photo in the grid — shown in the preview opened on click. */
  username: string;
  avatarUrl: string | null;
};

/** Instagram-style 3-across grid of a profile's photos, cropped to squares. */
export function PostGrid({ posts, username, avatarUrl }: PostGridProps) {
  const [previewPost, setPreviewPost] = useState<PostSummary | null>(null);

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
            onClick={() => setPreviewPost(post)}
            aria-label="View photo"
            className="aspect-square overflow-hidden bg-neutral-800"
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
          onClose={() => setPreviewPost(null)}
        />
      )}
    </>
  );
}

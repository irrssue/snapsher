import type { PostSummary } from "../types";

type PostGridProps = {
  posts: PostSummary[];
};

/** Instagram-style 3-across grid of a profile's photos, cropped to squares. */
export function PostGrid({ posts }: PostGridProps) {
  if (posts.length === 0) {
    return <p className="py-8 text-center text-sm text-neutral-400">No posts yet.</p>;
  }

  return (
    <div className="grid w-full grid-cols-3 gap-0.5">
      {posts.map((post) => (
        <div key={post.id} className="aspect-square overflow-hidden bg-neutral-800">
          <img
            src={post.photoUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        </div>
      ))}
    </div>
  );
}

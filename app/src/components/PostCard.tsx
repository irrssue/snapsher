import type { Post } from "../types";
import { HeartIcon, CommentIcon } from "./icons";

export function PostCard({ post }: { post: Post }) {
  return (
    <div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-center md:gap-10">
      {/*
       * `contents` on phones lets the photo sit *between* the description and
       * the action row, so a post reads top-to-bottom as author → description →
       * photo → like/comment. From md up this collapses back into the text
       * column that sits beside the photo.
       */}
      <div className="contents md:flex md:w-64 md:flex-col md:gap-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-300" />
          <span className="text-sm text-white">@{post.username}</span>
        </div>

        {post.description && (
          <div className="whitespace-pre-line rounded-2xl bg-neutral-800 px-4 py-3 text-sm text-neutral-200">
            {post.description}
          </div>
        )}

        <div className="-ml-2 order-1 flex items-center text-white md:order-none md:ml-0 md:gap-3">
          <button
            type="button"
            aria-label="Like"
            className="p-2 transition-opacity hover:opacity-70 md:p-0"
          >
            <HeartIcon className="h-6 w-6" />
          </button>
          <button
            type="button"
            aria-label="Comment"
            className="p-2 transition-opacity hover:opacity-70 md:p-0"
          >
            <CommentIcon className="h-6 w-6" />
          </button>
        </div>
      </div>

      <div className="aspect-square w-full overflow-hidden rounded-3xl bg-neutral-300 md:aspect-auto md:h-[21.6rem] md:w-[21.6rem] md:shrink-0">
        <img
          src={post.photoUrl}
          alt={post.description ?? `Photo shared by @${post.username}`}
          className="h-full w-full object-cover"
        />
      </div>
    </div>
  );
}

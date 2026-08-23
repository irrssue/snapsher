import type { Post } from "../types";
import { HeartIcon, CommentIcon } from "./icons";

export function PostCard({ post }: { post: Post }) {
  return (
    <div className="flex flex-col items-center gap-10 md:flex-row md:items-center md:justify-center">
      <div className="order-2 flex w-64 flex-col gap-3 md:order-1">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-300" />
          <span className="text-sm text-white">@{post.username}</span>
        </div>

        <div className="whitespace-pre-line rounded-2xl bg-neutral-800 px-4 py-3 text-sm text-neutral-200">
          {post.description}
        </div>

        <div className="flex items-center gap-3 text-white">
          <button
            type="button"
            aria-label="Like"
            className="transition-opacity hover:opacity-70"
          >
            <HeartIcon className="h-6 w-6" />
          </button>
          <button
            type="button"
            aria-label="Comment"
            className="transition-opacity hover:opacity-70"
          >
            <CommentIcon className="h-6 w-6" />
          </button>
        </div>
      </div>

      <div className="order-1 flex h-[19.2rem] w-[19.2rem] shrink-0 items-center justify-center rounded-full bg-neutral-300 text-center text-sm text-neutral-600 md:order-2 md:h-[21.6rem] md:w-[21.6rem]">
        {post.photoUrl ? (
          <img
            src={post.photoUrl}
            alt={post.description}
            className="h-full w-full rounded-full object-cover"
          />
        ) : (
          "this will be PHOTO"
        )}
      </div>
    </div>
  );
}

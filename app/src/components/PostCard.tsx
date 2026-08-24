import { useEffect, useRef, useState } from "react";
import type { Liker, Post } from "../types";
import { fetchLikers, toggleLike } from "../api/posts";
import { HeartIcon, CommentIcon, CloseIcon, PersonIcon } from "./icons";

const postDateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function PostCard({ post }: { post: Post }) {
  const [liked, setLiked] = useState(post.likedByMe);
  const [likeCount, setLikeCount] = useState(post.likeCount ?? 0);
  const [likersOpen, setLikersOpen] = useState(false);
  const [likers, setLikers] = useState<Liker[] | null>(null);
  const [likersError, setLikersError] = useState<string | null>(null);
  const pendingLike = useRef(false);

  useEffect(() => {
    if (!likersOpen) return;
    let active = true;

    setLikers(null);
    setLikersError(null);
    fetchLikers(post.id)
      .then((result) => active && setLikers(result))
      .catch((err) => active && setLikersError(err instanceof Error ? err.message : "Couldn't load likes."));

    return () => {
      active = false;
    };
  }, [likersOpen, post.id]);

  async function handleToggleLike() {
    // A tap while a previous toggle is still in flight would race the server
    // state, so this button only accepts one request at a time.
    if (pendingLike.current) return;
    pendingLike.current = true;

    const wasLiked = liked;
    setLiked(!wasLiked);
    setLikeCount((count) => count + (wasLiked ? -1 : 1));

    try {
      const result = await toggleLike(post.id);
      setLiked(result.liked);
    } catch {
      setLiked(wasLiked);
      setLikeCount((count) => count + (wasLiked ? 1 : -1));
    } finally {
      pendingLike.current = false;
    }
  }

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
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
            {post.avatarUrl ? (
              <img src={post.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <PersonIcon className="h-5 w-5 text-neutral-500" />
            )}
          </span>
          <span className="text-sm text-white">@{post.username}</span>
        </div>

        {post.description && (
          <div className="whitespace-pre-line rounded-2xl bg-neutral-800 px-4 py-3 text-sm text-neutral-200">
            {post.description}
          </div>
        )}

        <div className="relative -ml-2 order-1 flex items-center text-white md:order-none md:ml-0 md:gap-3">
          <button
            type="button"
            aria-label={liked ? "Unlike" : "Like"}
            aria-pressed={liked}
            onClick={handleToggleLike}
            className={`p-2 transition-opacity hover:opacity-70 md:p-0 ${
              liked ? "text-green-500" : ""
            }`}
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
          {/* Only the post's own author ever gets a like count to click into. */}
          {post.isOwner && (
            <button
              type="button"
              onClick={() => setLikersOpen((open) => !open)}
              className="text-xs text-neutral-400 transition-colors hover:text-white"
            >
              {likeCount} {likeCount === 1 ? "like" : "likes"}
            </button>
          )}
          <span className="ml-auto text-xs text-neutral-400">
            {postDateFormatter.format(new Date(post.createdAt))}
          </span>

          {likersOpen && (
            <div className="absolute bottom-full left-0 z-10 mb-2 w-52 rounded-2xl bg-neutral-800 p-3 shadow-lg">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-white">Liked by</span>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setLikersOpen(false)}
                  className="text-neutral-400 transition-colors hover:text-white"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </div>

              {likersError && <p className="text-xs text-red-400">{likersError}</p>}
              {!likersError && likers === null && (
                <p className="text-xs text-neutral-400">Loading…</p>
              )}
              {!likersError && likers?.length === 0 && (
                <p className="text-xs text-neutral-400">No likes yet.</p>
              )}
              {likers && likers.length > 0 && (
                <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
                  {likers.map((liker) => (
                    <li key={liker.id} className="flex items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
                        {liker.avatarUrl ? (
                          <img
                            src={liker.avatarUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <PersonIcon className="h-4 w-4 text-neutral-500" />
                        )}
                      </span>
                      <span className="truncate text-xs text-white">@{liker.username}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="aspect-square w-full overflow-hidden rounded-3xl bg-neutral-300 md:aspect-auto md:h-[21.6rem] md:w-[21.6rem] md:shrink-0">
        <img
          src={post.photoUrl}
          alt={post.description ?? `Photo shared by @${post.username}`}
          // Photos are now fetched through an authenticated route, so a feed of
          // 100 is 100 requests; only ask for the ones actually on screen.
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </div>
    </div>
  );
}

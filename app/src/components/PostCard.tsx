import { useEffect, useRef, useState } from "react";
import type { Comment, Liker, Post } from "../types";
import {
  addComment,
  deleteComment,
  fetchComments,
  fetchLikers,
  toggleLike,
} from "../api/posts";
import { HeartIcon, CommentIcon, CloseIcon, PersonIcon } from "./icons";

const postDateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const commentTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

/** Mirrors the server's own limit, so the cap is felt while typing. */
const MAX_COMMENT_LENGTH = 500;

export function PostCard({ post }: { post: Post }) {
  const [liked, setLiked] = useState(post.likedByMe);
  const [likeCount, setLikeCount] = useState(post.likeCount ?? 0);
  const [likersOpen, setLikersOpen] = useState(false);
  const [likers, setLikers] = useState<Liker[] | null>(null);
  const [likersError, setLikersError] = useState<string | null>(null);
  const pendingLike = useRef(false);

  const [commentsOpen, setCommentsOpen] = useState(false);
  /** Null means "not loaded yet", which is distinct from an empty thread. */
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

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

  useEffect(() => {
    if (!commentsOpen) return;
    let active = true;

    setComments(null);
    setCommentsError(null);
    fetchComments(post.id)
      .then((result) => active && setComments(result))
      .catch(
        (err) =>
          active &&
          setCommentsError(err instanceof Error ? err.message : "Couldn't load comments."),
      );

    return () => {
      active = false;
    };
  }, [commentsOpen, post.id]);

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setCommentsError(null);
    try {
      const created = await addComment(post.id, body);
      // Appended rather than refetched: the server returns the row it wrote, and
      // the thread is ordered oldest-first, so the new one belongs at the end.
      setComments((current) => [...(current ?? []), created]);
      setDraft("");
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : "Couldn't post that comment.");
    } finally {
      setSending(false);
    }
  }

  async function handleDeleteComment(comment: Comment) {
    setCommentsError(null);
    setComments((current) => current?.filter((c) => c.id !== comment.id) ?? null);
    try {
      await deleteComment(post.id, comment.id);
    } catch (err) {
      // Put it back rather than leave the thread asserting a deletion the
      // server never performed.
      setComments((current) =>
        current && !current.some((c) => c.id === comment.id)
          ? [...current, comment].sort((a, b) => a.createdAt - b.createdAt)
          : current,
      );
      setCommentsError(err instanceof Error ? err.message : "Couldn't delete that comment.");
    }
  }

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
      // The optimistic count above only knows about this tap. On the author's
      // own post the server sends back the real total, which is the only thing
      // that accounts for likes other people added since the feed was loaded —
      // without it the button drifts out of step with the popup it opens.
      // Absent on anyone else's post, where no count is shown at all.
      if (result.count !== undefined) setLikeCount(result.count);
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
          {/*
           * No badge, now or ever: `about.md` keeps the comment action and
           * drops the count, so this opens the thread without ever saying how
           * long it is.
           */}
          <button
            type="button"
            aria-label={commentsOpen ? "Hide comments" : "Comments"}
            aria-expanded={commentsOpen}
            onClick={() => setCommentsOpen((open) => !open)}
            className={`p-2 transition-opacity hover:opacity-70 md:p-0 ${
              commentsOpen ? "text-neutral-400" : ""
            }`}
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

        {/*
         * The thread sits in the flow below the action row rather than floating
         * over it like the likers popover: it holds an input and an arbitrary
         * number of replies, so it needs to push the layout rather than cover
         * it. `order-2` keeps it after the action row on phones, where the
         * column is `contents` and the parent is doing the ordering.
         */}
        {commentsOpen && (
          <div className="order-2 flex flex-col gap-3 rounded-2xl bg-neutral-800 p-3 md:order-none">
            {commentsError && <p className="text-xs text-red-400">{commentsError}</p>}

            {comments === null && !commentsError && (
              <p className="text-xs text-neutral-400">Loading…</p>
            )}

            {comments?.length === 0 && (
              <p className="text-xs text-neutral-400">No comments yet.</p>
            )}

            {comments && comments.length > 0 && (
              <ul className="flex max-h-56 flex-col gap-3 overflow-y-auto">
                {comments.map((comment) => (
                  <li key={comment.id} className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
                      {comment.avatarUrl ? (
                        <img
                          src={comment.avatarUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <PersonIcon className="h-4 w-4 text-neutral-500" />
                      )}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-xs font-semibold text-white">
                          @{comment.username}
                        </span>
                        <span className="shrink-0 text-[10px] text-neutral-500">
                          {commentTimeFormatter.format(new Date(comment.createdAt))}
                        </span>
                      </div>
                      <p className="whitespace-pre-line break-words text-xs text-neutral-200">
                        {comment.body}
                      </p>
                    </div>

                    {comment.canDelete && (
                      <button
                        type="button"
                        aria-label={`Delete comment by @${comment.username}`}
                        onClick={() => handleDeleteComment(comment)}
                        className="shrink-0 text-neutral-500 transition-colors hover:text-white"
                      >
                        <CloseIcon className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <form onSubmit={handleAddComment} className="flex items-center gap-2">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={MAX_COMMENT_LENGTH}
                placeholder="Add a comment"
                aria-label="Add a comment"
                className="min-w-0 flex-1 rounded-full bg-neutral-900 px-3 py-1.5 text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-600"
              />
              <button
                type="submit"
                disabled={!draft.trim() || sending}
                className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {sending ? "…" : "Post"}
              </button>
            </form>
          </div>
        )}
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

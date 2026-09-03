import { useEffect, useRef, useState } from "react";
import type { Comment, Liker } from "../types";
import {
  addComment,
  deleteComment,
  fetchComments,
  fetchLikers,
  toggleLike,
} from "../api/posts";
import { CloseIcon, CommentIcon, HeartIcon, PersonIcon, SendIcon } from "./icons";

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

type PostInteractionsProps = {
  postId: string;
  username: string;
  avatarUrl: string | null;
  description: string | null;
  createdAt: number;
  likedByMe: boolean;
  isOwner: boolean;
  likeCount?: number;
  commentCount: number;
  /**
   * Fires after a comment is added or deleted, so the caller can refetch the
   * lists these counts came from. Without it a comment left on your own post
   * from the feed never reaches the badge on the profile grid, which keeps
   * showing the count it was mounted with for the rest of the session.
   */
  onCountsChanged?: () => void;
};

/**
 * The avatar/description/like-comment column shared by `PostCard` (the home
 * feed) and `PostPreviewModal` (a profile grid photo) — same interactions,
 * same layout, just wrapped in different chrome by each caller.
 */
export function PostInteractions({
  postId,
  username,
  avatarUrl,
  description,
  createdAt,
  likedByMe,
  isOwner,
  likeCount: initialLikeCount,
  commentCount: initialCommentCount,
  onCountsChanged,
}: PostInteractionsProps) {
  const [liked, setLiked] = useState(likedByMe);
  const [likeCount, setLikeCount] = useState(initialLikeCount ?? 0);
  const [likersOpen, setLikersOpen] = useState(false);
  const [likers, setLikers] = useState<Liker[] | null>(null);
  const [likersError, setLikersError] = useState<string | null>(null);
  const pendingLike = useRef(false);
  const likersRef = useRef<HTMLDivElement>(null);
  const likersToggleRef = useRef<HTMLButtonElement>(null);
  const commentsPanelRef = useRef<HTMLDivElement>(null);
  const commentsToggleRef = useRef<HTMLButtonElement>(null);

  const [commentsOpen, setCommentsOpen] = useState(false);
  /** Null means "not loaded yet", which is distinct from an empty thread. */
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  /**
   * Mirrors the post's own comment count but tracked separately so the badge
   * updates the instant this user adds or deletes a comment, the same way
   * `likeCount` does for the heart — without it the badge would only catch up
   * on the next refetch.
   */
  const [commentCount, setCommentCount] = useState(initialCommentCount);

  /**
   * The three values above are seeded from props and then owned locally, so
   * that a tap updates them without waiting for a round trip. That made them
   * *deaf* to props: `PostCard` is keyed on `post.id`, so a refetched feed
   * reuses this instance, and every count the server had just corrected was
   * silently discarded. Re-seeding when the props themselves change keeps both
   * — instant local updates, and a refetch that still means something.
   */
  useEffect(() => {
    setLiked(likedByMe);
    setLikeCount(initialLikeCount ?? 0);
    setCommentCount(initialCommentCount);
  }, [likedByMe, initialLikeCount, initialCommentCount]);

  useEffect(() => {
    if (!likersOpen) return;
    let active = true;

    setLikers(null);
    setLikersError(null);
    fetchLikers(postId)
      .then((result) => active && setLikers(result))
      .catch((err) => active && setLikersError(err instanceof Error ? err.message : "Couldn't load likes."));

    return () => {
      active = false;
    };
  }, [likersOpen, postId]);

  /**
   * The likers popover has no backdrop to catch a tap and its close button is
   * the only other way out, so dismiss it on any press landing elsewhere. The
   * toggle counts as inside: closing on its press would let the click that
   * follows immediately reopen it.
   */
  useEffect(() => {
    if (!likersOpen) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (likersRef.current?.contains(target) || likersToggleRef.current?.contains(target)) return;
      setLikersOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [likersOpen]);

  /**
   * Same reasoning as the likers popover: no backdrop, so a press anywhere
   * outside the panel (or its own toggle, to avoid an instant reopen) closes
   * it, mirroring what the (x) button already does.
   */
  useEffect(() => {
    if (!commentsOpen) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (commentsPanelRef.current?.contains(target) || commentsToggleRef.current?.contains(target)) return;
      setCommentsOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [commentsOpen]);

  useEffect(() => {
    if (!commentsOpen) return;
    let active = true;

    setComments(null);
    setCommentsError(null);
    fetchComments(postId)
      .then((result) => active && setComments(result))
      .catch(
        (err) =>
          active &&
          setCommentsError(err instanceof Error ? err.message : "Couldn't load comments."),
      );

    return () => {
      active = false;
    };
  }, [commentsOpen, postId]);

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setCommentsError(null);
    try {
      const created = await addComment(postId, body);
      // Appended rather than refetched: the server returns the row it wrote, and
      // the thread is ordered oldest-first, so the new one belongs at the end.
      setComments((current) => [...(current ?? []), created]);
      setCommentCount((count) => count + 1);
      setDraft("");
      onCountsChanged?.();
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : "Couldn't post that comment.");
    } finally {
      setSending(false);
    }
  }

  async function handleDeleteComment(comment: Comment) {
    setCommentsError(null);
    setComments((current) => current?.filter((c) => c.id !== comment.id) ?? null);
    setCommentCount((count) => count - 1);
    try {
      await deleteComment(postId, comment.id);
      onCountsChanged?.();
    } catch (err) {
      // Put it back rather than leave the thread asserting a deletion the
      // server never performed.
      setComments((current) =>
        current && !current.some((c) => c.id === comment.id)
          ? [...current, comment].sort((a, b) => a.createdAt - b.createdAt)
          : current,
      );
      setCommentCount((count) => count + 1);
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
      const result = await toggleLike(postId);
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
    <div className="contents md:flex md:w-64 md:flex-col md:gap-3">
      {commentsOpen ? (
        /*
         * Comments swap in for the *entire* column — avatar, username,
         * description, and the like/comment row all disappear behind this
         * one panel rather than sharing space with it. Sized to the photo's
         * own height on desktop so the two read as a matched pair, side by
         * side, the way a lightbox pairs an image with its comment rail.
         */
        <div
          ref={commentsPanelRef}
          className="order-1 flex h-[26rem] flex-col overflow-hidden rounded-3xl bg-neutral-900 ring-1 ring-white/5 md:order-none md:h-[21.6rem]"
        >
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
                <PersonIcon className="h-4 w-4 text-neutral-500" />
              )}
            </span>
            <span className="truncate text-sm font-medium text-white">@{username}</span>
            <span className="ml-auto shrink-0 text-xs text-neutral-500">
              {postDateFormatter.format(new Date(createdAt))}
            </span>
            <button
              type="button"
              aria-label="Close comments"
              onClick={() => setCommentsOpen(false)}
              className="-m-3.5 shrink-0 p-3.5 text-neutral-400 transition-colors hover:text-white active:text-white"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-3">
            {description && (
              <p className="whitespace-pre-line break-words text-xs leading-relaxed text-neutral-300">
                <span className="font-semibold text-white">@{username} </span>
                {description}
              </p>
            )}

            {commentsError && <p className="text-xs text-red-400">{commentsError}</p>}

            {comments === null && !commentsError && (
              <p className="py-2 text-center text-xs text-neutral-500">Loading…</p>
            )}

            {comments?.length === 0 && (
              <p className="py-2 text-center text-xs text-neutral-500">
                No comments yet — be the first.
              </p>
            )}

            {comments && comments.length > 0 && (
              <ul className="flex flex-col gap-2">
                {comments.map((comment) => (
                  <li key={comment.id} className="flex items-start gap-1.5">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300 ring-1 ring-white/10">
                      {comment.avatarUrl ? (
                        <img
                          src={comment.avatarUrl}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <PersonIcon className="h-4 w-4 text-neutral-500" />
                      )}
                    </span>

                    <div className="min-w-0 flex-1 rounded-2xl bg-neutral-800 px-3 py-1.5">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-xs font-semibold text-white">
                          @{comment.username}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-neutral-500">
                          {commentTimeFormatter.format(new Date(comment.createdAt))}
                        </span>
                      </div>
                      <p className="whitespace-pre-line break-words text-xs leading-relaxed text-neutral-200">
                        {comment.body}
                      </p>
                    </div>

                    {comment.canDelete && (
                      <button
                        type="button"
                        aria-label={`Delete comment by @${comment.username}`}
                        onClick={() => handleDeleteComment(comment)}
                        className="-m-4 mt-0.5 shrink-0 p-4 text-neutral-600 transition-colors hover:text-white active:text-white"
                      >
                        <CloseIcon className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-3 border-t border-white/5 px-4 py-3">
            <div className="relative flex items-center gap-3 text-white">
              <button
                type="button"
                aria-label={liked ? "Unlike" : "Like"}
                aria-pressed={liked}
                onClick={handleToggleLike}
                className={`-m-2 p-2 transition-opacity hover:opacity-70 active:opacity-70 ${
                  liked ? "text-green-500" : ""
                }`}
              >
                <HeartIcon className="h-[1.8rem] w-[1.8rem]" />
              </button>
              {/* Only the post's own author ever gets a like count to click into. */}
              {isOwner && (
                <button
                  ref={likersToggleRef}
                  type="button"
                  onClick={() => setLikersOpen((open) => !open)}
                  className="-m-2 p-2 text-xs text-neutral-400 transition-colors hover:text-white active:text-white"
                >
                  {likeCount} {likeCount === 1 ? "like" : "likes"}
                </button>
              )}

              {likersOpen && (
                <div
                  ref={likersRef}
                  className="absolute bottom-full left-0 z-10 mb-2 w-52 rounded-2xl bg-neutral-800 p-3 shadow-lg"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">Liked by</span>
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={() => setLikersOpen(false)}
                      className="-m-4 p-4 text-neutral-400 transition-colors hover:text-white active:text-white"
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
                    <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto overscroll-contain">
                      {likers.map((liker) => (
                        <li key={liker.id} className="flex items-center gap-2">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
                            {liker.avatarUrl ? (
                              <img
                                src={liker.avatarUrl}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <PersonIcon className="h-4 w-4 text-neutral-500" />
                            )}
                          </span>
                          <span className="truncate text-xs text-white">
                            @{liker.username}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/*
             * `items-stretch`, because the two controls no longer size alike:
             * the coarse-pointer rule in index.css forces the input to 16px to
             * stop iOS zooming on focus, while the button keeps its own size.
             * Stretching makes the shorter one match rather than guessing at
             * paddings that happen to line up on one device.
             */}
            <form onSubmit={handleAddComment} className="flex items-stretch gap-2">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={MAX_COMMENT_LENGTH}
                placeholder="Add a comment"
                aria-label="Add a comment"
                className="min-w-0 flex-1 rounded-full bg-neutral-800 px-4 py-2 text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/60"
              />
              <button
                type="submit"
                disabled={!draft.trim() || sending}
                aria-label="Post comment"
                className={`flex shrink-0 items-center justify-center p-2 transition-opacity active:opacity-70 disabled:opacity-40 ${
                  draft.trim() ? "text-white" : "text-neutral-500"
                }`}
              >
                {sending ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-500/30 border-t-neutral-300" />
                ) : (
                  <SendIcon className="h-4 w-4" />
                )}
              </button>
            </form>
          </div>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
                <PersonIcon className="h-5 w-5 text-neutral-500" />
              )}
            </span>
            <span className="truncate text-sm text-white">@{username}</span>
          </div>

          {description && (
            <div className="whitespace-pre-line break-words rounded-2xl bg-neutral-800 px-4 py-3 text-sm text-neutral-200">
              {description}
            </div>
          )}

          <div className="relative -ml-2 order-1 flex items-center text-white md:order-none md:ml-0 md:gap-3">
            <button
              type="button"
              aria-label={liked ? "Unlike" : "Like"}
              aria-pressed={liked}
              onClick={handleToggleLike}
              className={`p-2 transition-opacity hover:opacity-70 active:opacity-70 md:p-0 ${
                liked ? "text-green-500" : ""
              }`}
            >
              <HeartIcon className="h-[1.8rem] w-[1.8rem]" />
            </button>
            <button
              ref={commentsToggleRef}
              type="button"
              aria-label="Comments"
              aria-expanded={commentsOpen}
              onClick={() => setCommentsOpen(true)}
              className="relative p-2 transition-opacity hover:opacity-70 active:opacity-70 md:p-0"
            >
              <CommentIcon className="h-[1.8rem] w-[1.8rem]" />
              {commentCount > 0 && (
                <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex min-w-4 items-center justify-center rounded-full bg-neutral-950 px-1 text-[10px] font-semibold leading-none text-white md:bottom-0 md:right-0">
                  {commentCount > 99 ? "99+" : commentCount}
                </span>
              )}
            </button>
            {/* Only the post's own author ever gets a like count to click into. */}
            {isOwner && (
              <button
                ref={likersToggleRef}
                type="button"
                onClick={() => setLikersOpen((open) => !open)}
                className="-m-2 p-2 text-xs text-neutral-400 transition-colors hover:text-white active:text-white"
              >
                {likeCount} {likeCount === 1 ? "like" : "likes"}
              </button>
            )}
            <span className="ml-auto text-xs text-neutral-400">
              {postDateFormatter.format(new Date(createdAt))}
            </span>

            {likersOpen && (
              <div
                ref={likersRef}
                className="absolute bottom-full left-0 z-10 mb-2 w-52 rounded-2xl bg-neutral-800 p-3 shadow-lg"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">Liked by</span>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setLikersOpen(false)}
                    className="-m-4 p-4 text-neutral-400 transition-colors hover:text-white active:text-white"
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
                  <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto overscroll-contain">
                    {likers.map((liker) => (
                      <li key={liker.id} className="flex items-center gap-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
                          {liker.avatarUrl ? (
                            <img
                              src={liker.avatarUrl}
                              alt=""
                              loading="lazy"
                              decoding="async"
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
        </>
      )}
    </div>
  );
}

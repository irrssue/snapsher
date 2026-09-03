import { useState } from "react";
import type { PostSummary } from "../types";
import { useBodyScrollLock, useDialogFocus } from "../hooks";
import { deletePost } from "../api/posts";
import { PostInteractions } from "./PostInteractions";
import { CloseIcon } from "./icons";

type PostPreviewModalProps = {
  post: PostSummary;
  username: string;
  avatarUrl: string | null;
  onClose: () => void;
  /**
   * Fires after the server has deleted the post, so the grid it came from can
   * drop it. Omitted where there is nothing to update, which also hides the
   * delete control — a photo that could vanish from the server but not from the
   * screen is worse than one that can't be deleted here at all.
   */
  onDeleted?: (postId: string) => void;
  /** Bubbles a comment add/delete up so the grid's counts can be refetched. */
  onCountsChanged?: () => void;
};

/**
 * A single grid photo, opened from `PostGrid`. Mirrors `PostCard`'s layout —
 * same avatar/description/like-comment column beside the photo — via the
 * `PostInteractions` component they both share, so liking, commenting, and the
 * date all behave exactly as they do on the home feed.
 */
export function PostPreviewModal({
  post,
  username,
  avatarUrl,
  onClose,
  onDeleted,
  onCountsChanged,
}: PostPreviewModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useBodyScrollLock();

  const canDelete = post.isOwner && onDeleted !== undefined;

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePost(post.id);
      onDeleted?.(post.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete that photo.");
    } finally {
      // The success path unmounts this dialog, so the flag only matters on the
      // way out through the catch — but a `finally` is what guarantees the
      // buttons come back for *every* way out.
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 md:px-6 md:py-10"
      onClick={() => {
        if (!deleting) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Photo"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        // Escape is handled on the dialog rather than on `window`. Every modal
        // used to register its own `window` listener, so one keypress ran all
        // of them and dismissed the entire stack at once. `useDialogFocus`
        // puts focus inside this node on open, so the keydown arrives here;
        // `stopPropagation` then keeps a nested dialog's Escape from reaching
        // the dialog wrapped around it — the same scoping the backdrop click
        // above already relies on, so pointer and keyboard finally agree.
        onKeyDown={(e) => {
          if (e.key !== "Escape" || deleting) return;
          e.stopPropagation();
          // The confirmation is the innermost thing on screen while it's up, so
          // Escape backs out of that first rather than closing the whole photo.
          if (confirmingDelete) setConfirmingDelete(false);
          else onClose();
        }}
        className="max-h-full w-full max-w-md overflow-y-auto overscroll-contain rounded-3xl bg-neutral-900 p-5 outline-none md:max-w-3xl md:p-8"
      >
        {confirmingDelete ? (
          /*
           * A confirmation panel rather than a second dialog on top of this
           * one: two stacked `bg-black/80` backdrops composite to ~96% black,
           * which reads as the page having gone out rather than being dimmed.
           */
          <div className="mx-auto flex max-w-sm flex-col gap-4">
            <div>
              <h2 className="text-sm font-medium text-white">Delete this photo?</h2>
              <p className="mt-2 text-xs text-neutral-400">
                This removes the photo along with every like and comment on it, for
                everyone. It can't be undone — and it doesn't give you your 12-hour
                window back, so your next photo is still on the same countdown.
              </p>
            </div>

            {deleteError && <p className="text-center text-xs text-red-400">{deleteError}</p>}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="flex-1 rounded-full bg-neutral-800 py-2.5 text-sm text-white transition-colors hover:bg-neutral-700 active:bg-neutral-700 disabled:opacity-40"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 rounded-full bg-red-500 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-400 active:bg-red-400 disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              {canDelete ? (
                <button
                  type="button"
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmingDelete(true);
                  }}
                  className="-m-2 p-2 text-sm text-red-400 transition-colors hover:text-red-300 active:text-red-300"
                >
                  Delete
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-m-3.5 p-3.5 text-neutral-400 transition-colors hover:text-white active:text-white"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            {deleteError && (
              <p className="mt-2 text-center text-xs text-red-400">{deleteError}</p>
            )}

            <div className="mt-2 flex flex-col gap-3 md:flex-row md:items-center md:justify-center md:gap-10">
              <PostInteractions
                postId={post.id}
                username={username}
                avatarUrl={avatarUrl}
                description={post.description}
                createdAt={post.createdAt}
                likedByMe={post.likedByMe}
                isOwner={post.isOwner}
                likeCount={post.likeCount}
                commentCount={post.commentCount}
                onCountsChanged={onCountsChanged}
              />

              <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-3xl bg-neutral-300 md:aspect-auto md:h-[21.6rem] md:w-[21.6rem] md:shrink-0">
                <img
                  src={post.photoUrl}
                  alt={post.description ?? `Photo shared by @${username}`}
                  className="h-full w-full object-cover"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

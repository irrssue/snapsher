import { useId, useState } from "react";
import type { PostSummary } from "../types";
import { deletePost } from "../api/posts";
import { PostInteractions } from "./PostInteractions";
import { CloseIcon } from "./icons";
import { Button, FieldError, ModalShell } from "./ui";

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
  const headingId = useId();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    <ModalShell
      labelledBy={headingId}
      size="lg"
      dismissible={!deleting}
      onClose={() => {
        // The confirmation is the innermost thing on screen while it's up, so
        // backing out returns to the photo rather than closing it outright.
        if (confirmingDelete) setConfirmingDelete(false);
        else onClose();
      }}
    >
      <>
        {confirmingDelete ? (
          /*
           * A confirmation panel rather than a second dialog on top of this
           * one: two stacked `bg-black/80` backdrops composite to ~96% black,
           * which reads as the page having gone out rather than being dimmed.
           */
          <div className="mx-auto flex max-w-sm flex-col gap-4">
            <div>
              <h2 id={headingId} className="text-base font-medium text-white">
                Delete this photo?
              </h2>
              <p className="mt-2 text-xs text-neutral-400">
                This removes the photo along with every like and comment on it, for
                everyone. It can't be undone — and it doesn't give you your 12-hour
                window back, so your next photo is still on the same countdown.
              </p>
            </div>

            <FieldError message={deleteError} />

            <div className="flex items-center gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                Keep it
              </Button>
              <Button variant="danger" className="flex-1" onClick={handleDelete} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h2 id={headingId} className="sr-only">
                Photo shared by @{username}
              </h2>
              {canDelete ? (
                <button
                  type="button"
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmingDelete(true);
                  }}
                  className="-m-3.5 p-3.5 text-sm text-red-400 transition-colors hover:text-red-300 active:text-red-300"
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

            {deleteError && <FieldError message={deleteError} />}

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

              {/*
               * `object-contain`, unlike the square-cropped grid this opens
               * from. The upload path preserves the photo's aspect ratio, so a
               * portrait shot was stored whole and then displayed as its middle
               * third everywhere — including here, the one surface whose entire
               * job is showing the photo properly. The grid stays cropped for
               * its scanning rhythm; this is where you see what you actually
               * shared.
               */}
              <div className="flex max-h-[60vh] w-full items-center justify-center overflow-hidden rounded-shell bg-field md:h-(--size-photo) md:w-(--size-photo) md:shrink-0">
                <img
                  src={post.photoUrl}
                  alt={post.description ?? `Photo shared by @${username}`}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            </div>
          </>
        )}
      </>
    </ModalShell>
  );
}

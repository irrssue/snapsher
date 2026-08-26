import { useEffect } from "react";
import type { PostSummary } from "../types";
import { useBodyScrollLock, useDialogFocus } from "../hooks";
import { CommentIcon, HeartIcon } from "./icons";

type PostPreviewModalProps = {
  post: PostSummary;
  username: string;
  avatarUrl: string | null;
  onClose: () => void;
};

/**
 * Read-only view of a single grid photo, opened from `PostGrid`. Mirrors
 * `ComposeModal`'s preview layout on purpose — same photo/description
 * arrangement — but nothing here is editable: no file picker, no textarea,
 * and no posting countdown, since a post already shared has no bearing on
 * when the next one can go out.
 */
export function PostPreviewModal({ post, username, avatarUrl, onClose }: PostPreviewModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useBodyScrollLock();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 md:px-6 md:py-10"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Photo"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full w-full max-w-md overflow-y-auto overscroll-contain rounded-3xl bg-neutral-900 p-5 outline-none md:max-w-3xl md:p-8"
      >
        <div className="flex items-start justify-between">
          <p className="text-xs uppercase tracking-widest text-neutral-400">Preview</p>
          <button
            type="button"
            onClick={onClose}
            className="-m-2 p-2 text-sm text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            Close
          </button>
        </div>

        <div className="mt-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-center md:gap-10">
          <div className="contents md:flex md:w-64 md:flex-col md:gap-3">
            <div className="flex items-center gap-2">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-300" />
              )}
              <span className="text-sm text-white">@{username}</span>
            </div>

            {post.description && (
              <p className="w-full whitespace-pre-line break-words rounded-2xl bg-neutral-800 px-4 py-3 text-sm text-neutral-200">
                {post.description}
              </p>
            )}

            <div className="order-1 flex items-center gap-3 text-white opacity-60 md:order-none">
              <HeartIcon className="h-6 w-6" />
              <CommentIcon className="h-6 w-6" />
            </div>
          </div>

          <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-3xl bg-neutral-300 md:aspect-auto md:h-[21.6rem] md:w-[21.6rem] md:shrink-0">
            <img src={post.photoUrl} alt="" className="h-full w-full object-cover" />
          </div>
        </div>
      </div>
    </div>
  );
}

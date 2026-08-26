import { useEffect } from "react";
import type { PostSummary } from "../types";
import { useBodyScrollLock, useDialogFocus } from "../hooks";
import { PostInteractions } from "./PostInteractions";
import { CloseIcon } from "./icons";

type PostPreviewModalProps = {
  post: PostSummary;
  username: string;
  avatarUrl: string | null;
  onClose: () => void;
};

/**
 * A single grid photo, opened from `PostGrid`. Mirrors `PostCard`'s layout —
 * same avatar/description/like-comment column beside the photo — via the
 * `PostInteractions` component they both share, so liking, commenting, and the
 * date all behave exactly as they do on the home feed.
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
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-2 p-2 text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

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
          />

          <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-3xl bg-neutral-300 md:aspect-auto md:h-[21.6rem] md:w-[21.6rem] md:shrink-0">
            <img src={post.photoUrl} alt="" className="h-full w-full object-cover" />
          </div>
        </div>
      </div>
    </div>
  );
}

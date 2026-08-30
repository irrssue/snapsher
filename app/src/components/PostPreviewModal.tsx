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
        // Escape is handled on the dialog rather than on `window`. Every modal
        // used to register its own `window` listener, so one keypress ran all
        // of them and dismissed the entire stack at once. `useDialogFocus`
        // puts focus inside this node on open, so the keydown arrives here;
        // `stopPropagation` then keeps a nested dialog's Escape from reaching
        // the dialog wrapped around it — the same scoping the backdrop click
        // above already relies on, so pointer and keyboard finally agree.
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onClose();
        }}
        className="max-h-full w-full max-w-md overflow-y-auto overscroll-contain rounded-3xl bg-neutral-900 p-5 outline-none md:max-w-3xl md:p-8"
      >
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-3.5 p-3.5 text-neutral-400 transition-colors hover:text-white active:text-white"
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
            <img
              src={post.photoUrl}
              alt={post.description ?? `Photo shared by @${username}`}
              className="h-full w-full object-cover"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

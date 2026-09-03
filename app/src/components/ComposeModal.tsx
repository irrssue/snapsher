import { useRef, useState } from "react";
import { readPhotoAsDataUrl } from "../api/posts";
import { ImageRejected } from "../images";
import { useBodyScrollLock, useDialogFocus } from "../hooks";
import { formatRemaining, useNow } from "../time";
import { CommentIcon, HeartIcon, PlusIcon } from "./icons";

const MAX_DESCRIPTION_LENGTH = 300;

type ComposeModalProps = {
  username: string;
  avatarUrl: string | null;
  /**
   * `undefined` while the quota is still loading, `null` once reading it
   * failed. Both mean "not yet", but only one of them is worth an error line.
   */
  nextAllowedAt: number | null | undefined;
  /**
   * Added to the local clock so the window is judged in the server's time. The
   * server rejects the post on its own clock regardless, so a device running
   * fast would otherwise enable Share early and collect a 429.
   */
  clockOffset: number;
  onClose: () => void;
  onShare: (input: { photo: string; description: string }) => Promise<void>;
};

export function ComposeModal({
  username,
  avatarUrl,
  nextAllowedAt,
  clockOffset,
  onClose,
  onShare,
}: ComposeModalProps) {
  const now = useNow() + clockOffset;
  const canPost = typeof nextAllowedAt === "number" && now >= nextAllowedAt;
  const [photo, setPhoto] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  /** Raised by Escape or Cancel while there is a draft worth losing. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useBodyScrollLock();

  const hasDraft = photo !== null || description.trim() !== "";

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice still fires a change event.
    e.target.value = "";
    if (!file) return;

    setError(null);
    try {
      setPhoto(await readPhotoAsDataUrl(file));
    } catch (err) {
      // `ImageRejected` says exactly which rule the file broke — wrong type,
      // too many bytes, too many pixels — and that is the difference between
      // "try a different one" and knowing what to try instead.
      setError(
        err instanceof ImageRejected ? err.message : "Couldn't read that photo. Try a different one.",
      );
    }
  }

  async function handleShare() {
    if (!photo || sharing) return;
    setError(null);
    setSharing(true);
    try {
      await onShare({ photo, description: description.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      // In `finally`, not just the catch: on the success path this modal is
      // already unmounted so the flag is moot, and anything that throws
      // *outside* the catch's reach would otherwise leave Share disabled and
      // reading "Sharing…" with no request in flight.
      setSharing(false);
    }
  }

  /**
   * Escape and Cancel used to throw a picked photo away outright, while a
   * backdrop click deliberately refused to — and Escape is the reflexive
   * desktop exit, so the reflex was the one that lost work. Both now ask, and
   * the backdrop keeps ignoring the click, so no route out is silently
   * destructive.
   */
  function requestClose() {
    if (sharing) return;
    if (hasDraft) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 md:px-6 md:py-10"
      // A stray backdrop click shouldn't throw away a photo already picked —
      // those drafts have to be dismissed deliberately with Cancel.
      onClick={() => {
        if (!hasDraft && !sharing) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Share a photo"
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
          if (e.key !== "Escape" || sharing) return;
          e.stopPropagation();
          // Escape dismisses the innermost thing on screen: the confirmation
          // first, the modal only once there is nothing left to confirm.
          if (confirmingDiscard) setConfirmingDiscard(false);
          else requestClose();
        }}
        className="max-h-full w-full max-w-md overflow-y-auto overscroll-contain rounded-3xl bg-neutral-900 p-5 outline-none md:max-w-3xl md:p-8"
      >
        <div className="flex items-start justify-between">
          <p className="text-xs uppercase tracking-widest text-neutral-400">
            Preview
          </p>
          <button
            type="button"
            onClick={requestClose}
            disabled={sharing}
            className="-m-2 p-2 text-sm text-neutral-400 transition-colors hover:text-white active:text-white disabled:opacity-40"
          >
            Cancel
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

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={MAX_DESCRIPTION_LENGTH}
              rows={3}
              placeholder="Enter a description here"
              className="w-full resize-none rounded-2xl bg-neutral-800 px-4 py-3 text-sm text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60"
            />

            <div className="order-1 flex items-center gap-3 text-white opacity-60 md:order-none">
              <HeartIcon className="h-6 w-6" />
              <CommentIcon className="h-6 w-6" />
            </div>
          </div>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label={photo ? "Change photo" : "Choose a photo"}
            className="group flex aspect-square w-full items-center justify-center overflow-hidden rounded-3xl bg-neutral-300 md:aspect-auto md:h-[21.6rem] md:w-[21.6rem] md:shrink-0"
          >
            {photo ? (
              <img
                src={photo}
                alt="Photo to share"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black transition-transform group-hover:scale-105 group-active:scale-95">
                <PlusIcon className="h-5 w-5" />
              </span>
            )}
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />

        <div className="mt-8 flex flex-col items-center gap-3">
          {error && <p className="text-center text-xs text-red-400">{error}</p>}

          {confirmingDiscard ? (
            <>
              <p className="text-center text-xs text-neutral-400">
                Discard this photo? It won't be shared, and your 12-hour window stays
                untouched.
              </p>
              <div className="flex w-full max-w-56 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmingDiscard(false)}
                  className="flex-1 rounded-full bg-neutral-800 py-2.5 text-sm text-white transition-colors hover:bg-neutral-700 active:bg-neutral-700"
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-full bg-red-500 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-400 active:bg-red-400"
                >
                  Discard
                </button>
              </div>
            </>
          ) : (
            <>
              {nextAllowedAt === undefined ? (
                <p className="text-center text-xs text-neutral-500">
                  Checking your posting window…
                </p>
              ) : nextAllowedAt === null ? (
                <p className="text-center text-xs text-neutral-400">
                  Couldn't check your posting window. Refresh and try again.
                </p>
              ) : (
                !canPost && (
                  <p className="text-center text-xs text-neutral-400">
                    You've already shared a photo. Next one in{" "}
                    <span className="font-mono text-neutral-200">
                      {formatRemaining(nextAllowedAt - now)}
                    </span>
                    .
                  </p>
                )
              )}

              <button
                type="button"
                onClick={handleShare}
                disabled={!photo || !canPost || sharing}
                className="w-full max-w-56 rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 active:opacity-70 disabled:opacity-40"
              >
                {sharing ? "Sharing…" : "Share photo"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

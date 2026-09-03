import { useId, useRef, useState } from "react";
import { readPhotoAsDataUrl } from "../api/posts";
import { ImageRejected } from "../images";
import { formatRemaining, useNow } from "../time";
import { CommentIcon, HeartIcon, PlusIcon } from "./icons";
import { Avatar, Button, FieldError, ModalShell } from "./ui";

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
  // Stops ticking once the window is open: there is nothing left to count down
  // to, and the modal would otherwise re-render every second for a static
  // screen for as long as it stayed open.
  const now =
    useNow(1000, typeof nextAllowedAt === "number" ? nextAllowedAt - clockOffset : null) +
    clockOffset;
  const canPost = typeof nextAllowedAt === "number" && now >= nextAllowedAt;
  const [photo, setPhoto] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  /** Raised by Escape or Cancel while there is a draft worth losing. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const errorId = useId();

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
    <ModalShell
      labelledBy={headingId}
      size="lg"
      dismissible={!sharing}
      // A backdrop click with a photo already picked used to do nothing at all —
      // no shake, no hint, no message — so a learned gesture silently failed and
      // people tapped harder. It now raises the same discard confirmation that
      // Escape and Cancel do: still not destructive, but no longer silent.
      onClose={() => {
        if (confirmingDiscard) setConfirmingDiscard(false);
        else requestClose();
      }}
    >
      <>
        <div className="flex items-start justify-between">
          <h2 id={headingId} className="text-xs uppercase tracking-widest text-neutral-400">
            Preview
          </h2>
          <button
            type="button"
            onClick={requestClose}
            disabled={sharing}
            className="-m-3.5 p-3.5 text-sm text-neutral-400 transition-colors hover:text-white active:text-white disabled:text-neutral-600"
          >
            Cancel
          </button>
        </div>

        <div className="mt-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-center md:gap-10">
          <div className="contents md:flex md:w-64 md:flex-col md:gap-3">
            <div className="flex items-center gap-2">
              {/* Was the one avatar in the app with no person glyph at all — a
                  bare grey disc, so the preview didn't match the post. */}
              <Avatar url={avatarUrl} size="md" />
              <span className="truncate text-sm text-white">@{username}</span>
            </div>

            <div className="flex flex-col gap-1">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={MAX_DESCRIPTION_LENGTH}
                rows={3}
                placeholder="Enter a description here"
                aria-label="Photo description"
                dir="auto"
                className="w-full resize-none rounded-control bg-field px-4 py-3 text-sm text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60"
              />
              {/* `maxLength` simply stops accepting keystrokes, which mid-sentence
                  reads as a broken keyboard. Appears only near the limit so it
                  isn't a counter hanging over an empty box. */}
              {description.length > MAX_DESCRIPTION_LENGTH * 0.8 && (
                <span className="self-end text-xs text-neutral-400" aria-live="polite">
                  {MAX_DESCRIPTION_LENGTH - description.length} left
                </span>
              )}
            </div>

            <div className="order-1 flex items-center gap-3 text-white opacity-60 md:order-none">
              <HeartIcon className="h-6 w-6" />
              <CommentIcon className="h-6 w-6" />
            </div>
          </div>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label={photo ? "Change photo" : "Choose a photo"}
            className="group flex aspect-square w-full items-center justify-center overflow-hidden rounded-shell bg-field md:aspect-auto md:h-(--size-photo) md:w-(--size-photo) md:shrink-0"
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
          <FieldError id={errorId} message={error} />

          {confirmingDiscard ? (
            <>
              <p className="text-center text-xs text-neutral-400">
                Discard this photo? It won't be shared, and your 12-hour window stays
                untouched.
              </p>
              <div className="flex w-full max-w-56 items-center gap-3">
                <Button variant="secondary" className="flex-1" onClick={() => setConfirmingDiscard(false)}>
                  Keep editing
                </Button>
                <Button variant="danger" className="flex-1" onClick={onClose}>
                  Discard
                </Button>
              </div>
            </>
          ) : (
            <>
              {nextAllowedAt === undefined ? (
                <p className="text-center text-xs text-neutral-400" role="status">
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

              <Button
                className="w-full max-w-56"
                onClick={handleShare}
                disabled={!photo || !canPost || sharing}
              >
                {sharing ? "Sharing…" : "Share photo"}
              </Button>
            </>
          )}
        </div>
      </>
    </ModalShell>
  );
}

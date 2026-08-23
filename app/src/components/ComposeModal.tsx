import { useEffect, useRef, useState } from "react";
import { readPhotoAsDataUrl } from "../api/posts";
import { formatRemaining, useNow } from "../time";
import { CommentIcon, HeartIcon, PlusIcon } from "./icons";

const MAX_DESCRIPTION_LENGTH = 300;

type ComposeModalProps = {
  username: string;
  nextAllowedAt: number;
  onClose: () => void;
  onShare: (input: { photo: string; description: string }) => Promise<void>;
};

export function ComposeModal({
  username,
  nextAllowedAt,
  onClose,
  onShare,
}: ComposeModalProps) {
  const now = useNow();
  const canPost = now >= nextAllowedAt;
  const [photo, setPhoto] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasDraft = photo !== null || description.trim() !== "";

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !sharing) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, sharing]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice still fires a change event.
    e.target.value = "";
    if (!file) return;

    setError(null);
    try {
      setPhoto(await readPhotoAsDataUrl(file));
    } catch {
      setError("Couldn't read that photo. Try a different one.");
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
      setSharing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-6 py-10"
      // A stray backdrop click shouldn't throw away a photo already picked —
      // those drafts have to be dismissed deliberately with Cancel.
      onClick={() => {
        if (!hasDraft && !sharing) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share a photo"
        onClick={(e) => e.stopPropagation()}
        className="max-h-full w-full max-w-3xl overflow-y-auto rounded-3xl bg-neutral-900 p-8"
      >
        <div className="flex items-start justify-between">
          <p className="text-xs uppercase tracking-widest text-neutral-500">
            Preview
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={sharing}
            aria-label="Close"
            className="text-sm text-neutral-400 transition-colors hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
        </div>

        <div className="mt-6 flex flex-col items-center gap-10 md:flex-row md:items-center md:justify-center">
          <div className="order-2 flex w-64 flex-col gap-3 md:order-1">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-300" />
              <span className="text-sm text-white">@{username}</span>
            </div>

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={MAX_DESCRIPTION_LENGTH}
              rows={3}
              placeholder="Enter a description here"
              className="resize-none rounded-2xl bg-neutral-800 px-4 py-3 text-sm text-neutral-200 placeholder-neutral-400 outline-none"
            />

            <div className="flex items-center gap-3 text-white opacity-60">
              <HeartIcon className="h-6 w-6" />
              <CommentIcon className="h-6 w-6" />
            </div>
          </div>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label={photo ? "Change photo" : "Choose a photo"}
            className="group order-1 flex h-[19.2rem] w-[19.2rem] shrink-0 items-center justify-center overflow-hidden rounded-3xl bg-neutral-300 md:order-2 md:h-[21.6rem] md:w-[21.6rem]"
          >
            {photo ? (
              <img
                src={photo}
                alt="Photo to share"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-black transition-transform group-hover:scale-105">
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

          {!canPost && (
            <p className="text-center text-xs text-neutral-400">
              You've already shared a photo. Next one in{" "}
              <span className="font-mono text-neutral-200">
                {formatRemaining(nextAllowedAt - now)}
              </span>
              .
            </p>
          )}

          <button
            type="button"
            onClick={handleShare}
            disabled={!photo || !canPost || sharing}
            className="w-56 rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {sharing ? "Sharing…" : "Share photo"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { CloseIcon, PersonIcon } from "./icons";
import { useBodyScrollLock, useDialogFocus } from "../hooks";
import { fetchUserProfile, type PublicProfile } from "../api/friends";

type PublicProfileModalProps = {
  userId: number;
  onClose: () => void;
};

/**
 * Any other user's profile, as seen by someone who isn't its owner: avatar,
 * username, and post count only. No friends count here on purpose — per
 * `about.md`, that number is only ever shown to the account owner themself.
 */
export function PublicProfileModal({ userId, onClose }: PublicProfileModalProps) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useBodyScrollLock();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    setProfile(null);
    setError(null);
    fetchUserProfile(userId)
      .then((next) => {
        if (active) setProfile(next);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Couldn't load that profile.");
      });
    return () => {
      active = false;
    };
  }, [userId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Profile"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-sm flex-col rounded-3xl bg-neutral-900 p-5 outline-none"
      >
        <div className="flex shrink-0 items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-2 p-2 text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-4 px-4 pb-4">
          {error ? (
            <p className="py-8 text-center text-sm text-red-400">{error}</p>
          ) : !profile ? (
            <div className="h-24 w-24 shrink-0 animate-pulse rounded-full bg-neutral-800" />
          ) : (
            <>
              <span className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
                {profile.avatarUrl ? (
                  <img
                    src={profile.avatarUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <PersonIcon className="h-14 w-14 text-neutral-500" />
                )}
              </span>

              <span className="text-white">@{profile.username}</span>

              <span className="text-sm text-neutral-300">{profile.postCount} posts</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

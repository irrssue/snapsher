import { useId } from "react";
import { CloseIcon } from "./icons";
import { FieldError, ModalShell } from "./ui";

type SettingsModalProps = {
  onClose: () => void;
  onEditPhoto: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
  onDeleteAccount: () => void;
  /**
   * Logging out can now fail — the local state is only cleared once the server
   * confirms the session is gone — and this dialog is what's on screen when it
   * does, so the message belongs here rather than behind the backdrop.
   */
  error?: string | null;
  loggingOut?: boolean;
};

/**
 * Opened from the gear badge on the profile avatar. Log out sits directly
 * above Delete account on purpose — the destructive action is last, not
 * first, so it isn't the thing a thumb lands on by reflex.
 */
export function SettingsModal({
  onClose,
  onEditPhoto,
  onChangePassword,
  onLogout,
  onDeleteAccount,
  error,
  loggingOut,
}: SettingsModalProps) {
  const headingId = useId();

  return (
    <ModalShell labelledBy={headingId} dismissible={!loggingOut} onClose={onClose}>
      <div className="flex flex-col">
        <div className="flex items-center justify-between">
          <h2 id={headingId} className="text-base font-medium text-white">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={loggingOut}
            aria-label="Close"
            className="-m-3.5 p-3.5 text-neutral-400 transition-colors hover:text-white active:text-white disabled:text-neutral-600"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mt-4">
            <FieldError message={error} />
          </div>
        )}

        <div className="mt-4 flex flex-col gap-1">
          <button
            type="button"
            onClick={onEditPhoto}
            disabled={loggingOut}
            className="min-h-11 rounded-control px-3 py-3 text-left text-sm text-white transition-colors hover:bg-field active:bg-field disabled:text-neutral-500"
          >
            Edit profile picture
          </button>

          <button
            type="button"
            onClick={onChangePassword}
            disabled={loggingOut}
            className="min-h-11 rounded-control px-3 py-3 text-left text-sm text-white transition-colors hover:bg-field active:bg-field disabled:text-neutral-500"
          >
            Change password
          </button>

          <div className="my-2 h-px bg-field" />

          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            className="min-h-11 rounded-control px-3 py-3 text-left text-sm text-white transition-colors hover:bg-field active:bg-field disabled:text-neutral-500"
          >
            {loggingOut ? "Logging out…" : "Log out"}
          </button>

          <button
            type="button"
            onClick={onDeleteAccount}
            disabled={loggingOut}
            className="min-h-11 rounded-control px-3 py-3 text-left text-sm text-red-400 transition-colors hover:bg-field active:bg-field disabled:text-neutral-500"
          >
            Delete account
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

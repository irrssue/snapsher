import { CloseIcon } from "./icons";
import { useBodyScrollLock, useDialogFocus } from "../hooks";

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
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useBodyScrollLock();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 md:px-6 md:py-10"
      onClick={() => {
        if (!loggingOut) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
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
          if (e.key !== "Escape" || loggingOut) return;
          e.stopPropagation();
          onClose();
        }}
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-3xl bg-neutral-900 p-5 outline-none"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-white">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={loggingOut}
            aria-label="Close"
            className="-m-3.5 p-3.5 text-neutral-400 transition-colors hover:text-white active:text-white disabled:opacity-40"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="mt-4 text-center text-xs text-red-400">{error}</p>}

        <div className="mt-4 flex flex-col gap-1">
          <button
            type="button"
            onClick={onEditPhoto}
            disabled={loggingOut}
            className="rounded-2xl px-3 py-3 text-left text-sm text-white transition-colors hover:bg-neutral-800 active:bg-neutral-800 disabled:opacity-40"
          >
            Edit profile picture
          </button>

          <button
            type="button"
            onClick={onChangePassword}
            disabled={loggingOut}
            className="rounded-2xl px-3 py-3 text-left text-sm text-white transition-colors hover:bg-neutral-800 active:bg-neutral-800 disabled:opacity-40"
          >
            Change password
          </button>

          <div className="my-2 h-px bg-neutral-800" />

          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            className="rounded-2xl px-3 py-3 text-left text-sm text-white transition-colors hover:bg-neutral-800 active:bg-neutral-800 disabled:opacity-40"
          >
            {loggingOut ? "Logging out…" : "Log out"}
          </button>

          <button
            type="button"
            onClick={onDeleteAccount}
            disabled={loggingOut}
            className="rounded-2xl px-3 py-3 text-left text-sm text-red-400 transition-colors hover:bg-neutral-800 active:bg-neutral-800 disabled:opacity-40"
          >
            Delete account
          </button>
        </div>
      </div>
    </div>
  );
}

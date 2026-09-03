import { useState } from "react";
import { changePassword } from "../api/auth";
import { useBodyScrollLock, useDialogFocus } from "../hooks";

type ChangePasswordModalProps = {
  onCancel: () => void;
  /** Fires once the change succeeded, so the caller can close and confirm it. */
  onChanged: () => void;
};

/**
 * Opened from Settings. Asks for the current password as well as the new one:
 * the point of the screen is that it also signs every *other* device out, and
 * an unlocked tab left on a desk shouldn't be able to do that on its own.
 */
export function ChangePasswordModal({ onCancel, onChanged }: ChangePasswordModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useBodyScrollLock();

  const filledIn = currentPassword !== "" && newPassword !== "" && confirmPassword !== "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!filledIn || submitting) return;
    // Caught here rather than on the server, which never sees this field: the
    // whole point of a confirmation box is that a typo can't become the only
    // password to an account whose recovery is an emailed code.
    if (newPassword !== confirmPassword) {
      setError("Those two passwords don't match.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await changePassword({ currentPassword, newPassword });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change your password.");
    } finally {
      // Not just in the catch: `onChanged` unmounts this dialog on the success
      // path, so the flag is moot there, and a throw from anywhere else would
      // otherwise leave the form disabled with no way back.
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 md:px-6 md:py-10"
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Change password"
        tabIndex={-1}
        // Escape is handled on the dialog rather than on `window`. Every modal
        // used to register its own `window` listener, so one keypress ran all
        // of them and dismissed the entire stack at once. `useDialogFocus`
        // puts focus inside this node on open, so the keydown arrives here;
        // `stopPropagation` then keeps a nested dialog's Escape from reaching
        // the dialog wrapped around it — the same scoping the backdrop click
        // above already relies on, so pointer and keyboard finally agree.
        onKeyDown={(e) => {
          if (e.key !== "Escape" || submitting) return;
          e.stopPropagation();
          onCancel();
        }}
        className="flex w-full max-w-sm flex-col gap-4 rounded-3xl bg-neutral-900 p-5 outline-none"
      >
        <div>
          <h2 className="text-sm font-medium text-white">Change password</h2>
          <p className="mt-2 text-xs text-neutral-400">
            You'll stay signed in here. Every other device you're signed in on gets
            signed out.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Current password"
            aria-label="Current password"
            disabled={submitting}
            className="w-full rounded-full bg-neutral-800 px-4 py-2.5 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60 disabled:opacity-40"
          />
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="New password"
            aria-label="New password"
            // Mirrors the server's minimum so the rule is felt while typing
            // rather than reported after a round trip.
            minLength={8}
            disabled={submitting}
            className="w-full rounded-full bg-neutral-800 px-4 py-2.5 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60 disabled:opacity-40"
          />
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password"
            aria-label="Confirm new password"
            minLength={8}
            disabled={submitting}
            className="w-full rounded-full bg-neutral-800 px-4 py-2.5 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60 disabled:opacity-40"
          />

          {error && <p className="text-center text-xs text-red-400">{error}</p>}

          <div className="mt-1 flex items-center gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="flex-1 rounded-full bg-neutral-800 py-2.5 text-sm text-white transition-colors hover:bg-neutral-700 active:bg-neutral-700 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!filledIn || submitting}
              className="flex-1 rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 active:opacity-70 disabled:opacity-40"
            >
              {submitting ? "Saving…" : "Change"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

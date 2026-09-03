import { useId, useState } from "react";
import { changePassword } from "../api/auth";
import { Button, FieldError, ModalShell } from "./ui";

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
  const headingId = useId();
  const errorId = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
    <ModalShell labelledBy={headingId} dismissible={!submitting} onClose={onCancel}>
      <div className="flex flex-col gap-4">
        <div>
          <h2 id={headingId} className="text-base font-medium text-white">
            Change password
          </h2>
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
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={submitting}
            className="min-h-11 w-full rounded-full bg-field px-4 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60 disabled:text-neutral-500"
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
            className="min-h-11 w-full rounded-full bg-field px-4 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60 disabled:text-neutral-500"
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
            className="min-h-11 w-full rounded-full bg-field px-4 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60 disabled:text-neutral-500"
          />

          <FieldError id={errorId} message={error} />

          <div className="mt-1 flex items-center gap-3">
            <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={!filledIn || submitting}>
              {submitting ? "Saving…" : "Change"}
            </Button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
}

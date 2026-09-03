import { useId, useState } from "react";
import { Button, FieldError, ModalShell } from "./ui";

type DeleteAccountModalProps = {
  onCancel: () => void;
  onConfirm: (password: string) => Promise<void>;
};

/**
 * Requires typing the password again rather than a plain "are you sure" —
 * this is the one action in the app that can't be undone, so it asks for
 * something a hijacked-but-unlocked tab wouldn't have.
 */
export function DeleteAccountModal({ onCancel, onConfirm }: DeleteAccountModalProps) {
  const headingId = useId();
  const errorId = useId();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete your account.");
    } finally {
      // In `finally`, not just the catch: the success path unmounts this dialog
      // so the flag is moot there, while anything that throws outside the
      // catch's reach would otherwise leave the form disabled and reading
      // "Deleting…" forever.
      setSubmitting(false);
    }
  }

  return (
    <ModalShell labelledBy={headingId} dismissible={!submitting} onClose={onCancel}>
      <div className="flex flex-col gap-4">
        <div>
          <h2 id={headingId} className="text-base font-medium text-white">
            Delete account
          </h2>
          <p className="mt-2 text-xs text-neutral-400">
            This permanently deletes your profile, posts, and photos. This can't be undone.
            Enter your password to confirm.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={submitting}
            className="min-h-11 w-full rounded-full bg-field px-4 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60 disabled:text-neutral-500"
          />

          <FieldError id={errorId} message={error} />

          <div className="mt-1 flex items-center gap-3">
            <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="danger" type="submit" className="flex-1" disabled={!password || submitting}>
              {submitting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
}

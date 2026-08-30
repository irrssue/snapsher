import { useState } from "react";
import { useBodyScrollLock, useDialogFocus } from "../hooks";

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
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useBodyScrollLock();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete your account.");
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
        aria-label="Delete account"
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
          <h2 className="text-sm font-medium text-white">Delete account</h2>
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
              disabled={!password || submitting}
              className="flex-1 rounded-full bg-red-500 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-400 active:bg-red-400 disabled:opacity-40"
            >
              {submitting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";

export type AuthStep = "credentials" | "username" | "code" | "forgot" | "reset";

export type AuthCredentialsData = {
  email: string;
  password: string;
};

type AuthPageProps = {
  step: AuthStep;
  email?: string;
  onSubmitCredentials: (data: AuthCredentialsData) => void;
  onSubmitUsername: (username: string) => void;
  onSubmitCode: (code: string) => void;
  onResendCode: () => void;
  /** Moves to the "what's your address" step of a password reset. */
  onForgotPassword: () => void;
  onRequestPasswordReset: (email: string) => void;
  onResetPassword: (input: { code: string; newPassword: string }) => void;
  onBack: () => void;
  error?: string | null;
  /**
   * A non-failure message shown in the same place as `error` — "we've sent a
   * code", "your password was changed". Kept separate so the two can't be
   * confused for each other by colour alone.
   */
  notice?: string | null;
  submitting?: boolean;
  /**
   * Absolute timestamp — not a duration — for when the resend button
   * re-enables. An absolute value survives re-renders without a duration
   * silently resetting the countdown on every keystroke in the code field.
   */
  resendAt?: number | null;
  /** True only while a resend request is in flight — independent of `submitting`, which belongs to the form's own submit button. */
  resendSubmitting?: boolean;
};

function AuthInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-full bg-neutral-800 px-4 py-2.5 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60"
    />
  );
}

/** Ticks down to `0` once `resendAt` passes, re-arming the resend button. */
function useCountdownSeconds(resendAt: number | null | undefined): number {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    resendAt ? Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)) : 0,
  );

  useEffect(() => {
    if (!resendAt) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [resendAt]);

  return secondsLeft;
}

export function AuthPage({
  step,
  email,
  onSubmitCredentials,
  onSubmitUsername,
  onSubmitCode,
  onResendCode,
  onForgotPassword,
  onRequestPasswordReset,
  onResetPassword,
  onBack,
  error,
  notice,
  submitting,
  resendAt,
  resendSubmitting,
}: AuthPageProps) {
  const resendSecondsLeft = useCountdownSeconds(resendAt);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0c1014] px-6">
      {step === "credentials" ? (
        <form
          key="credentials"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            onSubmitCredentials({
              email: String(formData.get("email") ?? ""),
              password: String(formData.get("password") ?? ""),
            });
          }}
          className="flex w-full max-w-xs flex-col items-center gap-3"
        >
          <AuthInput
            type="email"
            name="email"
            placeholder="Email"
            aria-label="Email"
            autoComplete="email"
            defaultValue={email}
            required
          />
          <AuthInput
            type="password"
            name="password"
            placeholder="Password"
            aria-label="Password"
            autoComplete="current-password"
            required
            // Mirrors the server's minimum. Signing in to an existing account
            // never trips it, since no account can have a shorter password;
            // what it catches is the sign-up path, where the rule would
            // otherwise only be reported one screen later, on a form that has
            // no password field to correct.
            minLength={8}
          />

          {error && <p className="text-center text-xs text-red-400">{error}</p>}
          {notice && <p className="text-center text-xs text-neutral-300">{notice}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 w-full rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 active:opacity-70 disabled:opacity-40"
          >
            {submitting ? "Please wait…" : "Continue"}
          </button>
          <button
            type="button"
            onClick={onForgotPassword}
            className="-m-2 p-2 text-xs text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            Forgot password?
          </button>
        </form>
      ) : step === "username" ? (
        <form
          key="username"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            onSubmitUsername(String(formData.get("username") ?? ""));
          }}
          className="flex w-full max-w-xs flex-col items-center gap-3"
        >
          <p className="break-words text-center text-xs text-neutral-400">
            No account found for <span className="text-white">{email}</span>. Pick a
            username to finish creating one.
          </p>
          <AuthInput
            type="text"
            name="username"
            placeholder="username"
            aria-label="Username"
            autoComplete="username"
            // iOS defaults a text field to sentence case with autocorrect on, so
            // "zaw" was being stored as "Zaw" — permanently, since nothing in
            // the app can rename an account afterwards.
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            required
            minLength={3}
            maxLength={20}
          />

          {error && <p className="text-center text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 w-full rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 active:opacity-70 disabled:opacity-40"
          >
            {submitting ? "Please wait…" : "Sign up"}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="-m-2 p-2 text-xs text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            ← Use a different email
          </button>
        </form>
      ) : step === "code" ? (
        <form
          key="code"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            onSubmitCode(String(formData.get("code") ?? ""));
          }}
          className="flex w-full max-w-xs flex-col items-center gap-3"
        >
          <p className="break-words text-center text-xs text-neutral-400">
            Enter the 6-digit code we sent to <span className="text-white">{email}</span>.
          </p>
          <AuthInput
            type="text"
            name="code"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="6-digit code"
            aria-label="Verification code"
            // What makes iOS/Android offer the code straight from the
            // notification banner — six separate boxes would defeat this.
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            required
            // Mirrors the server's `CODE_RE` in auth.ts. The code is six
            // digits, not four, because the attempt caps that bound guessing it
            // are reset by restarting sign-up — the size of the code space is
            // what actually holds.
            minLength={6}
            maxLength={6}
          />

          {error && <p className="text-center text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 w-full rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 active:opacity-70 disabled:opacity-40"
          >
            {submitting ? "Please wait…" : "Verify"}
          </button>
          <button
            type="button"
            onClick={onResendCode}
            disabled={resendSecondsLeft > 0 || resendSubmitting}
            className="-m-2 p-2 text-xs text-neutral-400 transition-colors hover:text-white active:text-white disabled:opacity-40"
          >
            {resendSecondsLeft > 0 ? `Resend code in ${resendSecondsLeft}s` : "Resend code"}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="-m-2 p-2 text-xs text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            ← Start over
          </button>
        </form>
      ) : step === "forgot" ? (
        <form
          key="forgot"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            onRequestPasswordReset(String(formData.get("email") ?? ""));
          }}
          className="flex w-full max-w-xs flex-col items-center gap-3"
        >
          <p className="break-words text-center text-xs text-neutral-400">
            Enter your email and we'll send a 6-digit code to reset your password.
          </p>
          <AuthInput
            type="email"
            name="email"
            placeholder="Email"
            aria-label="Email"
            autoComplete="email"
            defaultValue={email}
            required
          />

          {error && <p className="text-center text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 w-full rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 active:opacity-70 disabled:opacity-40"
          >
            {submitting ? "Please wait…" : "Send code"}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="-m-2 p-2 text-xs text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            ← Back to sign in
          </button>
        </form>
      ) : (
        <form
          key="reset"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            onResetPassword({
              code: String(formData.get("code") ?? ""),
              newPassword: String(formData.get("newPassword") ?? ""),
            });
          }}
          className="flex w-full max-w-xs flex-col items-center gap-3"
        >
          {/*
           * "If that address has an account" is not padding: the server answers
           * identically whether or not it does, precisely so this screen can't
           * be used to find out who is a member. Saying "we've sent you a code"
           * would give away what the API deliberately withholds.
           */}
          <p className="break-words text-center text-xs text-neutral-400">
            If <span className="text-white">{email}</span> has an account, a 6-digit code
            is on its way. Enter it below with your new password.
          </p>
          <AuthInput
            type="text"
            name="code"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="6-digit code"
            aria-label="Reset code"
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            minLength={6}
            maxLength={6}
          />
          <AuthInput
            type="password"
            name="newPassword"
            placeholder="New password"
            aria-label="New password"
            autoComplete="new-password"
            enterKeyHint="go"
            required
            minLength={8}
          />

          {error && <p className="text-center text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 w-full rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 active:opacity-70 disabled:opacity-40"
          >
            {submitting ? "Please wait…" : "Reset password"}
          </button>
          <button
            type="button"
            onClick={onForgotPassword}
            className="-m-2 p-2 text-xs text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            Send another code
          </button>
          <button
            type="button"
            onClick={onBack}
            className="-m-2 p-2 text-xs text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            ← Back to sign in
          </button>
        </form>
      )}
    </div>
  );
}

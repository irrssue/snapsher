export type AuthStep = "credentials" | "username";

export type AuthCredentialsData = {
  email: string;
  password: string;
};

type AuthPageProps = {
  step: AuthStep;
  email?: string;
  onSubmitCredentials: (data: AuthCredentialsData) => void;
  onSubmitUsername: (username: string) => void;
  onBack: () => void;
  error?: string | null;
  submitting?: boolean;
};

function AuthInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-full bg-neutral-400 px-5 py-2.5 text-sm text-white placeholder-white/90 outline-none"
    />
  );
}

export function AuthPage({
  step,
  email,
  onSubmitCredentials,
  onSubmitUsername,
  onBack,
  error,
  submitting,
}: AuthPageProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0c1014] px-6">
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
          className="flex w-full max-w-56 flex-col items-center gap-3"
        >
          <AuthInput
            type="email"
            name="email"
            placeholder="email"
            autoComplete="email"
            defaultValue={email}
            required
          />
          <AuthInput
            type="password"
            name="password"
            placeholder="Password"
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

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 w-full rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Please wait…" : "Continue"}
          </button>
        </form>
      ) : (
        <form
          key="username"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            onSubmitUsername(String(formData.get("username") ?? ""));
          }}
          className="flex w-full max-w-56 flex-col items-center gap-3"
        >
          <p className="text-center text-xs text-neutral-400">
            No account found for <span className="text-white">{email}</span>. Pick a
            username to finish creating one.
          </p>
          <AuthInput
            type="text"
            name="username"
            placeholder="username"
            autoComplete="username"
            required
            minLength={3}
            maxLength={20}
          />

          {error && <p className="text-center text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 w-full rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Please wait…" : "Sign up"}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-neutral-400 transition-colors hover:text-white"
          >
            ← Use a different email
          </button>
        </form>
      )}
    </div>
  );
}

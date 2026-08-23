export type AuthMode = "login" | "signup";

export type AuthSubmitData = {
  username?: string;
  email: string;
  password: string;
};

type AuthPageProps = {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onSubmit?: (data: AuthSubmitData) => void;
  error?: string | null;
  submitting?: boolean;
};

function AuthInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-56 rounded-full bg-neutral-400 px-5 py-2.5 text-sm text-white placeholder-white/90 outline-none"
    />
  );
}

export function AuthPage({
  mode,
  onModeChange,
  onSubmit,
  error,
  submitting,
}: AuthPageProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const formData = new FormData(e.currentTarget);
          const data: AuthSubmitData = {
            email: String(formData.get("email") ?? ""),
            password: String(formData.get("password") ?? ""),
          };
          if (mode === "signup") {
            data.username = String(formData.get("username") ?? "");
          }
          onSubmit?.(data);
        }}
        className="flex flex-col items-center gap-3"
      >
        {mode === "signup" && (
          <AuthInput
            type="text"
            name="username"
            placeholder="username"
            autoComplete="username"
            required
          />
        )}
        <AuthInput
          type="email"
          name="email"
          placeholder="email"
          autoComplete="email"
          required
        />
        <AuthInput
          type="password"
          name="password"
          placeholder="Password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "signup" ? 8 : undefined}
          required
        />

        {error && <p className="max-w-56 text-center text-xs text-red-400">{error}</p>}

        <div className="mt-3 flex overflow-hidden rounded-full bg-neutral-300 text-xs font-medium tracking-wide text-black">
          <button
            type="button"
            onClick={() => onModeChange("login")}
            className={`px-6 py-2 transition-colors ${
              mode === "login" ? "bg-white" : "hover:bg-neutral-200"
            }`}
          >
            LOGIN
          </button>
          <div className="w-px bg-neutral-500" />
          <button
            type="button"
            onClick={() => onModeChange("signup")}
            className={`px-5 py-2 transition-colors ${
              mode === "signup" ? "bg-white" : "hover:bg-neutral-200"
            }`}
          >
            SIGN UP
          </button>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="mt-1 w-56 rounded-full bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Please wait…" : mode === "login" ? "Log in" : "Sign up"}
        </button>
      </form>
    </div>
  );
}

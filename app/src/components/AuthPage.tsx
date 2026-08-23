export type AuthMode = "login" | "signup";

type AuthPageProps = {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onSubmit?: () => void;
};

function AuthInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-56 rounded-full bg-neutral-400 px-5 py-2.5 text-sm text-white placeholder-white/90 outline-none"
    />
  );
}

export function AuthPage({ mode, onModeChange, onSubmit }: AuthPageProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
        className="flex flex-col items-center gap-3"
      >
        {mode === "signup" && (
          <AuthInput type="text" placeholder="username" autoComplete="username" />
        )}
        <AuthInput type="email" placeholder="email" autoComplete="email" />
        <AuthInput
          type="password"
          placeholder="Password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />

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
      </form>
    </div>
  );
}

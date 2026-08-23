import { useEffect, useState } from "react";
import { NavBar } from "./components/NavBar";
import { PostCard } from "./components/PostCard";
import { Countdown } from "./components/Countdown";
import {
  AuthPage,
  type AuthCredentialsData,
  type AuthStep,
} from "./components/AuthPage";
import { checkEmail, fetchCurrentUser, login, logout, signup } from "./api/auth";
import type { Post, User } from "./types";

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

const SAMPLE_POSTS: Post[] = [
  {
    id: "1",
    username: "username",
    description: "Photo description here\nLorem",
  },
  {
    id: "2",
    username: "username",
    description:
      "Photo description here\nLorem ipsum dolor sit amet\nconsectetur adipiscing elit",
  },
];

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authStep, setAuthStep] = useState<AuthStep>("credentials");
  const [pendingCredentials, setPendingCredentials] =
    useState<AuthCredentialsData | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [view, setView] = useState<"home" | "profile">("home");
  const [nextAllowedAt] = useState(() => Date.now() + TWELVE_HOURS_MS);

  useEffect(() => {
    fetchCurrentUser()
      .then(setUser)
      .finally(() => setCheckingSession(false));
  }, []);

  async function handleCredentialsSubmit(data: AuthCredentialsData) {
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const hasAccount = await checkEmail(data.email);
      if (hasAccount) {
        const loggedInUser = await login(data);
        setUser(loggedInUser);
      } else {
        setPendingCredentials(data);
        setAuthStep("username");
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleUsernameSubmit(username: string) {
    if (!pendingCredentials) return;
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const newUser = await signup({ ...pendingCredentials, username });
      setUser(newUser);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  function handleAuthBack() {
    setAuthStep("credentials");
    setPendingCredentials(null);
    setAuthError(null);
  }

  async function handleLogout() {
    await logout();
    setUser(null);
    setView("home");
  }

  if (checkingSession) {
    return <div className="min-h-screen bg-black" />;
  }

  if (!user) {
    return (
      <AuthPage
        step={authStep}
        email={pendingCredentials?.email}
        onSubmitCredentials={handleCredentialsSubmit}
        onSubmitUsername={handleUsernameSubmit}
        onBack={handleAuthBack}
        error={authError}
        submitting={authSubmitting}
      />
    );
  }

  return (
    <div className="min-h-screen bg-black">
      <NavBar active={view} onChange={setView} />

      <main className="flex justify-center px-6 py-24">
        {view === "home" ? (
          <div className="flex flex-col gap-16">
            {SAMPLE_POSTS.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-8 pt-16">
            <div className="h-24 w-24 rounded-full bg-neutral-300" />
            <span className="text-white">@{user.username}</span>
            <Countdown nextAllowedAt={nextAllowedAt} />
            <button
              type="button"
              onClick={handleLogout}
              className="text-xs text-neutral-400 transition-colors hover:text-white"
            >
              Log out
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;

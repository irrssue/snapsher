import { useEffect, useState } from "react";
import { NavBar } from "./components/NavBar";
import { PostCard } from "./components/PostCard";
import { Countdown } from "./components/Countdown";
import { ComposeModal } from "./components/ComposeModal";
import {
  AuthPage,
  type AuthCredentialsData,
  type AuthStep,
} from "./components/AuthPage";
import { checkEmail, fetchCurrentUser, login, logout, signup } from "./api/auth";
import { createPost, fetchPosts, fetchQuota } from "./api/posts";
import type { Post, User } from "./types";

/**
 * Everything behind the sign-in wall. Mounted with `key={user.id}` so switching
 * accounts starts from a clean feed and countdown instead of the previous
 * user's leftovers.
 */
function SignedInApp({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => void;
}) {
  const [view, setView] = useState<"home" | "profile">("home");
  const [posts, setPosts] = useState<Post[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [nextAllowedAt, setNextAllowedAt] = useState(0);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    let active = true;

    Promise.all([fetchPosts().catch(() => [] as Post[]), fetchQuota()])
      .then(([nextPosts, quota]) => {
        if (!active) return;
        setPosts(nextPosts);
        setNextAllowedAt(quota?.nextAllowedAt ?? 0);
      })
      .finally(() => {
        if (active) setLoadingFeed(false);
      });

    return () => {
      active = false;
    };
  }, []);

  async function handleShare(input: { photo: string; description: string }) {
    const { post, nextAllowedAt: allowedAt } = await createPost(input);
    setPosts((current) => [post, ...current]);
    setNextAllowedAt(allowedAt);
    setComposing(false);
    setView("home");
  }

  return (
    <div className="min-h-screen bg-black">
      <NavBar
        active={view}
        onChange={setView}
        onAddPost={() => setComposing(true)}
      />

      <main className="flex justify-center px-6 py-24">
        {view === "home" ? (
          <div className="flex flex-col gap-16">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
            {!loadingFeed && posts.length === 0 && (
              <p className="text-center text-sm text-neutral-500">
                Nothing shared yet. Tap + to share your photo.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-8 pt-16">
            <div className="h-24 w-24 rounded-full bg-neutral-300" />
            <span className="text-white">@{user.username}</span>
            <Countdown nextAllowedAt={nextAllowedAt} />
            <button
              type="button"
              onClick={onLogout}
              className="text-xs text-neutral-400 transition-colors hover:text-white"
            >
              Log out
            </button>
          </div>
        )}
      </main>

      {composing && (
        <ComposeModal
          username={user.username}
          nextAllowedAt={nextAllowedAt}
          onClose={() => setComposing(false)}
          onShare={handleShare}
        />
      )}
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authStep, setAuthStep] = useState<AuthStep>("credentials");
  const [pendingCredentials, setPendingCredentials] =
    useState<AuthCredentialsData | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

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
    setAuthStep("credentials");
    setPendingCredentials(null);
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

  return <SignedInApp key={user.id} user={user} onLogout={handleLogout} />;
}

export default App;

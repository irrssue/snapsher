import { useCallback, useEffect, useState } from "react";
import { NavBar } from "./components/NavBar";
import { PostCard } from "./components/PostCard";
import { FriendsTab } from "./components/FriendsTab";
import { Countdown } from "./components/Countdown";
import { ComposeModal } from "./components/ComposeModal";
import { ProfileAvatar } from "./components/ProfileAvatar";
import {
  AuthPage,
  type AuthCredentialsData,
  type AuthStep,
} from "./components/AuthPage";
import { continueWithCredentials, fetchCurrentUser, logout, signup } from "./api/auth";
import { createPost, fetchPosts, fetchQuota } from "./api/posts";
import { ApiError, onSessionExpired } from "./api/http";
import type { Post, User } from "./types";

/**
 * Everything behind the sign-in wall. Mounted with `key={user.id}` so switching
 * accounts starts from a clean feed and countdown instead of the previous
 * user's leftovers.
 */
function SignedInApp({
  user,
  onLogout,
  onAvatarChange,
}: {
  user: User;
  onLogout: () => void;
  onAvatarChange: (user: User) => void;
}) {
  const [view, setView] = useState<"home" | "friends" | "profile">("home");
  const [posts, setPosts] = useState<Post[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  /** Null means the posting window is unknown, not that posting is allowed. */
  const [nextAllowedAt, setNextAllowedAt] = useState<number | null>(null);
  /**
   * How far this device's clock sits from the server's, measured once per quota
   * fetch. `nextAllowedAt` is an absolute timestamp taken from the server, so
   * comparing it against a raw `Date.now()` compares two clocks: a phone half an
   * hour fast counts down to zero early, enables Share, and earns a 429.
   */
  const [clockOffset, setClockOffset] = useState(0);
  const [composing, setComposing] = useState(false);

  /**
   * Also handed to `FriendsTab`, which is a sibling with its own state — so
   * accepting or removing a friend there changes who this feed should contain
   * while nothing remounts it. Without this the new friend's posts never
   * appear, and a removed friend's stay on screen with their photos 404ing.
   */
  const refreshFeed = useCallback(async () => {
    // `allSettled`, not `all`: these two fail independently, and a 500 from the
    // quota endpoint used to take a perfectly good feed down with it.
    const [postsResult, quotaResult] = await Promise.allSettled([fetchPosts(), fetchQuota()]);

    if (postsResult.status === "fulfilled") {
      setPosts(postsResult.value);
      setFeedError(null);
    } else {
      const err = postsResult.reason;
      setFeedError(err instanceof Error ? err.message : "Couldn't load your feed.");
    }

    if (quotaResult.status === "fulfilled") {
      setNextAllowedAt(quotaResult.value.nextAllowedAt);
      setClockOffset(quotaResult.value.serverNow - Date.now());
    } else {
      // Null degrades the countdown to "couldn't check", which is not the same
      // as permission to post — and leaves the feed above untouched.
      setNextAllowedAt(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    refreshFeed().finally(() => {
      if (active) setLoadingFeed(false);
    });
    return () => {
      active = false;
    };
  }, [refreshFeed]);

  async function handleShare(input: { photo: string; description: string }) {
    try {
      const { post, nextAllowedAt: allowedAt } = await createPost(input);
      setPosts((current) => [post, ...current]);
      setNextAllowedAt(allowedAt);
      setComposing(false);
      setView("home");
    } catch (err) {
      // A 429 here means the window was spent elsewhere — a second tab, another
      // device — while this one still believed it could post. The rejection
      // reports when the window reopens, so adopting it re-disables Share and
      // starts the countdown instead of leaving a button whose only remaining
      // effect is to burn rate-limit budget.
      if (err instanceof ApiError && typeof err.details?.nextAllowedAt === "number") {
        setNextAllowedAt(err.details.nextAllowedAt);
      }
      // Rethrown so the modal still shows the server's own message.
      throw err;
    }
  }

  return (
    <div className="min-h-screen bg-black">
      <NavBar
        active={view}
        onChange={setView}
        onAddPost={() => setComposing(true)}
      />

      <main className="flex justify-center px-4 pb-24 pt-8 md:px-6 md:py-24">
        {view === "home" ? (
          <div className="flex w-full max-w-md flex-col gap-10 md:max-w-none md:gap-16">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
            {feedError && (
              <p className="text-center text-sm text-red-400">{feedError}</p>
            )}
            {!loadingFeed && !feedError && posts.length === 0 && (
              <p className="text-center text-sm text-neutral-500">
                Nothing shared yet. Tap + to share your photo.
              </p>
            )}
          </div>
        ) : view === "friends" ? (
          <FriendsTab onFriendsChanged={refreshFeed} />
        ) : (
          <div className="flex w-full max-w-md flex-col items-center gap-8 pt-8 md:pt-16">
            <ProfileAvatar user={user} onAvatarChange={onAvatarChange} />
            <span className="text-white">@{user.username}</span>
            <Countdown nextAllowedAt={nextAllowedAt} clockOffset={clockOffset} />
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
          clockOffset={clockOffset}
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

  /**
   * A session can end while the app is open — it expires, or it's signed out
   * elsewhere. Without this the UI keeps showing a signed-in shell whose every
   * write fails, which is exactly how a dropped session used to surface: as
   * "Not signed in." on the share button.
   */
  useEffect(() => {
    const unsubscribe = onSessionExpired(() => {
      setUser(null);
      setAuthStep("credentials");
      setPendingCredentials(null);
      setAuthError("Your session has ended. Please sign in again.");
    });
    return () => unsubscribe();
  }, []);

  async function handleCredentialsSubmit(data: AuthCredentialsData) {
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const result = await continueWithCredentials(data);
      if ("user" in result) {
        setUser(result.user);
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
    setAuthError(null);
    // `pendingCredentials` is kept on purpose: it is what fills the email field
    // back in. Clearing it made "use a different email" wipe the address the
    // user had just typed correctly, so changing one character of it meant
    // retyping the whole thing.
  }

  async function handleLogout() {
    await logout();
    setUser(null);
    setAuthStep("credentials");
    setPendingCredentials(null);
    setAuthError(null);
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
    <SignedInApp
      key={user.id}
      user={user}
      onLogout={handleLogout}
      onAvatarChange={setUser}
    />
  );
}

export default App;

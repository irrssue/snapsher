import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavBar } from "./components/NavBar";
import { PostCard } from "./components/PostCard";
import { FriendsTab } from "./components/FriendsTab";
import { FriendsListPopup } from "./components/FriendsListPopup";
import { PublicProfileModal } from "./components/PublicProfileModal";
import { Countdown } from "./components/Countdown";
import { ComposeModal } from "./components/ComposeModal";
import { ProfileAvatar } from "./components/ProfileAvatar";
import { ProfilePostArchive } from "./components/ProfilePostArchive";
import { useProfilePosts } from "./useProfilePosts";
import {
  AuthPage,
  type AuthCredentialsData,
  type AuthStep,
} from "./components/AuthPage";
import {
  continueWithCredentials,
  fetchCurrentUser,
  logout,
  requestPasswordReset,
  resendCode,
  resetPassword,
  signup,
  verifyEmail,
} from "./api/auth";
import { createPost, fetchPosts, fetchQuota } from "./api/posts";
import { fetchFriends, removeFriend, type Friend } from "./api/friends";
import { ApiError, onSessionExpired } from "./api/http";
import type { Post, User } from "./types";
import { ErrorState, Skeleton, Wordmark } from "./components/ui";

/**
 * The friend list arrives ordered by `username COLLATE NOCASE` — an ASCII
 * case-fold, which this reproduces exactly. Used when a failed removal has to
 * put someone back: appending them dropped the restored friend at the bottom of
 * a list that is sorted everywhere else, which reads as a second bug on top of
 * the first.
 */
function byUsernameNoCase(a: Friend, b: Friend): number {
  const left = a.username.toLowerCase();
  const right = b.username.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Holds a feed card's shape while the first load is in flight. */
function PostCardSkeleton() {
  return (
    <div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-center md:gap-10">
      <div className="flex flex-col gap-3 md:w-64">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <Skeleton className="aspect-square w-full rounded-shell md:aspect-auto md:h-(--size-photo) md:w-(--size-photo) md:shrink-0" />
    </div>
  );
}

/**
 * Everything behind the sign-in wall. Mounted with `key={user.id}` so switching
 * accounts starts from a clean feed and countdown instead of the previous
 * user's leftovers.
 */
function SignedInApp({
  user,
  onLogout,
  onAccountDeleted,
  onAvatarChange,
}: {
  user: User;
  onLogout: () => Promise<void>;
  onAccountDeleted: () => void;
  onAvatarChange: (user: User) => void;
}) {
  const [view, setView] = useState<"home" | "friends" | "profile">("home");
  const [posts, setPosts] = useState<Post[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  /**
   * Three states. `undefined` is "the quota call hasn't answered yet", `null`
   * is "it answered and we couldn't use it" — collapsing them made the failure
   * message the first thing every session showed while the request was still
   * perfectly in flight. A number is the window itself; never a licence to post
   * without comparing it to the clock.
   */
  const [nextAllowedAt, setNextAllowedAt] = useState<number | null | undefined>(undefined);
  /**
   * How far this device's clock sits from the server's, measured once per quota
   * fetch. `nextAllowedAt` is an absolute timestamp taken from the server, so
   * comparing it against a raw `Date.now()` compares two clocks: a phone half an
   * hour fast counts down to zero early, enables Share, and earns a 429.
   */
  const [clockOffset, setClockOffset] = useState(0);
  const [postCount, setPostCount] = useState(0);
  const [composing, setComposing] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  const archive = useProfilePosts(user.id);
  const { refresh: refreshMyPosts } = archive;
  const [showFriendsPopup, setShowFriendsPopup] = useState(false);
  const [friendsPopupError, setFriendsPopupError] = useState<string | null>(null);
  /** The user id behind an open public-profile modal — null means none is open. */
  const [viewingUserId, setViewingUserId] = useState<number | null>(null);

  /**
   * The three views are a ternary, so switching tabs unmounts the one being
   * left. `posts` survives in this component, but the browser clamps `scrollY`
   * against the much shorter profile tab, so coming back to a feed you were
   * twenty photos into landed you at the top of it. Recorded on the way out and
   * restored in a layout effect, before paint, so there is no visible jump.
   */
  const scrollPositions = useRef<Record<string, number>>({});

  const changeView = useCallback(
    (next: "home" | "friends" | "profile") => {
      setView((current) => {
        scrollPositions.current[current] = window.scrollY;
        return next;
      });
    },
    [],
  );

  useLayoutEffect(() => {
    window.scrollTo(0, scrollPositions.current[view] ?? 0);
  }, [view]);

  /**
   * Each refresh below can be started from several places at once — mount,
   * accepting a request, removing a friend — and nothing makes the responses
   * come back in the order they were asked for. A counter bumped on the way in
   * and checked on the way out means only the newest call is allowed to write,
   * so a slow earlier one can't reinstate the state it was sent to replace.
   */
  const feedGeneration = useRef(0);
  const friendsGeneration = useRef(0);

  /**
   * Also run whenever a friendship changes — accepting a request in
   * `FriendsTab` or removing someone in the friends popup — so this feed picks
   * up who it should contain without either of those siblings remounting it.
   * Without this a new friend's posts never appear, and a removed friend's
   * stay on screen with their photos 404ing.
   */
  const refreshFeed = useCallback(async () => {
    const generation = ++feedGeneration.current;
    // `allSettled`, not `all`: these two fail independently, and a 500 from the
    // quota endpoint used to take a perfectly good feed down with it.
    const [postsResult, quotaResult] = await Promise.allSettled([fetchPosts(), fetchQuota()]);
    if (generation !== feedGeneration.current) return;

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
      setPostCount(quotaResult.value.postCount);
    } else {
      // Null degrades the countdown to "couldn't check", which is not the same
      // as permission to post — and leaves the feed above untouched.
      setNextAllowedAt(null);
    }
  }, []);

  /**
   * Backs the friend count and the "N Friends" popup on the profile screen.
   * Kept separate from `refreshFeed` since it isn't feed state, but the two
   * are always re-run together after anything that changes who's a friend.
   */
  const refreshFriends = useCallback(async () => {
    const generation = ++friendsGeneration.current;
    try {
      const next = await fetchFriends();
      if (generation === friendsGeneration.current) setFriends(next);
    } catch {
      // Not worth surfacing on its own — the count and popup just stay stale
      // until the next successful refresh.
    }
  }, []);

  /** Passed to `FriendsTab`: a request being accepted changes both of these. */
  const handleFriendsChanged = useCallback(() => {
    refreshFeed();
    refreshFriends();
  }, [refreshFeed, refreshFriends]);

  useEffect(() => {
    let active = true;
    Promise.all([refreshFeed(), refreshFriends()]).finally(() => {
      if (active) setLoadingFeed(false);
    });
    return () => {
      active = false;
    };
  }, [refreshFeed, refreshFriends]);

  async function handleRemoveFriend(friend: Friend) {
    setFriendsPopupError(null);
    setFriends((current) => current.filter((f) => f.id !== friend.id));
    try {
      await removeFriend(friend.id);
      // Their posts have to leave the feed along with them — and the grid too,
      // since the comment and like counts on your own photos just lost
      // everything this person had left on them.
      refreshFeed();
      refreshMyPosts();
    } catch (err) {
      // The server still has the friendship, so put them back rather than
      // leaving the popup asserting a removal that never happened.
      setFriends((current) =>
        current.some((f) => f.id === friend.id)
          ? current
          : [...current, friend].sort(byUsernameNoCase),
      );
      setFriendsPopupError(err instanceof Error ? err.message : "Couldn't remove that friend.");
    }
  }

  /**
   * A deleted post leaves both lists and drops the count, but deliberately
   * does not touch `nextAllowedAt`: the server tracks the posting window on the
   * user row rather than on the posts table, precisely so deleting the most
   * recent photo can't buy another turn. Refetching the quota here would only
   * confirm a number that hasn't moved.
   */
  function handlePostDeleted(postId: string) {
    setPosts((current) => current.filter((post) => post.id !== postId));
    archive.removePost(postId);
    setPostCount((current) => Math.max(0, current - 1));
  }

  async function handleShare(input: { photo: string; description: string }) {
    try {
      const { post, nextAllowedAt: allowedAt } = await createPost(input);
      setPosts((current) => [post, ...current]);
      void refreshMyPosts();
      setNextAllowedAt(allowedAt);
      setPostCount((current) => current + 1);
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
    <div className="min-h-dvh bg-ground">
      <NavBar
        active={view}
        onChange={changeView}
        onAddPost={() => setComposing(true)}
        nextAllowedAt={nextAllowedAt}
        clockOffset={clockOffset}
      />

      {/* The bottom padding clears the fixed nav *and* the home-indicator
          band it now sits above; `md:py-24` drops both once the nav is static. */}
      <main className="flex justify-center px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-8 md:px-6 md:py-24">
        {view === "home" ? (
          <div className="flex w-full max-w-md flex-col gap-10 md:max-w-none md:gap-16">
            <h1 className="sr-only">Home feed</h1>

            {loadingFeed && !feedError && (
              <>
                <PostCardSkeleton />
                <PostCardSkeleton />
              </>
            )}

            {posts.map((post) => (
              // The grid's counts come from a different call than the feed's,
              // so a comment left here has to send the other one back for a
              // fresh copy or the badge on the profile stays a comment behind.
              <PostCard key={post.id} post={post} onCountsChanged={refreshMyPosts} />
            ))}

            {feedError && <ErrorState message={feedError} onRetry={refreshFeed} />}

            {!loadingFeed && !feedError && posts.length === 0 && (
              /*
               * The first thing a brand-new account sees. It used to be one
               * grey sentence naming a control the user had to go find; it now
               * says what the app is for and puts the way to fill the feed
               * directly under it.
               */
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <p className="text-sm text-neutral-300">Your feed is your friends' photos.</p>
                <p className="max-w-xs text-xs text-neutral-400">
                  Add a few people and their photos land here — one each, every 12 hours.
                </p>
                <button
                  type="button"
                  onClick={() => changeView("friends")}
                  className="min-h-11 text-sm text-neutral-300 underline underline-offset-4 transition-colors hover:text-white active:text-white"
                >
                  Find people to add
                </button>
              </div>
            )}

            {/*
             * An end cap, on a product built against endless scrolling. The
             * feed simply stopped before, which reads as "still loading" — this
             * is the one place the app gets to say the scrolling is over and
             * mean it.
             */}
            {!loadingFeed && !feedError && posts.length > 0 && (
              <p className="pb-4 text-center text-xs text-neutral-400">
                That's everyone's photo for now.
              </p>
            )}
          </div>
        ) : view === "friends" ? (
          <>
            <h1 className="sr-only">Find people</h1>
            <FriendsTab onFriendsChanged={handleFriendsChanged} onViewProfile={setViewingUserId} />
          </>
        ) : (
          <div
            // No `pt-*` here: `main` already supplies `pt-8 md:py-24`, and a
            // second one shifted the profile tab 32px lower than home and
            // friends, so the same avatar sat at two heights across tabs.
            className="flex w-full max-w-md flex-col items-center gap-8"
          >
            <ProfileAvatar
              user={user}
              onAvatarChange={onAvatarChange}
              onLogout={onLogout}
              onAccountDeleted={onAccountDeleted}
            />
            <h1 className="break-words text-lg text-white">@{user.username}</h1>

            {/* Both counters start at 0 and used to render as data immediately,
                so a user with thirty friends read "0 Friends" until the fetch
                landed — indistinguishable from actually having none. */}
            {loadingFeed ? (
              <div className="flex items-center gap-6">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-16" />
              </div>
            ) : (
              <div className="flex items-center gap-6 text-sm">
                <button
                  type="button"
                  onClick={() => setShowFriendsPopup(true)}
                  className="-m-3.5 p-3.5 text-neutral-300 transition-colors hover:text-white active:text-white"
                >
                  {friends.length} Friends
                </button>
                <span className="text-neutral-300">{postCount} posts</span>
              </div>
            )}

            <Countdown nextAllowedAt={nextAllowedAt} clockOffset={clockOffset} />

            <ProfilePostArchive
              archive={archive}
              username={user.username}
              avatarUrl={user.avatarUrl}
              onPostDeleted={handlePostDeleted}
              onCountsChanged={refreshMyPosts}
              emptyLabel="Your photos will appear here."
            />
          </div>
        )}
      </main>

      {composing && (
        <ComposeModal
          username={user.username}
          avatarUrl={user.avatarUrl}
          nextAllowedAt={nextAllowedAt}
          clockOffset={clockOffset}
          onClose={() => setComposing(false)}
          onShare={handleShare}
        />
      )}

      {showFriendsPopup && (
        <FriendsListPopup
          friends={friends}
          error={friendsPopupError}
          onClose={() => setShowFriendsPopup(false)}
          onRemoveFriend={handleRemoveFriend}
          // Closing the popup first — the same hand-off `SettingsModal` does to
          // the cropper and the delete dialog. Left mounted, its `bg-black/80`
          // backdrop composites with the profile's to ~96% black, and the page
          // behind reads as blacked out rather than dimmed.
          onViewProfile={(id) => {
            setShowFriendsPopup(false);
            setViewingUserId(id);
          }}
        />
      )}

      {viewingUserId !== null && (
        <PublicProfileModal userId={viewingUserId} onClose={() => setViewingUserId(null)} />
      )}
    </div>
  );
}

/**
 * What the auth flow carries between its steps. Deliberately *not* the
 * password: that used to live here too, for the whole session, long after the
 * one request that needed it — see `pendingPassword` below.
 *
 * `token` is the pending sign-up's possession proof from the server — required
 * on every later request for it, but never shown to the user and not the
 * 6-digit code.
 */
type PendingIdentity = { email: string; username?: string; token?: string };

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authStep, setAuthStep] = useState<AuthStep>("credentials");
  const [pendingIdentity, setPendingIdentity] = useState<PendingIdentity | null>(null);
  /**
   * Held for exactly one hop: the address is free, so the user is sent to pick
   * a username, and the password they typed on the previous screen has to
   * survive that step to reach `signup`. Cleared the instant the sign-up is
   * accepted and on every other way out of the flow — a plaintext password
   * sitting in component state for the life of the tab is readable in any heap
   * snapshot, long after nothing needs it.
   */
  const [pendingPassword, setPendingPassword] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  /** Something that went right and still needs saying — a sent code, a changed password. */
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  /** Absolute timestamp for when the resend button re-enables; null while no code has been sent yet. */
  const [resendAt, setResendAt] = useState<number | null>(null);
  /** Separate from `authSubmitting`, which belongs to the form's own submit button — a resend is a second, independent action on the same screen. */
  const [resendSubmitting, setResendSubmitting] = useState(false);

  useEffect(() => {
    fetchCurrentUser()
      .then(setUser)
      .finally(() => setCheckingSession(false));
  }, []);

  /** Everything the auth flow holds, dropped at once. */
  const clearAuthState = useCallback(() => {
    setAuthStep("credentials");
    setPendingIdentity(null);
    setPendingPassword(null);
    setResendAt(null);
    setAuthNotice(null);
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
      clearAuthState();
      setAuthError("Your session has ended. Please sign in again.");
    });
    return () => unsubscribe();
  }, [clearAuthState]);

  async function handleCredentialsSubmit(data: AuthCredentialsData) {
    setAuthError(null);
    setAuthNotice(null);
    setAuthSubmitting(true);
    try {
      const result = await continueWithCredentials(data);
      if ("user" in result) {
        setPendingPassword(null);
        setUser(result.user);
      } else {
        setPendingIdentity({ email: data.email });
        setPendingPassword(data.password);
        setAuthStep("username");
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleUsernameSubmit(username: string) {
    if (!pendingIdentity || pendingPassword === null) return;
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const result = await signup({
        email: pendingIdentity.email,
        password: pendingPassword,
        username,
      });
      setPendingIdentity({ ...pendingIdentity, username, token: result.token });
      // The token replaces it from here on: verifying and resending both prove
      // themselves with that instead, so there is nothing left for the password
      // to do.
      setPendingPassword(null);
      setResendAt(Date.now() + result.resendInMs);
      setAuthStep("code");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleCodeSubmit(code: string) {
    if (!pendingIdentity?.token) return;
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const newUser = await verifyEmail({
        email: pendingIdentity.email,
        code,
        token: pendingIdentity.token,
      });
      setPendingPassword(null);
      setUser(newUser);
    } catch (err) {
      // Two failures route the user back to an earlier step instead of just
      // being shown inline: a code that outlived its pending sign-up can't be
      // fixed by retyping it, and a username someone else claimed in the
      // meantime needs a different one, not another guess at the same code.
      if (err instanceof ApiError && err.code === "signup_expired") {
        setAuthStep("credentials");
      } else if (err instanceof ApiError && err.code === "identity_taken") {
        setAuthStep("username");
      }
      setAuthError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleResendCode() {
    if (!pendingIdentity?.token || resendSubmitting) return;
    setAuthError(null);
    setResendSubmitting(true);
    try {
      const result = await resendCode({
        email: pendingIdentity.email,
        token: pendingIdentity.token,
      });
      setResendAt(Date.now() + result.resendInMs);
    } catch (err) {
      if (err instanceof ApiError && err.code === "signup_expired") {
        setAuthStep("credentials");
      } else if (
        err instanceof ApiError &&
        (err.code === "resend_cooldown" || err.code === "rate_limited") &&
        typeof err.details?.retryAfter === "number"
      ) {
        // The button's own countdown already prevents this in the ordinary
        // case; this only matters when the server's clock and cooldown ran
        // ahead of what the button believed — e.g. a resend from another tab.
        setResendAt(Date.now() + err.details.retryAfter * 1000);
      }
      setAuthError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setResendSubmitting(false);
    }
  }

  function handleForgotPassword() {
    setAuthStep("forgot");
    setAuthError(null);
    setAuthNotice(null);
    setPendingPassword(null);
    setResendAt(null);
  }

  async function handleRequestPasswordReset(email: string) {
    setAuthError(null);
    setAuthNotice(null);
    setAuthSubmitting(true);
    try {
      await requestPasswordReset(email);
      // The server answers the same way whether or not this address has an
      // account, so this step always advances. The code screen carries the "if
      // that address has an account" wording that makes that honest.
      setPendingIdentity({ email });
      setAuthStep("reset");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleResetPassword(input: { code: string; newPassword: string }) {
    if (!pendingIdentity) return;
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      await resetPassword({ email: pendingIdentity.email, ...input });
      // A reset ends every session for that account rather than starting one,
      // so there is nobody to sign in as here — back to the sign-in screen with
      // the address still filled in.
      setAuthStep("credentials");
      setPendingPassword(null);
      setResendAt(null);
      setAuthNotice("Password changed. Sign in with your new one.");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  function handleAuthBack() {
    setAuthStep("credentials");
    setAuthError(null);
    setAuthNotice(null);
    setResendAt(null);
    // The password goes, the address stays. `pendingIdentity` is what fills the
    // email field back in: clearing it made "use a different email" wipe the
    // address the user had just typed correctly, so changing one character of
    // it meant retyping the whole thing. The password has no such excuse — the
    // form doesn't prefill it, so keeping it would only mean holding a
    // plaintext secret nothing is going to read.
    setPendingPassword(null);
  }

  /**
   * Rejects when the server didn't end the session, and the local state is only
   * cleared once it did. Signing out locally regardless is what left a live
   * `sid` row and its cookie behind on a shared machine after a network blip —
   * the next person to open the tab was signed straight back in.
   */
  async function handleLogout() {
    await logout();
    setUser(null);
    clearAuthState();
    setAuthError(null);
  }

  /**
   * The delete request itself already ends the session server-side, so this
   * only resets local state — the same reset as logging out, minus the
   * now-pointless call to `/api/auth/logout`.
   */
  function handleAccountDeleted() {
    setUser(null);
    clearAuthState();
    setAuthError(null);
  }

  if (checkingSession) {
    /*
     * The very first thing every visit renders. It was a bare black div with no
     * spinner and no timeout, so a cold or slow connection showed an
     * unexplained black screen — as an unbranded first impression of the whole
     * product. The wordmark is the right thing to put in a gap this one is.
     */
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ground" role="status">
        <div className="motion-safe:animate-pulse">
          <Wordmark />
        </div>
        <span className="sr-only">Loading Snapsher…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthPage
        step={authStep}
        email={pendingIdentity?.email}
        onSubmitCredentials={handleCredentialsSubmit}
        onSubmitUsername={handleUsernameSubmit}
        onSubmitCode={handleCodeSubmit}
        onResendCode={handleResendCode}
        onForgotPassword={handleForgotPassword}
        onRequestPasswordReset={handleRequestPasswordReset}
        onResetPassword={handleResetPassword}
        onBack={handleAuthBack}
        error={authError}
        notice={authNotice}
        submitting={authSubmitting}
        resendAt={resendAt}
        resendSubmitting={resendSubmitting}
      />
    );
  }

  return (
    <SignedInApp
      key={user.id}
      user={user}
      onLogout={handleLogout}
      onAccountDeleted={handleAccountDeleted}
      onAvatarChange={setUser}
    />
  );
}

export default App;

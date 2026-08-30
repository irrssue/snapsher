import { useEffect, useState, type ReactNode } from "react";
import { PersonIcon, SearchIcon } from "./icons";
import {
  acceptFriendRequest,
  declineFriendRequest,
  fetchFriendRequests,
  searchUsers,
  sendFriendRequest,
  type FriendRequest,
  type SearchUser,
} from "../api/friends";

type SubTab = "add" | "requests";

type FriendsTabProps = {
  /**
   * Called after a request is accepted — the friend count on the profile page
   * and the home feed both depend on the friend list, and neither lives here
   * to update on its own.
   */
  onFriendsChanged: () => void;
  /** Opens the public profile view for the given user id. */
  onViewProfile: (userId: number) => void;
};

export function FriendsTab({ onFriendsChanged, onViewProfile }: FriendsTabProps) {
  const [subTab, setSubTab] = useState<SubTab>("add");
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  /** The requests list couldn't be fetched at all — not that there are none. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** One action failed; the lists themselves are still good. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [discoverableUsers, setDiscoverableUsers] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [sentRequests, setSentRequests] = useState<number[]>([]);

  useEffect(() => {
    let active = true;
    fetchFriendRequests()
      .then((nextRequests) => {
        if (!active) return;
        setRequests(nextRequests);
        setLoadError(null);
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : "Couldn't load your requests.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || subTab !== "add") {
      setDiscoverableUsers([]);
      setSearching(false);
      return;
    }

    let active = true;
    // Raised before the debounce rather than when the request goes out: the
    // 250ms wait is just as much "the answer isn't known yet" as the request
    // is, and the empty state rendered during it flashed "No one matches" on
    // every keystroke.
    setSearching(true);
    const timer = setTimeout(() => {
      searchUsers(trimmed)
        .then((users) => {
          if (!active) return;
          setDiscoverableUsers(users);
          setActionError(null);
        })
        .catch((err) => {
          if (!active) return;
          setDiscoverableUsers([]);
          setActionError(err instanceof Error ? err.message : "Couldn't search right now.");
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, subTab]);

  async function handleSendFriendRequest(id: number) {
    setActionError(null);
    setSentRequests((current) => (current.includes(id) ? current : [...current, id]));
    try {
      await sendFriendRequest(id);
    } catch (err) {
      // The button flipping from "Requested" back to "Add" on its own reads as
      // a glitch; say what happened alongside it.
      setSentRequests((current) => current.filter((sentId) => sentId !== id));
      setActionError(err instanceof Error ? err.message : "Couldn't send that request.");
    }
  }

  async function handleAcceptRequest(request: FriendRequest) {
    setActionError(null);
    setRequests((current) => current.filter((r) => r.id !== request.id));
    try {
      await acceptFriendRequest(request.id);
      // The new friend has to show up in the feed and in the friend count
      // without waiting for a reload.
      onFriendsChanged();
    } catch (err) {
      // The server never accepted it, so put the request back rather than
      // leaving the UI asserting an acceptance that never happened.
      fetchFriendRequests()
        .then(setRequests)
        .catch(() => undefined);
      setActionError(err instanceof Error ? err.message : "Couldn't accept that request.");
    }
  }

  async function handleDeclineRequest(request: FriendRequest) {
    setActionError(null);
    setRequests((current) => current.filter((r) => r.id !== request.id));
    try {
      await declineFriendRequest(request.id);
    } catch (err) {
      setRequests((current) =>
        current.some((r) => r.id === request.id) ? current : [...current, request],
      );
      setActionError(err instanceof Error ? err.message : "Couldn't decline that request.");
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="flex justify-center gap-1 self-center rounded-full bg-neutral-800 p-1">
        <button
          type="button"
          onClick={() => setSubTab("add")}
          className={`rounded-full px-4 py-3 text-xs transition-colors ${
            subTab === "add"
              ? "bg-neutral-200 text-black"
              : "text-neutral-300 hover:text-white active:text-white"
          }`}
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => setSubTab("requests")}
          className={`flex items-center gap-1.5 rounded-full px-4 py-3 text-xs transition-colors ${
            subTab === "requests"
              ? "bg-neutral-200 text-black"
              : "text-neutral-300 hover:text-white active:text-white"
          }`}
        >
          Requests
          {requests.length > 0 && (
            <span
              className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] ${
                subTab === "requests"
                  ? "bg-black text-white"
                  : "bg-neutral-600 text-white"
              }`}
            >
              {requests.length}
            </span>
          )}
        </button>
      </div>

      {(loadError ?? actionError) && (
        <p className="text-center text-sm text-red-400">{loadError ?? actionError}</p>
      )}

      {subTab === "add" ? (
        <div className="flex flex-col gap-6">
          <label className="relative block">
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              // Autocorrect rewrites the username as it is typed — "irrssue"
              // becomes "issue" — and the search then truthfully reports that
              // nobody matches a name the user never entered.
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={30}
              placeholder="Search all users"
              aria-label="Search all users"
              className="w-full rounded-full bg-neutral-800 py-2 pl-10 pr-4 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60"
            />
          </label>

          <div className="flex flex-col gap-1">
            {discoverableUsers.map((discoverableUser) => {
              const alreadySent = sentRequests.includes(discoverableUser.id);
              const isFriend = discoverableUser.isFriend;
              const disabled = alreadySent || isFriend;
              return (
                <PersonRow
                  key={discoverableUser.id}
                  avatarUrl={discoverableUser.avatarUrl}
                  username={discoverableUser.username}
                  onClick={() => onViewProfile(discoverableUser.id)}
                  action={
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => handleSendFriendRequest(discoverableUser.id)}
                      className={`shrink-0 rounded-full px-4 py-2.5 text-xs transition-opacity ${
                        disabled
                          ? "bg-neutral-900 text-neutral-500"
                          : "bg-white text-black hover:opacity-90 active:opacity-70"
                      }`}
                    >
                      {isFriend ? "Friends" : alreadySent ? "Requested" : "Add"}
                    </button>
                  }
                />
              );
            })}

            {/* `searching` covers both the debounce and the request in flight,
                so "No one matches" is only ever an answer, never a guess. */}
            {discoverableUsers.length === 0 && !searching && (
              <p className="break-words pt-8 text-center text-sm text-neutral-400">
                {query.trim() ? `No one matches "${query}".` : "Search for someone to add."}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {requests.map((request) => (
            <PersonRow
              key={request.id}
              avatarUrl={request.avatarUrl}
              username={request.username}
              onClick={() => onViewProfile(request.userId)}
              action={
                <div
                  // `px-3`/`gap-1.5`, not `px-4`/`gap-2`: this group is `shrink-0`, so
                  // its width comes straight off the truncating username beside it —
                  // at 320px the old sizing left about six characters of the name.
                  className="flex shrink-0 items-center gap-1.5"
                >
                  <button
                    type="button"
                    onClick={() => handleDeclineRequest(request)}
                    className="rounded-full bg-neutral-800 px-3 py-2.5 text-xs text-neutral-300 transition-colors hover:text-white active:text-white"
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAcceptRequest(request)}
                    className="rounded-full bg-white px-3 py-2.5 text-xs text-black transition-opacity hover:opacity-90 active:opacity-70"
                  >
                    Accept
                  </button>
                </div>
              }
            />
          ))}

          {requests.length === 0 && !loadError && (
            <p className="pt-8 text-center text-sm text-neutral-400">No pending requests.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function PersonRow({
  avatarUrl,
  username,
  action,
  onClick,
}: {
  avatarUrl: string | null;
  username: string;
  action: ReactNode;
  /** Opens that person's public profile. Omitted where there's nothing to open. */
  onClick?: () => void;
}) {
  // `neutral-800`, not `neutral-900`: this row is also rendered inside
  // `FriendsListPopup`, whose dialog is itself `bg-neutral-900` — the old
  // highlight was exactly the background there, so hover and press showed
  // nothing at all. Matches the row highlight in `SettingsModal`.
  return (
    <div className="flex items-center gap-3 rounded-2xl px-2 py-2.5 transition-colors hover:bg-neutral-800 active:bg-neutral-800">
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className="flex flex-1 items-center gap-3 text-left disabled:cursor-default"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-700">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <PersonIcon className="h-6 w-6 text-neutral-400" />
          )}
        </span>

        <span className="flex-1 truncate text-sm text-white">@{username}</span>
      </button>

      {action}
    </div>
  );
}

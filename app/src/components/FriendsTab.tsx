import { useEffect, useState } from "react";
import { PersonIcon, UserPlusIcon } from "./icons";
import {
  acceptFriendRequest,
  declineFriendRequest,
  fetchFriendRequests,
  fetchFriends,
  removeFriend,
  searchUsers,
  sendFriendRequest,
  type Friend,
  type FriendRequest,
} from "../api/friends";

type SubTab = "friends" | "requests" | "add";

type FriendsTabProps = {
  /**
   * Called after a change that alters whose posts the signed-in user may see.
   * The feed lives in a sibling component that nothing here remounts, so
   * without this a newly accepted friend's posts never arrive and a removed
   * one's stay on screen with their photos 404ing.
   */
  onFriendsChanged: () => void;
};

function byUsername(a: Friend, b: Friend) {
  return a.username.localeCompare(b.username);
}

export function FriendsTab({ onFriendsChanged }: FriendsTabProps) {
  const [subTab, setSubTab] = useState<SubTab>("friends");
  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  /** The lists couldn't be fetched at all — so an empty list means nothing yet. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** One action failed; the lists themselves are still good. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [discoverQuery, setDiscoverQuery] = useState("");
  const [discoverableUsers, setDiscoverableUsers] = useState<Friend[]>([]);
  const [searching, setSearching] = useState(false);
  const [sentRequests, setSentRequests] = useState<number[]>([]);

  useEffect(() => {
    let active = true;
    Promise.all([fetchFriends(), fetchFriendRequests()])
      .then(([nextFriends, nextRequests]) => {
        if (!active) return;
        setFriends(nextFriends);
        setRequests(nextRequests);
        setLoadError(null);
      })
      .catch((err) => {
        // Swallowing this left the empty list rendering "No friends yet.",
        // which is indistinguishable from genuinely having none — and offers
        // nothing to retry.
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : "Couldn't load your friends.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const trimmed = discoverQuery.trim();
    if (!trimmed) {
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
  }, [discoverQuery]);

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

  async function handleRemoveFriend(friend: Friend) {
    setActionError(null);
    setFriends((current) => current.filter((f) => f.id !== friend.id));
    try {
      await removeFriend(friend.id);
      // Their posts have to leave the feed along with them.
      onFriendsChanged();
    } catch (err) {
      // The server still has the friendship, so put the row back rather than
      // leaving the UI asserting a removal that never happened.
      setFriends((current) =>
        current.some((f) => f.id === friend.id) ? current : [...current, friend].sort(byUsername),
      );
      setActionError(err instanceof Error ? err.message : "Couldn't remove that friend.");
    }
  }

  async function handleAcceptRequest(request: FriendRequest) {
    setActionError(null);
    setRequests((current) => current.filter((r) => r.id !== request.id));
    setFriends((current) =>
      [
        ...current,
        // `request.userId`, never `request.id`: the latter identifies the
        // request row, and the two tables hand out the same numbers. Using it
        // here pointed the new row at whichever *user* happened to share that
        // id, so Remove unfriended a stranger.
        { id: request.userId, username: request.username, avatarUrl: request.avatarUrl },
      ].sort(byUsername),
    );
    try {
      await acceptFriendRequest(request.id);
      // Their posts should show up in the feed without waiting for a reload.
      onFriendsChanged();
    } catch (err) {
      // Both lists are now guesses. The friend entry especially: nothing else
      // in this component would ever correct it, so a tab that loses the race
      // to another one kept a phantom friend until a full page reload.
      fetchFriends()
        .then(setFriends)
        .catch(() => undefined);
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

  const filteredFriends = friends.filter((f) =>
    f.username.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="flex justify-center gap-1 self-center rounded-full bg-neutral-800 p-1">
        <button
          type="button"
          onClick={() => setSubTab("friends")}
          className={`rounded-full px-4 py-1 text-xs transition-colors ${
            subTab === "friends"
              ? "bg-neutral-200 text-black"
              : "text-neutral-300 hover:text-white"
          }`}
        >
          Friends
        </button>
        <button
          type="button"
          onClick={() => setSubTab("requests")}
          className={`flex items-center gap-1.5 rounded-full px-4 py-1 text-xs transition-colors ${
            subTab === "requests"
              ? "bg-neutral-200 text-black"
              : "text-neutral-300 hover:text-white"
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
        <button
          type="button"
          onClick={() => setSubTab("add")}
          aria-label="Add friends"
          title="Add friends"
          className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
            subTab === "add"
              ? "bg-neutral-200 text-black"
              : "text-neutral-300 hover:text-white"
          }`}
        >
          <UserPlusIcon className="h-4 w-4" />
        </button>
      </div>

      {(loadError ?? actionError) && (
        <p className="text-center text-sm text-red-400">{loadError ?? actionError}</p>
      )}

      {subTab === "friends" ? (
        <div className="flex flex-col gap-6">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search friends"
            className="w-full rounded-full bg-neutral-800 px-4 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500"
          />

          <div className="flex flex-col gap-1">
            {filteredFriends.map((friend) => (
              <div
                key={friend.id}
                className="flex items-center gap-3 rounded-2xl px-2 py-2.5 transition-colors hover:bg-neutral-900"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
                  {friend.avatarUrl ? (
                    <img src={friend.avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <PersonIcon className="h-6 w-6 text-neutral-500" />
                  )}
                </span>

                <span className="flex-1 truncate text-sm text-white">@{friend.username}</span>

                <button
                  type="button"
                  onClick={() => handleRemoveFriend(friend)}
                  className="shrink-0 rounded-full bg-neutral-800 px-4 py-1.5 text-xs text-neutral-300 transition-colors hover:text-white"
                >
                  Remove
                </button>
              </div>
            ))}

            {/* Suppressed while `loadError` stands: an empty list there means
                the fetch failed, not that there is nobody to show. */}
            {filteredFriends.length === 0 && !loadError && (
              <p className="pt-8 text-center text-sm text-neutral-500">
                {friends.length === 0 ? "No friends yet." : `No one matches "${query}".`}
              </p>
            )}
          </div>
        </div>
      ) : subTab === "requests" ? (
        <div className="flex flex-col gap-1">
          {requests.map((request) => (
            <div
              key={request.id}
              className="flex items-center gap-3 rounded-2xl px-2 py-2.5 transition-colors hover:bg-neutral-900"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
                {request.avatarUrl ? (
                  <img src={request.avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <PersonIcon className="h-6 w-6 text-neutral-500" />
                )}
              </span>

              <span className="flex-1 truncate text-sm text-white">@{request.username}</span>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleDeclineRequest(request)}
                  className="rounded-full bg-neutral-800 px-4 py-1.5 text-xs text-neutral-300 transition-colors hover:text-white"
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => handleAcceptRequest(request)}
                  className="rounded-full bg-white px-4 py-1.5 text-xs text-black transition-colors hover:opacity-90"
                >
                  Accept
                </button>
              </div>
            </div>
          ))}

          {requests.length === 0 && !loadError && (
            <p className="pt-8 text-center text-sm text-neutral-500">No pending requests.</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <input
            type="text"
            value={discoverQuery}
            onChange={(e) => setDiscoverQuery(e.target.value)}
            placeholder="Search all users"
            className="w-full rounded-full bg-neutral-800 px-4 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500"
          />

          <div className="flex flex-col gap-1">
            {discoverableUsers.map((discoverableUser) => {
              const alreadySent = sentRequests.includes(discoverableUser.id);
              return (
                <div
                  key={discoverableUser.id}
                  className="flex items-center gap-3 rounded-2xl px-2 py-2.5 transition-colors hover:bg-neutral-900"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-300">
                    {discoverableUser.avatarUrl ? (
                      <img
                        src={discoverableUser.avatarUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <PersonIcon className="h-6 w-6 text-neutral-500" />
                    )}
                  </span>

                  <span className="flex-1 truncate text-sm text-white">
                    @{discoverableUser.username}
                  </span>

                  <button
                    type="button"
                    disabled={alreadySent}
                    onClick={() => handleSendFriendRequest(discoverableUser.id)}
                    className={`shrink-0 rounded-full px-4 py-1.5 text-xs transition-colors ${
                      alreadySent
                        ? "bg-neutral-900 text-neutral-500"
                        : "bg-white text-black hover:opacity-90"
                    }`}
                  >
                    {alreadySent ? "Requested" : "Add"}
                  </button>
                </div>
              );
            })}

            {/* `searching` covers both the debounce and the request in flight,
                so "No one matches" is only ever an answer, never a guess. */}
            {discoverableUsers.length === 0 && !searching && (
              <p className="pt-8 text-center text-sm text-neutral-500">
                {discoverQuery.trim()
                  ? `No one matches "${discoverQuery}".`
                  : "Search for someone to add."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

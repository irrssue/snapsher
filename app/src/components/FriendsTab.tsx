import { useEffect, useRef, useState, type ReactNode } from "react";
import { PersonIcon, SearchIcon } from "./icons";
import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  fetchFriendRequests,
  searchUsers,
  sendFriendRequest,
  type FriendRequest,
  type FriendRequestsResponse,
  type SearchUser,
} from "../api/friends";
import type { RequestState } from "../types";

type SubTab = "add" | "requests";

const NO_REQUESTS: FriendRequestsResponse = { incoming: [], outgoing: [] };

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
  const [requests, setRequests] = useState<FriendRequestsResponse>(NO_REQUESTS);
  /** The requests list couldn't be fetched at all — not that there are none. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** One action failed; the lists themselves are still good. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [discoverableUsers, setDiscoverableUsers] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  /**
   * The action handlers below await a request and then write state, and unlike
   * the fetches in effects they have no cleanup function to close over. This is
   * the same `active` guard, held across the whole mount instead.
   */
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  /**
   * Search rows and the requests lists describe the same relationships from two
   * directions, so anything that changes one has to move the other — otherwise
   * accepting from the Requests tab leaves the row behind it still offering
   * "Accept" until the query is retyped.
   */
  function patchRow(userId: number, requestState: RequestState) {
    setDiscoverableUsers((current) =>
      current.map((user) => (user.id === userId ? { ...user, requestState } : user)),
    );
  }

  async function refetchRequests() {
    try {
      const next = await fetchFriendRequests();
      if (mounted.current) {
        setRequests(next);
        setLoadError(null);
      }
      return next;
    } catch {
      // The lists just stay as they are; whatever prompted the refetch has
      // already reported its own failure.
      return null;
    }
  }

  /**
   * A search row knows the *state* of a request but not its id — the id lives
   * on the requests lists this tab already holds. A row acted on before those
   * caught up (a request sent seconds ago from this very screen) sends us back
   * to the server for it rather than failing on a lookup miss.
   */
  async function resolveRequest(
    direction: "incoming" | "outgoing",
    userId: number,
  ): Promise<FriendRequest | null> {
    const known = requests[direction].find((request) => request.userId === userId);
    if (known) return known;
    const fresh = await refetchRequests();
    return fresh?.[direction].find((request) => request.userId === userId) ?? null;
  }

  async function handleSendFriendRequest(id: number) {
    setActionError(null);
    patchRow(id, "outgoing");
    try {
      await sendFriendRequest(id);
      // Picks up the row the server just wrote, so its id is known if the user
      // changes their mind and cancels from this same search result.
      refetchRequests();
    } catch (err) {
      // The button flipping from "Requested" back to "Add" on its own reads as
      // a glitch; say what happened alongside it.
      patchRow(id, "none");
      setActionError(err instanceof Error ? err.message : "Couldn't send that request.");
    }
  }

  async function handleAcceptRequest(request: FriendRequest) {
    setActionError(null);
    setRequests((current) => ({
      ...current,
      incoming: current.incoming.filter((r) => r.id !== request.id),
    }));
    patchRow(request.userId, "friends");
    try {
      await acceptFriendRequest(request.id);
      // The new friend has to show up in the feed and in the friend count
      // without waiting for a reload.
      onFriendsChanged();
    } catch (err) {
      // The server never accepted it, so put the request back rather than
      // leaving the UI asserting an acceptance that never happened.
      refetchRequests();
      patchRow(request.userId, "incoming");
      setActionError(err instanceof Error ? err.message : "Couldn't accept that request.");
    }
  }

  async function handleDeclineRequest(request: FriendRequest) {
    setActionError(null);
    setRequests((current) => ({
      ...current,
      incoming: current.incoming.filter((r) => r.id !== request.id),
    }));
    patchRow(request.userId, "none");
    try {
      await declineFriendRequest(request.id);
    } catch (err) {
      setRequests((current) =>
        current.incoming.some((r) => r.id === request.id)
          ? current
          : { ...current, incoming: [...current.incoming, request] },
      );
      patchRow(request.userId, "incoming");
      setActionError(err instanceof Error ? err.message : "Couldn't decline that request.");
    }
  }

  async function handleCancelRequest(request: FriendRequest) {
    setActionError(null);
    setRequests((current) => ({
      ...current,
      outgoing: current.outgoing.filter((r) => r.id !== request.id),
    }));
    patchRow(request.userId, "none");
    try {
      await cancelFriendRequest(request.id);
    } catch (err) {
      setRequests((current) =>
        current.outgoing.some((r) => r.id === request.id)
          ? current
          : { ...current, outgoing: [...current.outgoing, request] },
      );
      patchRow(request.userId, "outgoing");
      setActionError(err instanceof Error ? err.message : "Couldn't cancel that request.");
    }
  }

  /** Accept/cancel reached from a search row, which has a user id but no request id. */
  async function handleRowRequestAction(
    direction: "incoming" | "outgoing",
    userId: number,
  ) {
    setActionError(null);
    const request = await resolveRequest(direction, userId);
    if (!request) {
      // The other side withdrew it, or it was already answered elsewhere. The
      // refetch inside `resolveRequest` has the truth; re-run the search rather
      // than leave a row promising an action that no longer exists.
      patchRow(userId, "none");
      setActionError("That request no longer exists.");
      return;
    }
    if (direction === "incoming") await handleAcceptRequest(request);
    else await handleCancelRequest(request);
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
          {/* Incoming only: the badge is a count of things waiting on *you*,
              and one of your own sent requests is not that. */}
          {requests.incoming.length > 0 && (
            <span
              className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] ${
                subTab === "requests"
                  ? "bg-black text-white"
                  : "bg-neutral-600 text-white"
              }`}
            >
              {requests.incoming.length}
            </span>
          )}
        </button>
      </div>

      {/*
       * Two lines, not `loadError ?? actionError`. `loadError` is only ever
       * cleared by a successful requests fetch, so once the initial load failed
       * it masked every later action error for the rest of the session — the
       * Add button flipped to "Requested" and back with nothing said.
       */}
      {loadError && <p className="text-center text-sm text-red-400">{loadError}</p>}
      {actionError && <p className="text-center text-sm text-red-400">{actionError}</p>}

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
            {discoverableUsers.map((discoverableUser) => (
              <PersonRow
                key={discoverableUser.id}
                avatarUrl={discoverableUser.avatarUrl}
                username={discoverableUser.username}
                onClick={() => onViewProfile(discoverableUser.id)}
                action={
                  <SearchRowAction
                    user={discoverableUser}
                    onAdd={() => handleSendFriendRequest(discoverableUser.id)}
                    onAccept={() => handleRowRequestAction("incoming", discoverableUser.id)}
                    onCancel={() => handleRowRequestAction("outgoing", discoverableUser.id)}
                  />
                }
              />
            ))}

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
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            {requests.incoming.map((request) => (
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

            {requests.incoming.length === 0 && !loadError && (
              <p className="pt-8 text-center text-sm text-neutral-400">No pending requests.</p>
            )}
          </div>

          {/*
           * Sent requests had no representation anywhere before this: they
           * lived in component state that a reload wiped, while the person
           * they were sent to was filtered out of search — so the honest
           * reading of the app was that they had never been asked.
           */}
          {requests.outgoing.length > 0 && (
            <div className="flex flex-col gap-1">
              <h2 className="px-2 text-xs uppercase tracking-widest text-neutral-500">
                Sent
              </h2>
              {requests.outgoing.map((request) => (
                <PersonRow
                  key={request.id}
                  avatarUrl={request.avatarUrl}
                  username={request.username}
                  onClick={() => onViewProfile(request.userId)}
                  action={
                    <button
                      type="button"
                      onClick={() => handleCancelRequest(request)}
                      className="shrink-0 rounded-full bg-neutral-800 px-4 py-2.5 text-xs text-neutral-300 transition-colors hover:text-white active:text-white"
                    >
                      Cancel
                    </button>
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The right-hand control on a search result, which is now four different things
 * depending on where the two of you already stand. Search used to hide anyone
 * with a request pending in either direction, so this only ever had to be "Add"
 * or a dead "Friends" pill.
 */
function SearchRowAction({
  user,
  onAdd,
  onAccept,
  onCancel,
}: {
  user: SearchUser;
  onAdd: () => void;
  onAccept: () => void;
  onCancel: () => void;
}) {
  if (user.requestState === "friends") {
    return (
      <span className="shrink-0 rounded-full bg-neutral-900 px-4 py-2.5 text-xs text-neutral-500">
        Friends
      </span>
    );
  }

  if (user.requestState === "incoming") {
    return (
      <button
        type="button"
        onClick={onAccept}
        className="shrink-0 rounded-full bg-white px-4 py-2.5 text-xs text-black transition-opacity hover:opacity-90 active:opacity-70"
      >
        Accept
      </button>
    );
  }

  if (user.requestState === "outgoing") {
    return (
      // The state and the way out of it, side by side. A lone "Requested" pill
      // that silently cancelled on tap is the same trap the friends list's
      // unconfirmed "Remove" was.
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs text-neutral-500">Requested</span>
        <button
          type="button"
          onClick={onCancel}
          aria-label={`Cancel friend request to @${user.username}`}
          className="rounded-full bg-neutral-800 px-3 py-2.5 text-xs text-neutral-300 transition-colors hover:text-white active:text-white"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onAdd}
      className="shrink-0 rounded-full bg-white px-4 py-2.5 text-xs text-black transition-opacity hover:opacity-90 active:opacity-70"
    >
      Add
    </button>
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

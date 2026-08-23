import { useState } from "react";
import { PersonIcon, UserPlusIcon } from "./icons";

type Friend = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

type FriendRequest = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

type DiscoverableUser = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

/**
 * TODO: wire these up to real /api/friends, /api/friends/requests, and
 * /api/users search endpoints. Empty until then.
 */
const NO_FRIENDS: Friend[] = [];
const NO_REQUESTS: FriendRequest[] = [];
const NO_USERS: DiscoverableUser[] = [];

type SubTab = "friends" | "requests" | "add";

export function FriendsTab() {
  const [subTab, setSubTab] = useState<SubTab>("friends");
  const [friends, setFriends] = useState(NO_FRIENDS);
  const [requests, setRequests] = useState(NO_REQUESTS);
  const [query, setQuery] = useState("");
  const [discoverQuery, setDiscoverQuery] = useState("");
  const [sentRequests, setSentRequests] = useState<number[]>([]);

  const friendIds = new Set(friends.map((f) => f.id));
  const requestIds = new Set(requests.map((r) => r.id));

  function sendFriendRequest(id: number) {
    setSentRequests((current) => (current.includes(id) ? current : [...current, id]));
  }

  const trimmedDiscoverQuery = discoverQuery.trim().toLowerCase();
  const discoverableUsers = NO_USERS.filter(
    (u) => !friendIds.has(u.id) && !requestIds.has(u.id)
  ).filter((u) => u.username.toLowerCase().includes(trimmedDiscoverQuery));

  function removeFriend(id: number) {
    setFriends((current) => current.filter((f) => f.id !== id));
  }

  function acceptRequest(request: FriendRequest) {
    setRequests((current) => current.filter((r) => r.id !== request.id));
    setFriends((current) => [...current, { id: request.id, username: request.username, avatarUrl: request.avatarUrl }]);
  }

  function declineRequest(id: number) {
    setRequests((current) => current.filter((r) => r.id !== id));
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
                  onClick={() => removeFriend(friend.id)}
                  className="shrink-0 rounded-full bg-neutral-800 px-4 py-1.5 text-xs text-neutral-300 transition-colors hover:text-white"
                >
                  Remove
                </button>
              </div>
            ))}

            {filteredFriends.length === 0 && (
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
                  onClick={() => declineRequest(request.id)}
                  className="rounded-full bg-neutral-800 px-4 py-1.5 text-xs text-neutral-300 transition-colors hover:text-white"
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => acceptRequest(request)}
                  className="rounded-full bg-white px-4 py-1.5 text-xs text-black transition-colors hover:opacity-90"
                >
                  Accept
                </button>
              </div>
            </div>
          ))}

          {requests.length === 0 && (
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
                    onClick={() => sendFriendRequest(discoverableUser.id)}
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

            {discoverableUsers.length === 0 && (
              <p className="pt-8 text-center text-sm text-neutral-500">
                {trimmedDiscoverQuery
                  ? `No one matches "${discoverQuery}".`
                  : "No new people to add right now."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

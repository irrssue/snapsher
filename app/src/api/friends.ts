import { api } from "./http";

export type Friend = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

export type FriendRequest = {
  /** The request's own id — what accept/decline are addressed to. */
  id: number;
  /**
   * The requester's user id. Distinct from `id` above: they come from
   * different tables and collide routinely, so anything that identifies the
   * *person* (the friend list, "Remove") must use this one.
   */
  userId: number;
  username: string;
  avatarUrl: string | null;
};

export async function fetchFriends(): Promise<Friend[]> {
  const { friends } = await api<{ friends: Friend[] }>("/api/friends");
  return friends;
}

export async function fetchFriendRequests(): Promise<FriendRequest[]> {
  const { requests } = await api<{ requests: FriendRequest[] }>("/api/friends/requests");
  return requests;
}

export async function searchUsers(query: string): Promise<Friend[]> {
  const { users } = await api<{ users: Friend[] }>(
    `/api/users/search?q=${encodeURIComponent(query)}`,
  );
  return users;
}

export async function sendFriendRequest(userId: number): Promise<void> {
  await api("/api/friends/requests", { method: "POST", body: { userId } });
}

export async function acceptFriendRequest(requestId: number): Promise<void> {
  await api(`/api/friends/requests/${requestId}/accept`, { method: "POST" });
}

export async function declineFriendRequest(requestId: number): Promise<void> {
  await api(`/api/friends/requests/${requestId}/decline`, { method: "POST" });
}

export async function removeFriend(friendUserId: number): Promise<void> {
  await api(`/api/friends/${friendUserId}`, { method: "DELETE" });
}

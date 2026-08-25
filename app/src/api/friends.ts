import { api } from "./http";
import type { PostSummary } from "../types";

export type Friend = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

export type SearchUser = Friend & { isFriend: boolean };

/**
 * A public profile never carries a friend count or friend status — per
 * `about.md`, only the account owner sees their own friend count.
 */
export type PublicProfile = Friend & { postCount: number };

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

export async function searchUsers(query: string): Promise<SearchUser[]> {
  const { users } = await api<{ users: SearchUser[] }>(
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

export async function fetchUserProfile(userId: number): Promise<PublicProfile> {
  const { user } = await api<{ user: PublicProfile }>(`/api/users/${userId}`);
  return user;
}

/** Backs the Instagram-style grid on a profile screen — own or someone else's. */
export async function fetchUserPosts(userId: number): Promise<PostSummary[]> {
  const { posts } = await api<{ posts: PostSummary[] }>(`/api/users/${userId}/posts`);
  return posts;
}

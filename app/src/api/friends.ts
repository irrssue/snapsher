import { api, expectArray, expectObject } from "./http";
import type {
  Friend,
  FriendRequest,
  FriendRequestsResponse,
  PostSummary,
  PublicProfile,
  SearchUser,
} from "../types";

// Re-exported from here because every component reaches these through the call
// that returns them; the shapes themselves live in `types.ts` beside the rest
// of the wire contract.
export type { Friend, FriendRequest, FriendRequestsResponse, PublicProfile, SearchUser };

export async function fetchFriends(): Promise<Friend[]> {
  const { friends } = await api<{ friends: Friend[] }>("/api/friends");
  return expectArray<Friend>(friends, "friends");
}

/**
 * Both directions in one call. The response used to be a bare array of incoming
 * requests, which left a sent request with nowhere to live but component state
 * — lost on the next reload, while the person it was sent to had also been
 * filtered out of search.
 */
export async function fetchFriendRequests(): Promise<FriendRequestsResponse> {
  const result = await api<FriendRequestsResponse>("/api/friends/requests");
  return {
    incoming: expectArray<FriendRequest>(result?.incoming, "incoming requests"),
    outgoing: expectArray<FriendRequest>(result?.outgoing, "outgoing requests"),
  };
}

export async function searchUsers(query: string): Promise<SearchUser[]> {
  const { users } = await api<{ users: SearchUser[] }>(
    `/api/users/search?q=${encodeURIComponent(query)}`,
  );
  return expectArray<SearchUser>(users, "search results");
}

export async function sendFriendRequest(userId: number): Promise<void> {
  await api("/api/friends/requests", { method: "POST", body: { userId } });
}

export async function acceptFriendRequest(requestId: number): Promise<void> {
  await api(`/api/friends/requests/${requestId}/accept`, { method: "POST" });
}

/**
 * Declining (as the addressee) and cancelling (as the requester) are the same
 * route — the server works out which side is calling and refuses anything whose
 * status is no longer `pending`. Two names because the two are different acts
 * to the person performing them, and the error copy differs accordingly.
 */
export async function declineFriendRequest(requestId: number): Promise<void> {
  await api(`/api/friends/requests/${requestId}`, { method: "DELETE" });
}

export async function cancelFriendRequest(requestId: number): Promise<void> {
  await api(`/api/friends/requests/${requestId}`, { method: "DELETE" });
}

export async function removeFriend(friendUserId: number): Promise<void> {
  await api(`/api/friends/${friendUserId}`, { method: "DELETE" });
}

export async function fetchUserProfile(userId: number): Promise<PublicProfile> {
  const { user } = await api<{ user: PublicProfile }>(`/api/users/${userId}`);
  return expectObject<PublicProfile>(user, "public profile");
}

/**
 * Backs the Instagram-style grid on a profile screen — own or someone else's.
 *
 * Photos are friends-only, so this answers 403 `not_friends` for a stranger's
 * grid. That is a state to render, not an error: see `PublicProfileModal`.
 */
export async function fetchUserPosts(userId: number): Promise<PostSummary[]> {
  const { posts } = await api<{ posts: PostSummary[] }>(`/api/users/${userId}/posts`);
  return expectArray<PostSummary>(posts, "profile grid");
}

export type User = {
  id: number;
  username: string;
  email: string;
  avatarUrl: string | null;
};

export type Post = {
  id: string;
  username: string;
  avatarUrl: string | null;
  photoUrl: string;
  /** Null when the author shared the photo without a description. */
  description: string | null;
  createdAt: number;
  likedByMe: boolean;
  isOwner: boolean;
  /** Only ever present when `isOwner` is true — nobody else can see a like count. */
  likeCount?: number;
  /** Public, unlike likeCount — anyone opening the thread can already see who commented. */
  commentCount: number;
};

/** The shape a profile's post grid needs — no likes or comment counts. */
export type PostSummary = {
  id: string;
  photoUrl: string;
  createdAt: number;
  /** Null when the author shared the photo without a description. */
  description: string | null;
  likedByMe: boolean;
  isOwner: boolean;
  /** Only ever present when `isOwner` is true — nobody else can see a like count. */
  likeCount?: number;
  /** Public, unlike likeCount — anyone opening the thread can already see who commented. */
  commentCount: number;
};

export type Liker = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

export type Comment = {
  id: number;
  username: string;
  avatarUrl: string | null;
  body: string;
  createdAt: number;
  /** Your own comment, or any comment on your own post. */
  canDelete: boolean;
};

export type PostQuota = {
  nextAllowedAt: number;
  /**
   * The server's own clock at the moment it answered. Every countdown in the
   * app is a comparison against `nextAllowedAt`, which is meaningless on a
   * device whose clock disagrees with the server's — so the two are read
   * together once and the difference is carried as an offset.
   *
   * The response also carries a `canPost` boolean, deliberately not declared
   * here: it is only true at the instant it was computed, and the countdown has
   * to stay right for as long as the tab is open.
   */
  serverNow: number;
  postCount: number;
};

/**
 * Where the viewer stands with someone a search turned up. Search no longer
 * hides people with a request pending in either direction — that made a person
 * you had just written to read as "not on Snapsher" after a reload — so every
 * result now says which of the four states it is in and the row renders Add /
 * Accept / Requested / Friends from it.
 */
export type RequestState = "none" | "incoming" | "outgoing" | "friends";

export type Friend = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

export type SearchUser = Friend & { requestState: RequestState };

/**
 * A public profile never carries a friend count or friend status — per
 * `about.md`, only the account owner sees their own friend count.
 */
export type PublicProfile = Friend & { postCount: number };

export type FriendRequest = {
  /** The request's own id — what accept/decline/cancel are addressed to. */
  id: number;
  /**
   * The other person's user id. Distinct from `id` above: they come from
   * different tables and collide routinely, so anything that identifies the
   * *person* (the friend list, "Remove", matching a search row) must use this
   * one.
   */
  userId: number;
  username: string;
  avatarUrl: string | null;
};

/**
 * Both directions, in one response. `outgoing` used to have no representation
 * at all: a sent request lived only in component state, so a reload lost every
 * trace of it and the person it was sent to had vanished from search too.
 */
export type FriendRequestsResponse = {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
};

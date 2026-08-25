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

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
};

export type Liker = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

export type PostQuota = {
  nextAllowedAt: number;
  canPost: boolean;
};

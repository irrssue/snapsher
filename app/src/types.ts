export type User = {
  id: number;
  username: string;
  email: string;
};

export type Post = {
  id: string;
  username: string;
  photoUrl: string;
  /** Null when the author shared the photo without a description. */
  description: string | null;
  createdAt: number;
};

export type PostQuota = {
  nextAllowedAt: number;
  canPost: boolean;
};

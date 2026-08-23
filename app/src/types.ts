export type User = {
  id: number;
  username: string;
  email: string;
};

export type Post = {
  id: string;
  username: string;
  avatarUrl?: string;
  photoUrl?: string;
  description: string;
};

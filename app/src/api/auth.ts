import type { User } from "../types";

export type AuthCredentials = {
  username?: string;
  email: string;
  password: string;
};

async function parseResponse(res: Response): Promise<{ user: User }> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || "Something went wrong. Please try again.");
  }
  return body;
}

export async function signup(credentials: AuthCredentials): Promise<User> {
  const res = await fetch("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(credentials),
  });
  return (await parseResponse(res)).user;
}

export async function login(credentials: AuthCredentials): Promise<User> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(credentials),
  });
  return (await parseResponse(res)).user;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
}

export async function fetchCurrentUser(): Promise<User | null> {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (!res.ok) return null;
  return (await parseResponse(res)).user;
}

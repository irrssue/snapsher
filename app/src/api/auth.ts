import type { User } from "../types";
import { api } from "./http";

export type AuthCredentials = {
  email: string;
  password: string;
};

/**
 * The email-first step. The server either signs the user in outright or tells
 * us the address is free and the flow should move on to picking a username —
 * one request, so an unknown address can't be probed without a password.
 */
export type ContinueResult = { user: User } | { needsUsername: true };

export async function continueWithCredentials(
  credentials: AuthCredentials,
): Promise<ContinueResult> {
  return api<ContinueResult>("/api/auth/continue", {
    method: "POST",
    body: credentials,
  });
}

export async function signup(
  credentials: AuthCredentials & { username: string },
): Promise<User> {
  const { user } = await api<{ user: User }>("/api/auth/signup", {
    method: "POST",
    body: credentials,
  });
  return user;
}

export async function logout(): Promise<void> {
  // A failure here still ends the session locally; the cookie is what matters
  // and the server clears it on any successful call.
  await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
}

export async function updateAvatar(photo: string): Promise<User> {
  const { user } = await api<{ user: User }>("/api/auth/avatar", {
    method: "PUT",
    body: { photo },
  });
  return user;
}

export async function fetchCurrentUser(): Promise<User | null> {
  try {
    const { user } = await api<{ user: User }>("/api/auth/me", {
      silenceSessionExpiry: true,
    });
    return user;
  } catch {
    return null;
  }
}

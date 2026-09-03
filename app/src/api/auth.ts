import type { User } from "../types";
import { api, expectNumber, expectObject } from "./http";

export type AuthCredentials = {
  email: string;
  password: string;
};

/**
 * The email-first step. The server either signs the user in outright or tells
 * us the address is free and the flow should move on to picking a username.
 */
export type ContinueResult = { user: User } | { needsUsername: true };

export async function continueWithCredentials(
  credentials: AuthCredentials,
): Promise<ContinueResult> {
  const result = await api<ContinueResult>("/api/auth/continue", {
    method: "POST",
    body: credentials,
  });
  expectObject<ContinueResult>(result, "continue result");
  if ("user" in result) expectObject<User>(result.user, "signed-in user");
  return result;
}

/**
 * `resendInMs`/`expiresInMs` are fixed server-side durations, not timestamps
 * — a device clock that disagrees with the server's can't throw a countdown
 * off. `token` proves to `verifyEmail`/`resendCode` that this caller is the
 * one who just started (or restarted) this particular sign-up; it's never
 * shown to the user and isn't the 6-digit code.
 */
export type SignupPending = { pending: true; token: string; resendInMs: number; expiresInMs: number };

/**
 * Starts (or restarts) email verification — this no longer creates the
 * account. `verifyEmail` below is what does that.
 */
export async function signup(
  credentials: AuthCredentials & { username: string },
): Promise<SignupPending> {
  const result = await api<SignupPending>("/api/auth/signup", {
    method: "POST",
    body: credentials,
  });
  // Without a token every later step of this sign-up 400s, so a body missing it
  // has to fail here rather than one screen later on the code form.
  expectObject<SignupPending>(result, "pending sign-up");
  expectNumber(result.resendInMs, "pending sign-up resendInMs");
  return result;
}

export async function verifyEmail(input: { email: string; code: string; token: string }): Promise<User> {
  const { user } = await api<{ user: User }>("/api/auth/verify-email", {
    method: "POST",
    body: input,
  });
  return expectObject<User>(user, "verified user");
}

export type ResendResult = { resendInMs: number; expiresInMs: number };

export async function resendCode(input: { email: string; token: string }): Promise<ResendResult> {
  const result = await api<ResendResult>("/api/auth/resend-code", {
    method: "POST",
    body: input,
  });
  expectNumber(result?.resendInMs, "resend result");
  return result;
}

/**
 * Rejects when the server didn't end the session. The failure used to be
 * swallowed while the UI signed out locally anyway — so a log-out during a
 * network blip left the `sid` row alive and the cookie in place, and the next
 * person to open the tab was signed straight back in.
 */
export async function logout(): Promise<void> {
  await api("/api/auth/logout", { method: "POST" });
}

export async function deleteAccount(password: string): Promise<void> {
  await api("/api/auth/account", { method: "DELETE", body: { password } });
}

/**
 * Succeeding here revokes every other session for this account and issues a
 * fresh one for this device — so a password change is also the way to sign a
 * lost or borrowed device out, and this tab stays signed in.
 */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await api("/api/auth/password", { method: "POST", body: input });
}

/**
 * Always resolves for a well-formed address, whether or not it has an account
 * — the response is identical either way, so this can't be used to test who is
 * a member. The UI has to say "if that address has an account" for the same
 * reason.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await api("/api/auth/forgot-password", { method: "POST", body: { email } });
}

/**
 * A reset is the recovery path for a compromised account, so it ends every
 * session including any the attacker holds — and deliberately does not sign the
 * caller in. The client sends them back to the sign-in screen afterwards.
 */
export async function resetPassword(input: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<void> {
  await api("/api/auth/reset-password", { method: "POST", body: input });
}

export async function updateAvatar(photo: string): Promise<User> {
  const { user } = await api<{ user: User }>("/api/auth/avatar", {
    method: "PUT",
    body: { photo },
  });
  return expectObject<User>(user, "updated user");
}

export async function fetchCurrentUser(): Promise<User | null> {
  try {
    const { user } = await api<{ user: User }>("/api/auth/me", {
      silenceSessionExpiry: true,
    });
    return expectObject<User>(user, "current user");
  } catch {
    return null;
  }
}

import crypto from "node:crypto";
import { config } from "./config.js";
import { db, type PasswordResetRow, type PendingSignupRow } from "./db.js";

const upsertStmt = db.prepare(`
  INSERT INTO pending_signups
    (email, username, password_hash, code_hash, token_hash, created_at, expires_at, last_sent_at, attempts, resends)
  VALUES (@email, @username, @password_hash, @code_hash, @token_hash, @created_at, @expires_at, @last_sent_at, 0, 0)
  ON CONFLICT (email) DO UPDATE SET
    username = excluded.username,
    password_hash = excluded.password_hash,
    code_hash = excluded.code_hash,
    token_hash = excluded.token_hash,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at,
    last_sent_at = excluded.last_sent_at,
    attempts = 0,
    resends = 0
`);

const selectStmt = db.prepare("SELECT * FROM pending_signups WHERE email = ?");
const deleteStmt = db.prepare("DELETE FROM pending_signups WHERE email = ?");
const recordAttemptStmt = db.prepare(
  "UPDATE pending_signups SET attempts = attempts + 1 WHERE email = ?",
);
const recordResendStmt = db.prepare(`
  UPDATE pending_signups
  SET code_hash = ?, expires_at = ?, last_sent_at = ?, attempts = 0, resends = resends + 1
  WHERE email = ?
`);
const deleteExpiredStmt = db.prepare("DELETE FROM pending_signups WHERE expires_at <= ?");

/**
 * Opaque, unrelated to the 6-digit code the user types: this is a possession
 * proof for the *row*, handed back only in `/signup`'s own response and never
 * shown to the user or emailed anywhere. `/verify-email` and `/resend-code`
 * require it precisely so a second, unrelated caller who re-runs `/signup`
 * for someone else's address can't act on the row that creates — see the
 * comment on `pending_signups` in db.ts.
 */
export function generateSignupToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashSignupToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Fixed-length hex digests on both sides in practice; the length check keeps a malformed one a clean mismatch instead of a thrown `RangeError`. */
export function pendingSignupTokenMatches(row: PendingSignupRow, token: string): boolean {
  const presented = hashSignupToken(token);
  if (presented.length !== row.token_hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(row.token_hash));
}

/**
 * Starts (or restarts) a pending sign-up. Called from `/signup`, and from a
 * second `/signup` for the same address before it's verified — which is the
 * correct "I lost the email" recovery path, and comes for free from the
 * upsert resetting `attempts`/`resends` to 0. Returns the plaintext token so
 * the caller can hand it back to whoever just requested it; only its hash is
 * ever stored.
 */
export function upsertPendingSignup(row: {
  email: string;
  username: string;
  passwordHash: string;
  codeHash: string;
  now: number;
}): string {
  const token = generateSignupToken();
  upsertStmt.run({
    email: row.email,
    username: row.username,
    password_hash: row.passwordHash,
    code_hash: row.codeHash,
    token_hash: hashSignupToken(token),
    created_at: row.now,
    expires_at: row.now + config.verification.codeTtlMs,
    last_sent_at: row.now,
  });
  return token;
}

export function findPendingSignup(email: string): PendingSignupRow | undefined {
  return selectStmt.get(email) as PendingSignupRow | undefined;
}

export function deletePendingSignup(email: string): void {
  deleteStmt.run(email);
}

/** Returns the row's attempt count *after* incrementing, so the caller can decide whether it just ran out. */
export function recordVerifyAttempt(email: string): number {
  recordAttemptStmt.run(email);
  return (selectStmt.get(email) as PendingSignupRow | undefined)?.attempts ?? config.verification.maxAttempts;
}

export function recordResend(row: { email: string; codeHash: string; now: number }): void {
  recordResendStmt.run(row.codeHash, row.now + config.verification.codeTtlMs, row.now, row.email);
}

/**
 * Password resets, on the same discipline as pending sign-ups above: one live
 * code per address, stored as a hash bound to that address, with `expires_at`
 * and `attempts` doing the real work of bounding guesses.
 *
 * Upserting rather than refusing a second `/forgot-password` is deliberate and
 * safe here in a way it needed a possession token to be safe for sign-up: this
 * row names an account that already exists, and every code for it goes to that
 * account's own inbox. A second caller re-running the flow can only cause the
 * real owner to receive another code — it cannot make the row completable by
 * anyone who isn't reading that inbox.
 */
const upsertResetStmt = db.prepare(`
  INSERT INTO password_resets
    (email, user_id, code_hash, created_at, expires_at, last_sent_at, attempts)
  VALUES (@email, @user_id, @code_hash, @created_at, @expires_at, @last_sent_at, 0)
  ON CONFLICT (email) DO UPDATE SET
    user_id = excluded.user_id,
    code_hash = excluded.code_hash,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at,
    last_sent_at = excluded.last_sent_at,
    attempts = 0
`);

const selectResetStmt = db.prepare("SELECT * FROM password_resets WHERE email = ?");
const deleteResetStmt = db.prepare("DELETE FROM password_resets WHERE email = ?");
const deleteResetsForUserStmt = db.prepare("DELETE FROM password_resets WHERE user_id = ?");
const recordResetAttemptStmt = db.prepare(
  "UPDATE password_resets SET attempts = attempts + 1 WHERE email = ?",
);
const deleteExpiredResetsStmt = db.prepare("DELETE FROM password_resets WHERE expires_at <= ?");

export function upsertPasswordReset(row: {
  email: string;
  userId: number;
  codeHash: string;
  now: number;
}): void {
  upsertResetStmt.run({
    email: row.email,
    user_id: row.userId,
    code_hash: row.codeHash,
    created_at: row.now,
    expires_at: row.now + config.verification.codeTtlMs,
    last_sent_at: row.now,
  });
}

export function findPasswordReset(email: string): PasswordResetRow | undefined {
  return selectResetStmt.get(email) as PasswordResetRow | undefined;
}

export function deletePasswordReset(email: string): void {
  deleteResetStmt.run(email);
}

/**
 * Called when a password changes by any other route. A reset code outstanding
 * at that moment was minted against a password that no longer exists, and
 * leaving it live would mean an old code — possibly the very one an attacker
 * asked for — still able to take the account over after the owner had already
 * secured it.
 */
export function deletePasswordResetsForUser(userId: number): void {
  deleteResetsForUserStmt.run(userId);
}

/** Returns the row's attempt count *after* incrementing, mirroring `recordVerifyAttempt`. */
export function recordResetAttempt(email: string): number {
  recordResetAttemptStmt.run(email);
  return (
    (selectResetStmt.get(email) as PasswordResetRow | undefined)?.attempts ??
    config.verification.maxAttempts
  );
}

/**
 * Keeps both short-lived tables from growing without bound on a long-running
 * process, same shape as `startSessionSweeper`. They are swept together because
 * they expire on the same clock and for the same reason: a code nobody used is
 * a hash of a live secret sitting in a file that gets backed up.
 */
export function startVerificationSweeper() {
  const sweep = () => {
    const now = Date.now();
    deleteExpiredStmt.run(now);
    deleteExpiredResetsStmt.run(now);
  };
  sweep();
  const timer = setInterval(sweep, 60 * 60 * 1000);
  timer.unref();
}

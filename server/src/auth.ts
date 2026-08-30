import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { db, isUniqueConstraintError, type PostRow, type UserRow } from "./db.js";
import { createLockout, rateLimit, rejectLocked } from "./rateLimit.js";
import { asyncRoute } from "./security.js";
import { endSession, requireAuth, startSession, toPublicUser } from "./sessions.js";
import { avatarsDir } from "./avatarsStore.js";
import { uploadsDir } from "./postsStore.js";
import { codeHashMatches, generateCode, hashCode, sendVerificationEmail } from "./email.js";
import {
  deletePendingSignup,
  findPendingSignup,
  pendingSignupTokenMatches,
  recordResend,
  recordVerifyAttempt,
  upsertPendingSignup,
} from "./verificationStore.js";
import {
  carriesExifMetadata,
  EXTENSION_BY_FORMAT,
  PHOTO_DATA_URL_RE,
  sniffFormat,
  withinPixelBudget,
  type ImageFormat,
} from "./images.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
/** Six digits, matching `generateCode` in email.ts — see the arithmetic there. */
const CODE_RE = /^\d{6}$/;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
/** bcrypt only reads the first 72 bytes; the cap keeps the rest from being a silent lie. */
const MAX_PASSWORD_LENGTH = 128;

/**
 * Compared against when no account matches, so a sign-in attempt for an
 * unknown address costs the same time as one for a real address. Without it
 * the response time alone answers "does this email have an account?".
 */
const DUMMY_HASH = bcrypt.hashSync("password-that-never-matches", config.bcryptCost);

const INVALID_CREDENTIALS = {
  error: "Invalid email or password.",
  code: "invalid_credentials",
} as const;

const lockoutByIp = createLockout(config.lockout.perIp);
const lockoutByAccount = createLockout(config.lockout.perAccount);
const lockoutByVerifyIp = createLockout(config.lockout.verifyCode);

/**
 * Wrong codes counted against the *address* being verified, not the caller.
 *
 * Everything else that counts guesses is destroyed by the thing it is meant to
 * bound: five wrong codes delete the pending row (see `/verify-email` below),
 * and re-running `/signup` writes a fresh one with `attempts = 0`. So nothing
 * stored in the database can count guesses across that restart — the loop
 * "guess five times, restart sign-up, guess five more" resets its own counter
 * every time. This one lives in memory, outlives the row, and is keyed on the
 * address rather than the source, so rotating IPs doesn't shed it either.
 *
 * Note the tradeoff config.ts:lockout warns about — an address-keyed lock is a
 * lever an attacker can pull against a victim. Here it can only stall a
 * *sign-up* for the lock window; it is not consulted on `/continue`, so it can
 * never keep an existing account's owner out of their own account.
 */
const lockoutByVerifyEmail = createLockout(config.lockout.verifyCode);

/**
 * Budget for outbound verification mail, keyed on the destination address.
 *
 * `/signup` is unauthenticated and makes this server deliver mail to whatever
 * address the caller names. The per-row resend cooldown does not bound that:
 * it is only consulted while a live pending row exists, and the caller can
 * guarantee one doesn't by burning its attempts or letting it expire. The
 * `signUp` limiter is per-IP, so rotating sources sheds it too. Keyed on the
 * address, this survives both, and caps any one victim's inbox — and the
 * sender reputation of the domain those mails come from — regardless of where
 * the requests originate.
 */
const sendBudgetByEmail = createLockout(config.lockout.verificationSend);

/**
 * Every failure mode of `/verify-email` and `/resend-code` that isn't a wrong
 * code collapses to this one response. A wrong code is answered on its own
 * (401, with an attempts-left count), but "no such pending sign-up", "it
 * expired", and "attempts/resends are used up" all look identical on purpose
 * — none of them may tell a caller whether a pending sign-up for some address
 * exists at all.
 */
function pendingSignupGone(res: Response) {
  return res.status(410).json({
    error: "That code has expired. Start again to get a new one.",
    code: "signup_expired",
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email) as
    | UserRow
    | undefined;
}

type PasswordCheck = { ok: true; value: string } | { ok: false; error: string };

function validatePassword(password: unknown): PasswordCheck {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.` };
  }
  return { ok: true, value: password };
}

/**
 * Rejects "ada@example.com" / "ada1234567". The minimum length matters: a
 * two-letter local part or a short username appears inside almost any password
 * by coincidence, and rejecting those would be indistinguishable from the rule
 * being broken — especially since this runs on the username step, after the
 * password was typed on the previous screen.
 */
const MIN_IDENTITY_FRAGMENT = 4;

function passwordEchoesIdentity(password: string, username: string, email: string): boolean {
  const lowered = password.toLowerCase();
  return [username.toLowerCase(), email.split("@")[0]].some(
    (fragment) => fragment.length >= MIN_IDENTITY_FRAGMENT && lowered.includes(fragment),
  );
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** Quietly moves an old low-cost hash up to the current cost on a good sign-in. */
async function upgradeHashIfStale(user: UserRow, password: string) {
  const cost = Number(user.password_hash.split("$")[2]);
  if (!Number.isFinite(cost) || cost >= config.bcryptCost) return;
  try {
    const rehashed = await bcrypt.hash(password, config.bcryptCost);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(rehashed, user.id);
  } catch (err) {
    console.warn("[auth] password hash upgrade failed", err);
  }
}

export const authRouter = Router();

/** Small bodies only: credentials and a username, never a photo. */
const smallJsonBody = express.json({ limit: "16kb" });

/**
 * One request handles both halves of the email-first flow: known address plus
 * correct password signs in, unknown address advances to the username step.
 *
 * That an address is unknown is unavoidably observable — the flow's entire
 * premise is telling the user which branch they're on. Folding the check into
 * the password step at least means enumeration costs a full sign-in attempt
 * and is bounded by the same limiter, instead of sitting behind a free,
 * password-less endpoint that could be walked through a mailing list.
 */
authRouter.post(
  "/continue",
  rateLimit(config.rateLimits.signIn),
  smallJsonBody,
  asyncRoute(async (req, res) => {
    const { email, password } = req.body ?? {};

    if (typeof email !== "string" || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof password !== "string" || password.length === 0) {
      return res.status(400).json({ error: "Enter your password." });
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    const normalized = normalizeEmail(email);
    // The address half of this key is chosen by an unauthenticated caller and
    // may be 254 characters. Truncating it bounds what one entry in the
    // lockout map can be padded to; no real address is anywhere near this, and
    // two that share a 64-character prefix only ever share a failure counter.
    const perIpKey = `${normalized.slice(0, 64)}|${req.ip ?? "unknown"}`;

    // Only the per-IP lock refuses outright. It is scoped to one account from
    // one address, so the only person it can shut out is whoever produced the
    // failures. The account-wide lock is deliberately *not* consulted here —
    // see below, and the rationale in config.ts.
    const perIpLockedFor = lockoutByIp.retryAfterMs(perIpKey);
    if (perIpLockedFor > 0) return rejectLocked(res, perIpLockedFor);

    const user = findUserByEmail(normalized);
    if (!user) {
      // Keep the timing in line with the branch that does hash a password.
      await verifyPassword(password, DUMMY_HASH);
      // ...and keep the *cost* in line with it too. Which branch you landed on
      // is unavoidably visible — the flow's whole premise is telling the user
      // whether they're signing in or signing up — so the defence can't be to
      // hide it, only to make finding out as expensive as guessing a password.
      // Without this, a mailing list could be walked for free forever.
      lockoutByIp.recordFailure(perIpKey);

      // The password rules are checked here, on the branch that is about to
      // create an account, so "Password must be at least 8 characters" is
      // answered while the password field is still on screen. Left to /signup
      // it surfaces on the username step, which has no password field to fix.
      const checked = validatePassword(password);
      if (!checked.ok) return res.status(400).json({ error: checked.error });

      return res.json({ needsUsername: true });
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      lockoutByIp.recordFailure(perIpKey);
      lockoutByAccount.recordFailure(normalized);

      // A wrong password under the account-wide lock is still refused, and
      // says so; a correct one, checked above, is not affected by that lock at
      // all. That asymmetry is the point: the lock has to be unable to keep
      // the account's own owner out.
      const accountLockedFor = lockoutByAccount.retryAfterMs(normalized);
      if (accountLockedFor > 0) return rejectLocked(res, accountLockedFor);

      return res.status(401).json(INVALID_CREDENTIALS);
    }

    // Proving the password clears both counters. Only the address that proved
    // it gets the per-IP counter reset, so a successful sign-in can't be used
    // to wipe an attacker's slate at some other address — but the account-wide
    // counter has to go, or an attacker's failures accumulate on the owner's
    // account with nothing but a restart able to remove them.
    lockoutByIp.clear(perIpKey);
    lockoutByAccount.clear(normalized);
    await upgradeHashIfStale(user, password);
    startSession(req, res, user.id);
    res.json({ user: toPublicUser(user) });
  }),
);

authRouter.post(
  "/signup",
  rateLimit(config.rateLimits.signUp),
  smallJsonBody,
  asyncRoute(async (req, res) => {
    const { username, email, password } = req.body ?? {};

    if (typeof username !== "string" || !USERNAME_RE.test(username.trim())) {
      return res.status(400).json({
        error:
          "Username must be 3-20 characters and contain only letters, numbers, and underscores.",
      });
    }
    if (
      typeof email !== "string" ||
      email.length > MAX_EMAIL_LENGTH ||
      !EMAIL_RE.test(email.trim())
    ) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    const checked = validatePassword(password);
    if (!checked.ok) return res.status(400).json({ error: checked.error });

    const trimmedUsername = username.trim();
    const normalizedEmail = normalizeEmail(email);

    if (passwordEchoesIdentity(checked.value, trimmedUsername, normalizedEmail)) {
      return res.status(400).json({
        error: "Choose a password that doesn't contain your username or email address.",
      });
    }

    // Checked before the uniqueness lookup below, not just before the send, so
    // that asking "does this address have an account here?" costs the same
    // budget as mailing it. This route is the only place that answers that
    // question without a password.
    const sendBudgetLockedFor = sendBudgetByEmail.retryAfterMs(normalizedEmail);
    if (sendBudgetLockedFor > 0) return rejectLocked(res, sendBudgetLockedFor);

    // The email and username halves of the old single lookup are separated so
    // only the email half charges that budget. A taken *username* is something
    // a real signer-upper hits several times in a row while picking one, and
    // must not use up their address's budget; a taken *email* is the answer to
    // the enumeration question above, and must. The response is identical
    // either way, so nothing new is disclosed by the split.
    const emailTaken = db
      .prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE")
      .get(normalizedEmail);
    if (emailTaken) {
      sendBudgetByEmail.recordFailure(normalizedEmail);
      return res.status(409).json({ error: "Username or email is already taken." });
    }

    const usernameTaken = db
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .get(trimmedUsername);
    if (usernameTaken) {
      return res.status(409).json({ error: "Username or email is already taken." });
    }

    // Re-running /signup for an address with a live pending row is the "I lost
    // the email" recovery path, and is deliberately allowed to hand back a
    // fresh code — but without this check it's also a way to re-send as fast
    // as the signUp rate limit allows, ignoring the resend cooldown entirely.
    // Same cooldown window as /resend-code, checked the same way.
    const now = Date.now();
    const existingPending = findPendingSignup(normalizedEmail);
    if (existingPending && existingPending.expires_at > now) {
      const cooldownEndsAt = existingPending.last_sent_at + config.verification.resendCooldownMs;
      if (cooldownEndsAt > now) {
        const retryAfter = Math.max(1, Math.ceil((cooldownEndsAt - now) / 1000));
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({
          error: "Wait a moment before asking for another code.",
          code: "resend_cooldown",
          retryAfter,
        });
      }
    }

    const passwordHash = await bcrypt.hash(checked.value, config.bcryptCost);
    const code = generateCode();

    // Sent before anything is written: an email cannot be un-sent, so the
    // write has to be the last thing that can fail. A failed send this way
    // leaves no orphan row, starts no cooldown, and the caller is never told a
    // code is on its way when it isn't.
    const sent = await sendVerificationEmail(normalizedEmail, code);
    if (!sent.ok) {
      return res.status(502).json({
        error: "We couldn't send a code to that address right now. Please try again in a moment.",
        code: "email_send_failed",
      });
    }
    // Charged only once a mail actually went out, so a provider outage can't
    // spend a legitimate signer-upper's budget on messages they never received.
    sendBudgetByEmail.recordFailure(normalizedEmail);

    // Upserting rather than requiring a fresh address is deliberate: running
    // /signup again for the same pending address is the "I lost the email"
    // recovery path, and replacing the row here — rather than rejecting a
    // second attempt — is what gives that path a fresh code and a clean
    // attempt/resend count for free. It also rotates the token below, which is
    // exactly what stops that same replace-the-row behaviour from being used
    // to hijack someone *else's* pending sign-up — see the comment on
    // `pending_signups` in db.ts.
    const token = upsertPendingSignup({
      email: normalizedEmail,
      username: trimmedUsername,
      passwordHash,
      codeHash: hashCode(normalizedEmail, code),
      now,
    });

    res.status(202).json({
      pending: true,
      token,
      resendInMs: config.verification.resendCooldownMs,
      expiresInMs: config.verification.codeTtlMs,
    });
  }),
);

/**
 * The step that actually creates the account. Everything up through the
 * uniqueness check mirrors what `/signup` used to do inline, re-run here
 * because time has passed since the pending row was parked and either the
 * username or the email could have been claimed by someone else in the
 * meantime.
 */
authRouter.post(
  "/verify-email",
  rateLimit(config.rateLimits.verifyEmail),
  smallJsonBody,
  asyncRoute(async (req, res) => {
    const { email, code, token } = req.body ?? {};

    if (typeof email !== "string" || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof code !== "string" || !CODE_RE.test(code)) {
      return res.status(400).json({ error: "Enter the 6-digit code." });
    }

    const normalizedEmail = normalizeEmail(email);

    // Two counters, because the per-row attempt cap just below covers neither
    // case: it kills *one* pending sign-up after five wrong codes, and a fresh
    // /signup replaces the row with a clean one. The IP-keyed lock catches
    // restarting sign-up from one source to buy another batch of guesses; the
    // address-keyed one catches the same loop run from many sources against a
    // single target address. See the note on `lockoutByVerifyEmail` above.
    const lockedFor = lockoutByVerifyIp.retryAfterMs(req.ip ?? "unknown");
    if (lockedFor > 0) return rejectLocked(res, lockedFor);

    const emailLockedFor = lockoutByVerifyEmail.retryAfterMs(normalizedEmail);
    if (emailLockedFor > 0) return rejectLocked(res, emailLockedFor);

    const pending = findPendingSignup(normalizedEmail);
    if (!pending || pending.expires_at <= Date.now()) return pendingSignupGone(res);

    // Proves this caller — not just anyone who knows the address — is the one
    // who most recently called /signup for it. Without this, a second,
    // unrelated /signup for the same address (which upserts the row) could be
    // completed by whoever made *that* call, not the original requester. See
    // the comment on `pending_signups` in db.ts.
    if (typeof token !== "string" || !pendingSignupTokenMatches(pending, token)) {
      return pendingSignupGone(res);
    }

    const submittedHash = hashCode(normalizedEmail, code);
    if (!codeHashMatches(pending.code_hash, submittedHash)) {
      lockoutByVerifyIp.recordFailure(req.ip ?? "unknown");
      lockoutByVerifyEmail.recordFailure(normalizedEmail);
      const attempts = recordVerifyAttempt(normalizedEmail);
      if (attempts >= config.verification.maxAttempts) {
        // Deleted, not merely locked: the row is self-healing this way — the
        // user restarts sign-up and gets a fresh code, rather than the row
        // sitting there unusable until it expires on its own.
        deletePendingSignup(normalizedEmail);
        return pendingSignupGone(res);
      }
      return res.status(401).json({
        error: "That code isn't right.",
        code: "invalid_code",
        attemptsLeft: config.verification.maxAttempts - attempts,
      });
    }

    // Neither lock is cleared on success. The IP-keyed one must not be:
    // clearing it here would let anyone wipe their accumulated failures against
    // *other* addresses just by finishing one unrelated sign-up — the exact
    // hole `/continue`'s lockout avoids by keying on `email|ip` instead. The
    // address-keyed one has nothing to clear for: this address now has an
    // account, so it can never reach a pending sign-up again. Letting both age
    // out of their window is enough.

    const stillFree = db
      .prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE")
      .get(pending.email, pending.username);
    if (stillFree) {
      deletePendingSignup(normalizedEmail);
      return res.status(409).json({ error: "Username or email is already taken.", code: "identity_taken" });
    }

    let user: UserRow;
    try {
      const result = db
        .prepare(
          "INSERT INTO users (username, email, password_hash, email_verified_at) VALUES (?, ?, ?, ?)",
        )
        .run(pending.username, pending.email, pending.password_hash, Date.now());
      user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid) as UserRow;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      deletePendingSignup(normalizedEmail);
      return res.status(409).json({ error: "Username or email is already taken.", code: "identity_taken" });
    }

    deletePendingSignup(normalizedEmail);
    startSession(req, res, user.id);
    res.status(201).json({ user: toPublicUser(user) });
  }),
);

authRouter.post(
  "/resend-code",
  rateLimit(config.rateLimits.resendCode),
  smallJsonBody,
  asyncRoute(async (req, res) => {
    const { email, token } = req.body ?? {};

    if (typeof email !== "string" || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    const normalizedEmail = normalizeEmail(email);
    const pending = findPendingSignup(normalizedEmail);
    if (!pending || pending.expires_at <= Date.now()) return pendingSignupGone(res);

    // Same possession check as /verify-email — see the comment there and on
    // `pending_signups` in db.ts.
    if (typeof token !== "string" || !pendingSignupTokenMatches(pending, token)) {
      return pendingSignupGone(res);
    }

    const now = Date.now();
    const cooldownEndsAt = pending.last_sent_at + config.verification.resendCooldownMs;
    if (cooldownEndsAt > now) {
      const retryAfter = Math.max(1, Math.ceil((cooldownEndsAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Wait a moment before asking for another code.",
        code: "resend_cooldown",
        retryAfter,
      });
    }

    // Four emails total per pending sign-up (the original send plus three of
    // these). Rather than a distinct "you're out of resends" response, this
    // folds into the same self-healing shape as attempts running out: the row
    // is gone, and starting sign-up over gets a clean slate.
    if (pending.resends >= config.verification.maxResends) {
      deletePendingSignup(normalizedEmail);
      return pendingSignupGone(res);
    }

    // The same address-keyed budget `/signup` spends from, so the two routes
    // can't be alternated to double the mail one address receives.
    const sendBudgetLockedFor = sendBudgetByEmail.retryAfterMs(normalizedEmail);
    if (sendBudgetLockedFor > 0) return rejectLocked(res, sendBudgetLockedFor);

    const code = generateCode();
    const sent = await sendVerificationEmail(normalizedEmail, code);
    if (!sent.ok) {
      return res.status(502).json({
        error: "We couldn't send a code to that address right now. Please try again in a moment.",
        code: "email_send_failed",
      });
    }
    sendBudgetByEmail.recordFailure(normalizedEmail);

    recordResend({ email: normalizedEmail, codeHash: hashCode(normalizedEmail, code), now });
    res.status(202).json({
      resendInMs: config.verification.resendCooldownMs,
      expiresInMs: config.verification.codeTtlMs,
    });
  }),
);

authRouter.post("/logout", (req, res) => {
  endSession(req, res);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.auth!.user });
});

const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

authRouter.put(
  "/avatar",
  requireAuth,
  rateLimit(config.rateLimits.updateAvatar),
  // Arrives as a base64 data URL in the JSON body, same as a post's photo.
  express.json({ limit: "6mb" }),
  asyncRoute(async (req, res) => {
    const { photo } = req.body ?? {};

    if (typeof photo !== "string") {
      return res.status(400).json({ error: "A photo is required." });
    }

    const match = PHOTO_DATA_URL_RE.exec(photo);
    if (!match) {
      return res.status(400).json({ error: "That file isn't a supported image." });
    }

    const [, declaredFormat, base64] = match;
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength === 0) {
      return res.status(400).json({ error: "That photo appears to be empty." });
    }
    if (bytes.byteLength > MAX_AVATAR_BYTES) {
      return res.status(413).json({ error: "That photo is too large." });
    }
    if (sniffFormat(bytes) !== declaredFormat) {
      return res.status(400).json({ error: "That file isn't a supported image." });
    }
    // Same two header-only checks as a post's photo, and the same 400 — see
    // the comment in posts.ts and the reasoning in images.ts. The blast radius
    // is larger here: an avatar renders in the feed, on profiles, in the likers
    // popover and beside every comment.
    if (
      !withinPixelBudget(bytes, declaredFormat as ImageFormat) ||
      carriesExifMetadata(bytes, declaredFormat as ImageFormat)
    ) {
      return res.status(400).json({ error: "That file isn't a supported image." });
    }

    const user = req.auth!.user;
    const previousAvatarFile = (
      db.prepare("SELECT avatar_file FROM users WHERE id = ?").get(user.id) as
        | Pick<UserRow, "avatar_file">
        | undefined
    )?.avatar_file;

    const avatarFile = `${crypto.randomUUID()}.${EXTENSION_BY_FORMAT[declaredFormat as ImageFormat]}`;
    const avatarPath = path.join(avatarsDir, avatarFile);
    // Written asynchronously: a synchronous write of up to 4 MB blocks the
    // event loop for its whole duration, which stalls every other request in
    // flight — including the feed loads of everyone else on the server.
    await fs.promises.writeFile(avatarPath, bytes, { mode: 0o640 });

    try {
      db.prepare("UPDATE users SET avatar_file = ? WHERE id = ?").run(avatarFile, user.id);
    } catch (err) {
      // Don't leave an orphaned file behind if the row never landed — nothing
      // else ever refers to this filename, so it would sit there forever.
      await fs.promises.rm(avatarPath, { force: true });
      throw err;
    }

    // Only once the row points at the new file is the old one unreferenced and
    // safe to drop.
    if (previousAvatarFile) {
      await fs.promises.rm(path.join(avatarsDir, previousAvatarFile), { force: true });
    }

    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
    res.json({ user: toPublicUser(updated) });
  }),
);

/**
 * Requires the password again rather than trusting the session alone: the
 * session already proves "signed in", but a browser left unlocked or a
 * hijacked tab shouldn't be enough on its own to permanently destroy an
 * account. Same rate limiter shape as `/continue` for the same reason — this
 * is a password-guessing surface too.
 */
authRouter.delete(
  "/account",
  requireAuth,
  rateLimit(config.rateLimits.deleteAccount),
  smallJsonBody,
  asyncRoute(async (req, res) => {
    const { password } = req.body ?? {};
    if (typeof password !== "string" || password.length === 0) {
      return res.status(400).json({ error: "Enter your password to confirm." });
    }

    // The row can be gone between `attachSession` resolving it and this handler
    // running — the same account deleted from a second tab does exactly that.
    // Without the guard the cast below is a lie and the password check throws a
    // TypeError, which reaches the client as a 500 and buries a real fault in
    // the log behind noise.
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.auth!.user.id) as
      | UserRow
      | undefined;
    if (!user) {
      endSession(req, res);
      return res.status(401).json({ error: "Please sign in.", code: "not_authenticated" });
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    const photoFiles = (
      db.prepare("SELECT photo_file FROM posts WHERE user_id = ?").all(user.id) as Pick<
        PostRow,
        "photo_file"
      >[]
    ).map((row) => row.photo_file);

    // The row going away cascades to sessions, posts, likes, comments, and
    // friend requests (see the ON DELETE CASCADE clauses in db.ts) — only the
    // files those posts and the avatar point to live outside the database and
    // need cleaning up by hand, below.
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);

    await Promise.all([
      ...(user.avatar_file
        ? [fs.promises.rm(path.join(avatarsDir, user.avatar_file), { force: true })]
        : []),
      ...photoFiles.map((file) => fs.promises.rm(path.join(uploadsDir, file), { force: true })),
    ]);

    endSession(req, res);
    res.status(204).end();
  }),
);

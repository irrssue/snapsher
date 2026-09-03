import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { db, isUniqueConstraintError, type PostRow, type UserRow } from "./db.js";
import { authenticatedKey, createLockout, rateLimit, rejectLocked } from "./rateLimit.js";
import { asyncRoute } from "./security.js";
import {
  endSession,
  requireAuth,
  revokeAllSessions,
  startSession,
  toPublicUser,
} from "./sessions.js";
import { avatarsDir } from "./avatarsStore.js";
import { uploadsDir } from "./postsStore.js";
import {
  codeHashMatches,
  generateCode,
  hashCode,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "./email.js";
import { COMMON_PASSWORDS } from "./passwordDenylist.js";
import {
  deletePasswordReset,
  deletePasswordResetsForUser,
  deletePendingSignup,
  findPasswordReset,
  findPendingSignup,
  pendingSignupTokenMatches,
  recordResend,
  recordResetAttempt,
  recordVerifyAttempt,
  upsertPasswordReset,
  upsertPendingSignup,
} from "./verificationStore.js";
import {
  stripMetadata,
  EXTENSION_BY_FORMAT,
  PHOTO_DATA_URL_RE,
  sniffFormat,
  withinPixelBudget,
  type ImageFormat,
} from "./images.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * `EMAIL_RE`'s `\s` covers space, tab and the newlines — but not NUL, and not
 * most of C0 or DEL. A NUL-bearing address passed every check and then became
 * the primary key of `pending_signups` and the value in `users.email`: a string
 * that compares unequal to the address a human would read it as, that truncates
 * at the NUL in anything C-shaped downstream, and that goes into the `to` field
 * of an outbound mail. There is no legitimate address containing any of these.
 */
const EMAIL_CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
/** Six digits, matching `generateCode` in email.ts — see the arithmetic there. */
const CODE_RE = /^\d{6}$/;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
/**
 * The character cap, which is about the request rather than about bcrypt —
 * `MAX_PASSWORD_BYTES` below is the one that matters for hashing.
 */
const MAX_PASSWORD_LENGTH = 128;
/**
 * bcrypt reads 72 *bytes*, not 72 characters, and silently discards the rest.
 * The old cap counted characters, so 19 emoji is 76 bytes: everything past byte
 * 72 was thrown away, and the user was never told that the tail of the password
 * they chose is decorative. Worse, two different long passwords sharing a
 * 72-byte prefix are the same password to bcrypt. Refusing is the honest
 * answer; silently truncating a credential is not.
 */
const MAX_PASSWORD_BYTES = 72;

/**
 * Every place an address is accepted from a request body. Rejects the shape,
 * the length and the control characters together so the four routes that take
 * an email can't drift apart on which of the three they check.
 */
function isAcceptableEmail(email: unknown): email is string {
  return (
    typeof email === "string" &&
    email.length <= MAX_EMAIL_LENGTH &&
    !EMAIL_CONTROL_CHARS_RE.test(email) &&
    EMAIL_RE.test(email.trim())
  );
}

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
 * `/continue` landing on an address with no account — the first step of every
 * sign-up, and therefore a *success*, not a failure.
 *
 * This used to be charged to `lockoutByIp` alongside genuine wrong-password
 * events, which meant new users were locked out of registering. Five taps
 * through an ordinary sign-up reach it: "use a different email" back-navigation
 * keeps the credentials so it is one tap, an expired code sends you round
 * again, a taken username sends you back too. And `lockoutByIp` is only ever
 * cleared by a successful *sign-in*, which an address with no account cannot
 * produce — so the lock stood for its full fifteen minutes against someone who
 * had got nothing wrong.
 *
 * Split out rather than dropped. The branch still has to cost something, or a
 * mailing list can be walked for free; it is just that the right budget for
 * "how many sign-ups is one address plausibly starting" is nothing like the
 * right budget for "how many wrong passwords". Keyed on the source alone, not
 * `email|ip`, because what it is counting is one source probing many addresses
 * — per-address it would never reach its threshold at all.
 */
const lockoutBySignUpProbe = createLockout(config.lockout.signUpProbe);

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
 * The same budget shape for reset mail, but a *separate* counter.
 *
 * Sharing one would cap a single address at four mails an hour across both
 * flows, which sounds stricter and is worse: anyone can spend a stranger's
 * sign-up budget by repeatedly running `/signup` for their address, and if that
 * budget were shared, doing so would also block that person's password reset —
 * turning a nuisance into a denial of account recovery. Two counters means the
 * worst an attacker can do to one flow is exhaust that flow.
 */
const resetSendBudgetByEmail = createLockout(config.lockout.verificationSend);

/**
 * Wrong reset codes, counted twice on exactly the reasoning `/verify-email`
 * gives: once against the source, which catches one caller walking many
 * addresses, and once against the address being reset, which catches many
 * sources walking one target. The per-row attempt cap can't do either job on
 * its own, because re-running `/forgot-password` replaces the row that carries
 * it.
 *
 * The address-keyed half is a lever an attacker can pull against a victim — it
 * can stall someone's password reset for the lock window. That is the same
 * trade `lockoutByVerifyEmail` makes, and acceptable for the same reason: it
 * cannot touch `/continue`, so a user who still knows their password is never
 * kept out of their own account by it.
 */
const lockoutByResetIp = createLockout(config.lockout.verifyCode);
const lockoutByResetEmail = createLockout(config.lockout.verifyCode);

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

const selectUserByEmail = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE");
const selectUserById = db.prepare("SELECT * FROM users WHERE id = ?");
const updatePasswordHash = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");

function findUserByEmail(email: string): UserRow | undefined {
  return selectUserByEmail.get(email) as UserRow | undefined;
}

/**
 * The sign-in lockout key `/continue` uses, rebuilt for a route that already
 * knows who the caller is. Scoped to one account from one address so the only
 * person a lock can shut out is whoever produced the failures, and truncated
 * for the reason given at `/continue`: the address half is caller-chosen and
 * may be 254 characters.
 */
function signInLockoutKey(req: Request, email: string): string {
  return `${email.toLowerCase().slice(0, 64)}|${req.ip ?? "unknown"}`;
}

/**
 * Re-proves the password on a route that already has a session.
 *
 * The session proves "signed in", which is not enough on its own to destroy an
 * account or replace its password: a browser left unlocked, or a tab whose
 * cookie has been lifted, is exactly the situation both of those routes exist
 * to be survivable. Requiring the password again is what makes them survivable.
 *
 * That makes both routes password-guessing surfaces reachable *without* the
 * sign-in flow, so they count into the same lockout `/continue` does, and are
 * refused by it. Failures land on the caller's own `email|ip` key, so the worst
 * an intruder achieves by guessing is locking their own source out.
 *
 * Answers the request and returns `null` on every rejection; a caller that gets
 * `null` must return immediately without writing to `res`.
 */
async function reauthenticate(
  req: Request,
  res: Response,
  password: unknown,
  { missing, wrong }: { missing: string; wrong: { error: string; code: string } },
): Promise<UserRow | null> {
  if (typeof password !== "string" || password.length === 0) {
    res.status(400).json({ error: missing });
    return null;
  }

  // The row can be gone between `attachSession` resolving it and this handler
  // running — the same account deleted from a second tab does exactly that.
  // Without the guard the cast is a lie and the password check throws a
  // TypeError, which reaches the client as a 500 and buries a real fault in the
  // log behind noise.
  const user = selectUserById.get(req.auth!.user.id) as UserRow | undefined;
  if (!user) {
    endSession(req, res);
    res.status(401).json({ error: "Please sign in.", code: "not_authenticated" });
    return null;
  }

  const key = signInLockoutKey(req, user.email);
  const lockedFor = lockoutByIp.retryAfterMs(key);
  if (lockedFor > 0) {
    rejectLocked(res, lockedFor);
    return null;
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    lockoutByIp.recordFailure(key);
    lockoutByAccount.recordFailure(user.email.toLowerCase());
    res.status(401).json(wrong);
    return null;
  }

  // Proving the password clears both counters, exactly as a successful
  // `/continue` does — otherwise a user who fumbled their own password here
  // would find themselves locked out of signing in afterwards.
  lockoutByIp.clear(key);
  lockoutByAccount.clear(user.email.toLowerCase());
  return user;
}

type PasswordCheck = { ok: true; value: string } | { ok: false; error: string };

function validatePassword(password: unknown): PasswordCheck {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.` };
  }
  // Byte length, not character length — see `MAX_PASSWORD_BYTES`. The message
  // says "characters" anyway: nobody typing emoji into a password field is
  // helped by being told about UTF-8, and the two counts only diverge for
  // passwords already close to the character cap.
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return {
      ok: false,
      error: "That password is too long. Try a shorter one, or use fewer emoji.",
    };
  }
  // Lowercased before the lookup: case rules are free to a cracker, so
  // `Password1` is not a different guess from `password1`. See the note on
  // COMMON_PASSWORDS for why this list exists at all.
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return {
      ok: false,
      error: "That password is one of the most commonly used ones. Please choose another.",
    };
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

    if (!isAcceptableEmail(email)) {
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

    // The sign-up-probe budget, checked before the lookup so that hitting it
    // costs the same as anything else here. Keyed on the source rather than on
    // `email|ip`, because it exists to count one caller across many addresses.
    const probeKey = req.ip ?? "unknown";
    const probeLockedFor = lockoutBySignUpProbe.retryAfterMs(probeKey);

    const user = findUserByEmail(normalized);
    if (!user) {
      // Keep the timing in line with the branch that does hash a password.
      await verifyPassword(password, DUMMY_HASH);
      // ...and keep the *cost* in line with it too. Which branch you landed on
      // is unavoidably visible — the flow's whole premise is telling the user
      // whether they're signing in or signing up — so the defence can't be to
      // hide it, only to make finding out expensive enough that a mailing list
      // can't be walked for free. What it must *not* do is charge that cost to
      // the same counter as a wrong password: see `lockoutBySignUpProbe`.
      lockoutBySignUpProbe.recordFailure(probeKey);
      if (probeLockedFor > 0) return rejectLocked(res, probeLockedFor);

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
    if (!isAcceptableEmail(email)) {
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

    if (!isAcceptableEmail(email)) {
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

    if (!isAcceptableEmail(email)) {
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

/**
 * Step one of recovery: ask for a code.
 *
 * Always 202, whatever happens below. Every branch — the address has no
 * account, the send budget for that inbox is spent, the resend cooldown is
 * still running, the provider refused — ends in the same response, because any
 * difference between them is an answer to "does this address have a Snapsher
 * account?" from an endpoint that needs no password at all.
 *
 * A malformed address still gets a 400. That discloses nothing about accounts:
 * it is a statement about the string, answered identically for an address that
 * exists and one that doesn't.
 *
 * The known-address branch does spend a network round trip that the unknown one
 * doesn't, so the two are not timing-equal. That is a deliberate non-goal
 * rather than an oversight: `/continue` already tells any caller which
 * addresses have accounts, by design, and it does so behind a tighter limiter
 * than this route's five-an-hour. Equalising here would buy nothing and would
 * mean holding the response open on a timer for every stranger who mistypes.
 */
authRouter.post(
  "/forgot-password",
  rateLimit(config.rateLimits.forgotPassword),
  smallJsonBody,
  asyncRoute(async (req, res) => {
    const { email } = req.body ?? {};

    if (!isAcceptableEmail(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    const normalizedEmail = normalizeEmail(email);
    const accepted = () => res.status(202).json({ ok: true });

    // Checked first so that asking about an address costs the same budget as
    // mailing it, on the same reasoning as `/signup`.
    if (resetSendBudgetByEmail.retryAfterMs(normalizedEmail) > 0) return accepted();

    const user = findUserByEmail(normalizedEmail);
    if (!user) return accepted();

    // The per-row cooldown, so re-submitting the form can't be used to send as
    // fast as the rate limiter allows.
    const now = Date.now();
    const existing = findPasswordReset(normalizedEmail);
    if (
      existing &&
      existing.expires_at > now &&
      existing.last_sent_at + config.verification.resendCooldownMs > now
    ) {
      return accepted();
    }

    const code = generateCode();

    // Sent before anything is written, exactly as `/signup` does it: an email
    // cannot be un-sent, so the write has to be the last thing that can fail.
    // A failed send leaves no row, starts no cooldown, and — since the response
    // is the same either way — tells the caller nothing either.
    const sent = await sendPasswordResetEmail(normalizedEmail, code);
    if (!sent.ok) return accepted();

    resetSendBudgetByEmail.recordFailure(normalizedEmail);
    upsertPasswordReset({
      email: normalizedEmail,
      userId: user.id,
      codeHash: hashCode(normalizedEmail, code),
      now,
    });

    accepted();
  }),
);

/**
 * Step two: prove the code and set a new password.
 *
 * Every failure that isn't a weak password answers with the same
 * `invalid_code`, including "no reset was ever asked for" and "that address has
 * no account" — the response must not become the enumeration oracle
 * `/forgot-password` refuses to be. There is deliberately no `attemptsLeft`
 * here, unlike `/verify-email`: a count of remaining attempts is itself a
 * statement that a live reset row exists for the address.
 *
 * Success does *not* sign the caller in. A reset is the recovery path for a
 * compromise, so it ends with every session for that account destroyed and
 * nobody signed in — including whoever just ran it, who returns to the sign-in
 * screen and uses the password they chose. Signing them in here would mean the
 * one flow designed for "someone else may be in this account" ended by minting
 * a session from an unauthenticated request.
 */
authRouter.post(
  "/reset-password",
  rateLimit(config.rateLimits.resetPassword),
  smallJsonBody,
  asyncRoute(async (req, res) => {
    const { email, code, newPassword } = req.body ?? {};

    if (!isAcceptableEmail(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof code !== "string" || !CODE_RE.test(code)) {
      return res.status(400).json({ error: "Enter the 6-digit code.", code: "invalid_code" });
    }

    const normalizedEmail = normalizeEmail(email);
    const invalidCode = () =>
      res.status(400).json({
        error: "That code isn't right, or it has expired. Ask for a new one.",
        code: "invalid_code",
      });

    const ipLockedFor = lockoutByResetIp.retryAfterMs(req.ip ?? "unknown");
    if (ipLockedFor > 0) return rejectLocked(res, ipLockedFor);

    const emailLockedFor = lockoutByResetEmail.retryAfterMs(normalizedEmail);
    if (emailLockedFor > 0) return rejectLocked(res, emailLockedFor);

    const now = Date.now();
    const reset = findPasswordReset(normalizedEmail);
    if (!reset || reset.expires_at <= now) return invalidCode();

    if (!codeHashMatches(reset.code_hash, hashCode(normalizedEmail, code))) {
      lockoutByResetIp.recordFailure(req.ip ?? "unknown");
      lockoutByResetEmail.recordFailure(normalizedEmail);
      const attempts = recordResetAttempt(normalizedEmail);
      if (attempts >= config.verification.maxAttempts) {
        // Deleted rather than locked, on the same self-healing rule as a
        // pending sign-up: the owner asks for a new code and carries on,
        // instead of a dead row sitting there until it expires.
        deletePasswordReset(normalizedEmail);
      }
      return invalidCode();
    }

    // The password is validated only after the code is proven, so a caller who
    // hasn't proven it learns nothing about the rules — and so that the
    // attempt cap counts wrong codes and nothing else. A rejected password
    // leaves the row alone: the code stays usable and the user simply picks a
    // better password.
    const checked = validatePassword(newPassword);
    if (!checked.ok) return res.status(400).json({ error: checked.error, code: "weak_password" });

    const user = selectUserById.get(reset.user_id) as UserRow | undefined;
    if (!user) {
      // The account went away after the code was issued; the cascade should
      // already have taken this row with it.
      deletePasswordReset(normalizedEmail);
      return invalidCode();
    }

    if (passwordEchoesIdentity(checked.value, user.username, user.email)) {
      return res.status(400).json({
        error: "Choose a password that doesn't contain your username or email address.",
        code: "weak_password",
      });
    }

    updatePasswordHash.run(await bcrypt.hash(checked.value, config.bcryptCost), user.id);
    deletePasswordReset(normalizedEmail);

    // The whole point of the flow: whatever is signed in as this account stops
    // being signed in as it. A reset is what someone runs *because* they think
    // another party has their password, and leaving a 30-day session alive
    // would leave that party exactly where they were.
    revokeAllSessions(user.id);

    // The owner has just proven control of the inbox, so failures accumulated
    // against this account by whoever they are recovering from must not be what
    // keeps them out of the account they have just recovered.
    lockoutByAccount.clear(normalizedEmail);

    res.status(204).end();
  }),
);

/**
 * Changing a password from inside the account.
 *
 * The current password is required for the reason `DELETE /account` requires
 * it, and the reasoning is stronger here: without it, a lifted session cookie
 * is enough to change the password and lock the real owner out permanently.
 *
 * On success every session for the account is destroyed and a fresh one is
 * issued to this caller — so the person at the keyboard stays signed in on this
 * device and is signed out on every other. That combination is the actual
 * remedy for a phished password or a stolen cookie, and the reason sessions are
 * a table rather than a signed cookie in the first place.
 *
 * Note for the client: the new session carries a new CSRF token, so the token
 * cookie must be re-read before the next write. `startSession` sets both.
 */
authRouter.post(
  "/password",
  requireAuth,
  rateLimit(config.rateLimits.changePassword),
  smallJsonBody,
  asyncRoute(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};

    const user = await reauthenticate(req, res, currentPassword, {
      missing: "Enter your current password.",
      wrong: { error: "That password isn't right.", code: "invalid_password" },
    });
    if (!user) return;

    const checked = validatePassword(newPassword);
    if (!checked.ok) return res.status(400).json({ error: checked.error, code: "weak_password" });

    if (passwordEchoesIdentity(checked.value, user.username, user.email)) {
      return res.status(400).json({
        error: "Choose a password that doesn't contain your username or email address.",
        code: "weak_password",
      });
    }

    updatePasswordHash.run(await bcrypt.hash(checked.value, config.bcryptCost), user.id);

    // A reset code outstanding right now was minted against the password that
    // just stopped existing. If the reason for this change is that someone else
    // asked for one, leaving it live would hand them the account back.
    deletePasswordResetsForUser(user.id);

    // Order matters: revoke first, then issue. The other way round would delete
    // the session this response is about to hand out.
    revokeAllSessions(user.id);
    startSession(req, res, user.id);

    res.status(204).end();
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
  // Per-account, not per-address — see `authenticatedKey`.
  rateLimit(config.rateLimits.updateAvatar, authenticatedKey),
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
    // Same pixel-budget refusal and same metadata strip as a post's photo —
    // see the comments in posts.ts and the reasoning in images.ts. The blast
    // radius is larger here: an avatar renders in the feed, on profiles, in the
    // likers popover and beside every comment.
    if (!withinPixelBudget(bytes, declaredFormat as ImageFormat)) {
      return res.status(400).json({ error: "That file isn't a supported image." });
    }
    const stored = stripMetadata(bytes, declaredFormat as ImageFormat);
    if (!stored) {
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
    await fs.promises.writeFile(avatarPath, stored, { mode: 0o640 });

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
    const user = await reauthenticate(req, res, req.body?.password, {
      missing: "Enter your password to confirm.",
      wrong: INVALID_CREDENTIALS,
    });
    if (!user) return;

    const photoFiles = (
      db.prepare("SELECT photo_file FROM posts WHERE user_id = ?").all(user.id) as Pick<
        PostRow,
        "photo_file"
      >[]
    ).map((row) => row.photo_file);

    // The row going away cascades to sessions, posts, likes, comments, friend
    // requests and any outstanding password reset (see the ON DELETE CASCADE
    // clauses in db.ts) — only the files those posts and the avatar point to
    // live outside the database and need cleaning up by hand, below.
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);

    // Past this line the account is gone, so the request has succeeded and must
    // say so. Without the catch, an `rm` rejecting with EPERM or EIO (`force`
    // only swallows ENOENT) turned a completed deletion into a 500: the modal
    // showed "Something went wrong", re-enabled its form and never fired
    // `onAccountDeleted`, leaving the user looking at a signed-in shell for an
    // account that no longer existed. A file left behind is wasted disk that
    // the hourly sweeper in postsStore collects; it is not a failure to report.
    try {
      await Promise.all([
        ...(user.avatar_file
          ? [fs.promises.rm(path.join(avatarsDir, user.avatar_file), { force: true })]
          : []),
        ...photoFiles.map((file) => fs.promises.rm(path.join(uploadsDir, file), { force: true })),
      ]);
    } catch (err) {
      console.warn(`[auth] could not remove files for deleted account ${user.id}`, err);
    }

    endSession(req, res);
    res.status(204).end();
  }),
);

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { db, isUniqueConstraintError, type UserRow } from "./db.js";
import { createLockout, rateLimit, rejectLocked } from "./rateLimit.js";
import { asyncRoute } from "./security.js";
import { endSession, requireAuth, startSession, toPublicUser } from "./sessions.js";
import { avatarsDir } from "./avatarsStore.js";
import {
  EXTENSION_BY_FORMAT,
  PHOTO_DATA_URL_RE,
  sniffFormat,
  type ImageFormat,
} from "./images.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
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
    const perIpKey = `${normalized}|${req.ip ?? "unknown"}`;

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

    const existing = db
      .prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE")
      .get(normalizedEmail, trimmedUsername);
    if (existing) {
      return res.status(409).json({ error: "Username or email is already taken." });
    }

    const passwordHash = await bcrypt.hash(checked.value, config.bcryptCost);

    let user: UserRow;
    try {
      const result = db
        .prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)")
        .run(trimmedUsername, normalizedEmail, passwordHash);
      user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid) as UserRow;
    } catch (err) {
      // Only a uniqueness collision means "taken" — anything else is our
      // problem, and reporting it as a duplicate would bury a real fault.
      if (!isUniqueConstraintError(err)) throw err;
      return res.status(409).json({ error: "Username or email is already taken." });
    }

    startSession(req, res, user.id);
    res.status(201).json({ user: toPublicUser(user) });
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

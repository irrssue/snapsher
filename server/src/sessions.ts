import crypto from "node:crypto";
import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "./config.js";
import { db, type SessionRow, type UserRow } from "./db.js";
import { SAFE_METHODS } from "./security.js";
import { avatarUrlFor } from "./avatarsStore.js";

const SESSION_COOKIE = "sid";
/**
 * Readable by the SPA on purpose: it has to echo this value back in a header,
 * which an attacker on another origin cannot do. The session cookie itself
 * stays `httpOnly`.
 */
const CSRF_COOKIE = "csrf";
const CSRF_HEADER = "x-csrf-token";

/** Cookies the previous cookie-session implementation left in browsers. */
const LEGACY_COOKIES = ["session", "session.sig"];

export type PublicUser = {
  id: number;
  username: string;
  email: string;
  avatarUrl: string | null;
};
export type AuthContext = { user: PublicUser; session: SessionRow };

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatarUrl: avatarUrlFor(user.avatar_file),
  };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, and the length of a token is
  // not a secret, so comparing it up front is fine.
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * `secure` comes from configuration rather than from `req.secure`, and the
 * cookie is written with Express's own serializer. The old code did neither:
 * cookie-session asked the `cookies` package for a `Secure` cookie, that
 * package refused to emit one over what it saw as a plain-HTTP connection
 * (the tunnel speaks HTTP to us), and cookie-session swallowed the error. Sign
 * in "succeeded" with no `Set-Cookie` at all, so the very next write came back
 * "Not signed in."
 */
function cookieOptions(maxAge: number, httpOnly: boolean): CookieOptions {
  return {
    httpOnly,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

function clearCookies(res: Response) {
  // Browsers only drop a cookie when the clearing attributes match the ones it
  // was set with, so path/secure/sameSite are repeated here deliberately.
  const base = { path: "/", secure: config.cookieSecure, sameSite: "lax" } as const;
  res.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
  for (const name of LEGACY_COOKIES) {
    res.clearCookie(name, { ...base, httpOnly: true });
  }
}

const insertSession = db.prepare(
  `INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, user_agent, ip)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const selectSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
const touchSession = db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?");
const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
const deleteStaleSessions = db.prepare(
  "DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?",
);

/**
 * Issues a brand-new session. Always called on a successful sign-in (never
 * reusing whatever session id the caller arrived with), which is what keeps a
 * fixated session id from surviving into an authenticated state.
 */
export function startSession(req: Request, res: Response, userId: number): SessionRow {
  endSession(req, res, { clearCookiesToo: false });

  const token = randomToken();
  const now = Date.now();
  const session: SessionRow = {
    id: hashToken(token),
    user_id: userId,
    csrf_token: randomToken(),
    created_at: now,
    last_seen_at: now,
    expires_at: now + config.session.absoluteMs,
    user_agent: req.get("user-agent")?.slice(0, 255) ?? null,
    ip: req.ip ?? null,
  };

  insertSession.run(
    session.id,
    session.user_id,
    session.csrf_token,
    session.created_at,
    session.last_seen_at,
    session.expires_at,
    session.user_agent,
    session.ip,
  );

  // The cookie outlives the idle window only as far as the absolute deadline;
  // the server-side row is the real authority either way.
  const maxAge = config.session.absoluteMs;
  res.cookie(SESSION_COOKIE, token, cookieOptions(maxAge, true));
  res.cookie(CSRF_COOKIE, session.csrf_token, cookieOptions(maxAge, false));

  // Signing in is the one moment every carry-over user passes through, so it's
  // where the dead cookie-session cookies actually get swept up.
  for (const name of LEGACY_COOKIES) {
    res.clearCookie(name, { path: "/", secure: config.cookieSecure, sameSite: "lax", httpOnly: true });
  }

  return session;
}

export function endSession(
  req: Request,
  res: Response,
  { clearCookiesToo = true }: { clearCookiesToo?: boolean } = {},
) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) deleteSession.run(hashToken(token));
  req.auth = undefined;
  if (clearCookiesToo) clearCookies(res);
}

/**
 * Resolves the session cookie into `req.auth`, enforcing both the idle window
 * and the absolute deadline, and drops the row the moment either passes.
 */
export const attachSession: RequestHandler = (req, res, next) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return next();

  // A cookie was presented, so any failure below is a session that ended
  // rather than a visitor who never had one — a distinction the client uses to
  // decide between "sign in again" and simply showing the sign-in page.
  req.authExpired = true;

  const id = hashToken(token);
  const session = selectSession.get(id) as SessionRow | undefined;
  if (!session) {
    clearCookies(res);
    return next();
  }

  const now = Date.now();
  const idleFor = now - session.last_seen_at;
  if (now >= session.expires_at || idleFor >= config.session.idleMs) {
    deleteSession.run(id);
    clearCookies(res);
    return next();
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as
    | UserRow
    | undefined;
  if (!user) {
    // Account gone; the cascade should have taken the session with it.
    deleteSession.run(id);
    clearCookies(res);
    return next();
  }

  if (idleFor >= config.session.touchIntervalMs) {
    touchSession.run(now, id);
    session.last_seen_at = now;
  }

  req.auth = { user: toPublicUser(user), session };
  req.authExpired = false;

  // Self-heal a CSRF cookie the browser lost (cleared site data, an older
  // build) so the user isn't stuck unable to post until they sign in again.
  if (readCookie(req, CSRF_COOKIE) !== session.csrf_token) {
    res.cookie(CSRF_COOKIE, session.csrf_token, cookieOptions(config.session.absoluteMs, false));
  }

  next();
};

/**
 * `code` lets the client tell "your session ended, sign in again" apart from
 * "those credentials were wrong", which are both 401s.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) {
    return req.authExpired
      ? res.status(401).json({
          error: "Your session has ended. Please sign in again.",
          code: "session_expired",
        })
      : res.status(401).json({ error: "Please sign in.", code: "not_authenticated" });
  }
  next();
}

/**
 * Double-submit CSRF check, bound to the session row rather than to a second
 * cookie alone: a cross-site page can send the cookie but cannot read it to
 * populate the header.
 */
export function requireCsrfToken(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method) || !req.auth) return next();

  const presented = req.get(CSRF_HEADER);
  if (!presented || !timingSafeEqual(presented, req.auth.session.csrf_token)) {
    return res.status(403).json({
      error: "This request could not be verified. Please refresh and try again.",
      code: "csrf_failed",
    });
  }
  next();
}

/** Keeps the table from growing without bound on a long-running process. */
export function startSessionSweeper() {
  const sweep = () => {
    const now = Date.now();
    deleteStaleSessions.run(now, now - config.session.idleMs);
  };
  sweep();
  const timer = setInterval(sweep, 60 * 60 * 1000);
  timer.unref();
}

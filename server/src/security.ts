import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "./config.js";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Express 4 hands a rejected promise from an `async` handler to nobody: it
 * escapes as an unhandled rejection, which on Node 22 takes the whole process
 * down rather than failing the one request. Every async route must be wrapped
 * so a database error becomes a 500 instead of a restart — and restarts are
 * especially expensive here, since the rate-limit and lockout counters live in
 * memory and a crash loop would quietly clear them.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/**
 * The app loads nothing from anywhere but itself. `data:` is needed for img-src
 * because the compose preview renders the picked photo from a data URL before
 * it is ever uploaded, and `'unsafe-inline'` for style-src covers React's
 * inline style attributes. The built bundle has no inline <script>, so
 * script-src stays strict.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self'",
  ...(config.isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

export const securityHeaders: RequestHandler = (req, res, next) => {
  /**
   * Scoped to the API, so the hard-cached immutable photo and asset responses
   * (which declare `private` themselves) are untouched.
   *
   * With no directive at all, a response carrying `Last-Modified` or `ETag` is
   * eligible for heuristic caching by anything in the path — a browser's disk
   * cache on a shared machine, a corporate proxy, or a future "cache
   * everything" rule on the Cloudflare zone. The JSON here is `/me` with the
   * caller's email, the friends-only feed, comment threads and the private
   * friend list; none of it may outlive the session that asked for it or be
   * served to a second viewer. `Vary: Cookie` says the same thing to a cache
   * that ignores `no-store`.
   *
   * Lowercased before the comparison because Express's `case sensitive routing`
   * is off by default: `app.use("/api")` compiles to a case-insensitive regex,
   * so `GET /API/auth/me` routes to the API and answers normally, while a
   * case-sensitive `startsWith` here saw a path it didn't recognise and let the
   * response leave with no `no-store`, no `Vary`, and Express's default weak
   * ETag — i.e. heuristically cacheable. One letter of casing was the whole
   * bypass, on `/me`'s email, the friends-only feed and every comment thread.
   */
  if (req.path.toLowerCase().startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
  }
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  if (config.isProd) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
};

function hostOf(origin: string | undefined): string | null {
  if (!origin || origin === "null") return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

const allowedHosts = new Set(
  config.clientOrigins.map((origin) => hostOf(origin)).filter((host): host is string => !!host),
);

function requestOrigin(req: Request): string | undefined {
  return req.get("origin") ?? req.get("referer");
}

/**
 * True when nothing in the configuration names a host we can trust.
 *
 * Falling back to the request's own `Host` header means comparing two values
 * written by the same sender, and this check is the *only* CSRF defence in
 * front of sign-in, sign-up, verify and resend — those have no session yet, so
 * `requireCsrfToken` skips them (see sessions.ts). In development that fallback
 * is right: there is no tunnel, no `PUBLIC_HOST`, and no sibling host on
 * localhost to attack from. In production it is a defence that has quietly
 * turned itself off, and the way it happens is not exotic — `pm2 restart`
 * preserves the old environment and cannot introduce a new variable, which is
 * precisely how `PUBLIC_HOST` goes missing here.
 *
 * So production refuses instead. A site that answers `origin_unconfigured` to
 * every write is loudly broken in a way somebody fixes in five minutes; a site
 * silently accepting cross-site writes is not broken at all until it is.
 */
const originCheckUnconfigured = config.isProd && !config.publicHost && allowedHosts.size === 0;

/**
 * First line of CSRF defence, ahead of the token check: a state-changing
 * request must declare an origin we recognise. Sign-in and sign-up have no
 * session yet and so no token to check, which makes this the only thing
 * standing in front of them.
 *
 * Hosts are compared rather than full origins because TLS terminates at the
 * tunnel — if `X-Forwarded-Proto` ever goes missing, `req.protocol` reads
 * "http" while the browser sends an "https" origin, and a scheme comparison
 * would lock every user out of posting.
 */
export const enforceTrustedOrigin: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  if (originCheckUnconfigured) {
    return res.status(403).json({
      error: "This server is misconfigured and cannot accept changes right now.",
      code: "origin_unconfigured",
    });
  }

  const origin = hostOf(requestOrigin(req));
  if (!origin) {
    return res.status(403).json({
      error: "This request could not be verified. Please refresh and try again.",
      code: "origin_missing",
    });
  }

  // `config.publicHost` when it is set, because comparing the request's own
  // `Origin` against its own `Host` is comparing two headers from the same
  // sender. The `Host` fallback survives only outside production — see
  // `originCheckUnconfigured` above.
  if (allowedHosts.has(origin) || origin === (config.publicHost || req.get("host"))) return next();

  res.status(403).json({
    error: "This request could not be verified. Please refresh and try again.",
    code: "origin_rejected",
  });
};

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found." });
};

/**
 * Terminates every failure as JSON with a generic message. Express's default
 * handler renders a stack trace into the response outside production, which is
 * exactly the kind of internal detail an error path shouldn't hand out.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const type = (err as { type?: string })?.type;
  if (type === "entity.too.large") {
    // Every route can hit this, not just the one that receives photos.
    return res.status(413).json({ error: "That request is too large." });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "That request wasn't valid JSON." });
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
};

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

export const securityHeaders: RequestHandler = (_req, res, next) => {
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

  const origin = hostOf(requestOrigin(req));
  if (!origin) {
    return res.status(403).json({
      error: "This request could not be verified. Please refresh and try again.",
      code: "origin_missing",
    });
  }

  // `config.publicHost` when it is set, because comparing the request's own
  // `Origin` against its own `Host` is comparing two headers from the same
  // sender. Falling back to `Host` keeps an unconfigured deployment working.
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

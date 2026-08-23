import type { ErrorRequestHandler, Request, RequestHandler } from "express";
import { config } from "./config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

  if (allowedHosts.has(origin) || origin === req.get("host")) return next();

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
    return res.status(413).json({ error: "That upload is too large." });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "That request wasn't valid JSON." });
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
};

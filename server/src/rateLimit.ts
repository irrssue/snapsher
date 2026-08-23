import type { Request, RequestHandler, Response } from "express";

/**
 * Fixed-window counters held in memory. That is the right shape for this
 * deployment — one PM2 fork, one process — and it deliberately adds no
 * dependency; if the app is ever scaled to multiple instances these counters
 * need to move to a shared store.
 */

type Window = { count: number; resetAt: number };

function sweep(store: Map<string, { resetAt: number }>) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, 60 * 1000);
  timer.unref();
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function clientKey(req: Request): string {
  // `req.ip` is only trustworthy because of the narrow `trust proxy` setting;
  // see config.ts.
  const ip = req.ip;

  // If the tunnel ever stops sending `X-Forwarded-For`, `req.ip` collapses to
  // the loopback peer and every visitor on earth would share one bucket —
  // which would lock the whole site out rather than any one abuser. Falling
  // back to Cloudflare's own header is safe precisely because nothing but the
  // tunnel can reach this port.
  if (!ip || LOOPBACK.has(ip)) {
    const forwarded = req.get("cf-connecting-ip")?.trim();
    if (forwarded) return forwarded;
  }

  return ip ?? req.socket.remoteAddress ?? "unknown";
}

function tooMany(res: Response, resetAt: number, message: string) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({ error: message, code: "rate_limited", retryAfter });
}

export function rateLimit({
  windowMs,
  max,
  message = "Too many requests. Please slow down and try again shortly.",
}: {
  windowMs: number;
  max: number;
  message?: string;
}): RequestHandler {
  const store = new Map<string, Window>();
  sweep(store);

  return (req, res, next) => {
    const key = clientKey(req);
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) return tooMany(res, entry.resetAt, message);
    next();
  };
}

/**
 * Per-account throttle for sign-in. The per-IP limiter above does nothing
 * against a spread-out attack on one account, and this does nothing against a
 * spray across many accounts — they cover each other's gap.
 */
export function createLockout({
  maxFailures,
  windowMs,
  lockMs,
}: {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
}) {
  const store = new Map<string, { failures: number; resetAt: number; lockedUntil: number }>();
  sweep(store);

  return {
    /** Milliseconds still to wait, or 0 when the account is not locked. */
    retryAfterMs(key: string): number {
      const entry = store.get(key.toLowerCase());
      if (!entry) return 0;
      return Math.max(0, entry.lockedUntil - Date.now());
    },

    recordFailure(key: string) {
      const id = key.toLowerCase();
      const now = Date.now();
      const entry = store.get(id);

      if (!entry || entry.resetAt <= now) {
        store.set(id, { failures: 1, resetAt: now + windowMs, lockedUntil: 0 });
        return;
      }

      entry.failures += 1;
      if (entry.failures >= maxFailures) {
        entry.lockedUntil = now + lockMs;
        entry.resetAt = Math.max(entry.resetAt, entry.lockedUntil);
        entry.failures = 0;
      }
    },

    clear(key: string) {
      store.delete(key.toLowerCase());
    },
  };
}

export function rejectLocked(res: Response, retryAfterMs: number) {
  tooMany(
    res,
    Date.now() + retryAfterMs,
    "Too many failed attempts. Please wait a few minutes and try again.",
  );
}

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

function clientKey(req: Request): string {
  // `req.ip` is only trustworthy because of the narrow `trust proxy` setting;
  // see config.ts. Express has already decided there how much of
  // `X-Forwarded-For` to believe, and that decision is the whole basis for
  // treating this value as a client identity.
  //
  // Nothing else may stand in for it. There used to be a fallback here to a raw
  // `CF-Connecting-IP` header whenever `req.ip` read as loopback, on the
  // reasoning that only the tunnel can reach this port — but a rate-limit key
  // an unauthenticated request can choose for itself is not a rate limit at
  // all: send a fresh value and you get a fresh bucket, and every brute-force
  // protection in the app is bypassed. Cloudflare overwrites that header today,
  // so this was one tunnel-config change away from being live. If the tunnel
  // ever does stop forwarding, the correct fix is to extend `trust proxy`, not
  // to trust a header nothing authenticates.
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
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

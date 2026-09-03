import type { Request, RequestHandler, Response } from "express";

/**
 * Fixed-window counters held in memory. That is the right shape for this
 * deployment — one PM2 fork, one process — and it deliberately adds no
 * dependency; if the app is ever scaled to multiple instances these counters
 * need to move to a shared store.
 */

type Window = { count: number; resetAt: number };

/**
 * Ceiling on how many keys any one limiter or lockout may hold.
 *
 * The sweeper below only sheds entries that have already expired, so between
 * sweeps a store grows one entry per distinct key and holds it for the whole
 * window — 15 minutes to an hour. Keys are partly attacker-chosen: a source
 * address (a single IPv6 /64 is 2^64 of them) and, for the sign-in lockout, an
 * email. Unbounded, that is a slow memory-exhaustion DoS whose successful
 * outcome is an OOM restart, and a restart silently clears *every* brute-force
 * counter in the process — the attacker is paid twice.
 *
 * 50,000 is far above any real member base's working set, so eviction only ever
 * happens under an attack of exactly that shape.
 */
const MAX_KEYS = 50_000;

/**
 * `store.set` with the cap enforced. Map iterates in insertion order, so the
 * first key is the oldest — evicting it under pressure discards the entry
 * closest to expiring anyway. An attacker filling the map can evict their own
 * accumulated failures, but that costs them 50,000 requests through the very
 * limiters they are trying to shed, which is a worse deal than waiting out the
 * window.
 */
function remember<T>(store: Map<string, T>, key: string, value: T) {
  if (store.size >= MAX_KEYS && !store.has(key)) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, value);
}

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

/**
 * Key for a limiter on a route that already requires a session.
 *
 * IP alone is the wrong unit for an authenticated write: a household, a campus,
 * an office or anything behind CGNAT shares one address, so ten posts an hour
 * was ten posts an hour *for everyone on that NAT together* — the first user to
 * hit it locked out people they've never met. The account is the thing the
 * budget is actually about (posting, commenting and avatar changes are all
 * per-account acts, and the 12-hour rule is enforced per account anyway), and an
 * attacker who wants a second bucket has to complete a whole verified sign-up
 * to get one.
 *
 * The IP fallback covers the ordering hazard rather than a real case: every
 * route using this sits behind `requireAuth`, but a limiter mounted before it
 * would otherwise collapse every anonymous caller into one shared key, which is
 * the failure this function exists to avoid. Prefixes keep the two key spaces
 * from ever colliding.
 */
export function authenticatedKey(req: Request): string {
  const userId = req.auth?.user.id;
  return userId === undefined ? `ip:${clientKey(req)}` : `user:${userId}`;
}

function tooMany(res: Response, resetAt: number, message: string) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({ error: message, code: "rate_limited", retryAfter });
}

export function rateLimit(
  {
    windowMs,
    max,
    message = "Too many requests. Please slow down and try again shortly.",
  }: {
    windowMs: number;
    max: number;
    message?: string;
  },
  /** How a caller is identified. Defaults to their address; see `authenticatedKey`. */
  keyOf: (req: Request) => string = clientKey,
): RequestHandler {
  const store = new Map<string, Window>();
  sweep(store);

  return (req, res, next) => {
    const key = keyOf(req);
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      remember(store, key, { count: 1, resetAt: now + windowMs });
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
        remember(store, id, { failures: 1, resetAt: now + windowMs, lockedUntil: 0 });
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

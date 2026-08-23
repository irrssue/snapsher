/**
 * Every environment-driven knob in one place, resolved once at boot.
 *
 * The rule here is "fail closed, not down": a missing variable narrows what the
 * server accepts (no cross-origin callers, no insecure cookies) rather than
 * crashing the process, so a forgotten variable on the homeserver degrades to
 * same-origin-only instead of taking the site offline.
 */

const isProd = process.env.NODE_ENV === "production";

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Origins allowed to make credentialed cross-origin calls. Production serves
 * the SPA from this same process, so an empty list there is correct and safe —
 * same-origin requests never consult it.
 */
const clientOrigins = (process.env.CLIENT_ORIGIN ?? (isProd ? "" : "http://localhost:5173"))
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const config = {
  isProd,
  port: envInt("PORT", 4000),

  /**
   * The homeserver reaches this process through a Cloudflare Tunnel that
   * connects over loopback, so trusting loopback (and nothing else) is what
   * turns `X-Forwarded-For` into a real client IP for rate limiting. Anything
   * arriving from a non-loopback peer is still treated as the client itself,
   * so a spoofed header from the open internet buys nothing.
   */
  trustProxy: process.env.TRUST_PROXY ?? (isProd ? "loopback" : ""),

  clientOrigins,

  /**
   * Browsers only accept `Secure` cookies over HTTPS. The tunnel terminates
   * TLS upstream and speaks plain HTTP to us, so this is a deliberate config
   * value rather than something sniffed from the request — see the note in
   * sessions.ts about why that distinction caused the sign-in bug.
   */
  cookieSecure: envFlag("COOKIE_SECURE", isProd),

  session: {
    /** Signed out after this long without any request. */
    idleMs: envInt("SESSION_IDLE_MS", 7 * DAY),
    /** Hard ceiling on a session's life, however active it is. */
    absoluteMs: envInt("SESSION_ABSOLUTE_MS", 30 * DAY),
    /** Don't write `last_seen_at` on every single request. */
    touchIntervalMs: 5 * MINUTE,
  },

  /** ~280ms per hash on this hardware; the cost the stored hashes get upgraded to. */
  bcryptCost: envInt("BCRYPT_COST", 12),

  rateLimits: {
    api: { windowMs: 15 * MINUTE, max: envInt("RATE_LIMIT_API", 600) },
    /**
     * Photos get their own, far larger budget: a single cold feed load is one
     * API call plus up to 100 image requests, so sharing the API's bucket
     * would let ordinary browsing rate-limit the reader out of their own feed.
     */
    photos: { windowMs: 15 * MINUTE, max: envInt("RATE_LIMIT_PHOTOS", 3000) },
    signIn: { windowMs: 15 * MINUTE, max: 20 },
    signUp: { windowMs: HOUR, max: 5 },
    createPost: { windowMs: HOUR, max: 10 },
    /** Per-account throttle, layered on top of the per-IP one above. */
    accountLockout: { maxFailures: 5, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  },
} as const;

if (isProd && !config.cookieSecure) {
  console.warn(
    "[config] COOKIE_SECURE is off in production — session cookies will be sent over plain HTTP.",
  );
}

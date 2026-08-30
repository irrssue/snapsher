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
   * In production the only thing that should be able to reach this process is
   * the tunnel, which connects over loopback. Binding every interface left the
   * plain-HTTP port answering on the LAN and the tailnet, where a request
   * skips Cloudflare's TLS and everything in front of it. Development still
   * binds broadly so the app can be opened from a phone on the same network.
   */
  host: process.env.HOST || (isProd ? "127.0.0.1" : ""),

  /**
   * The homeserver reaches this process through a Cloudflare Tunnel that
   * connects over loopback, so trusting loopback (and nothing else) is what
   * turns `X-Forwarded-For` into a real client IP for rate limiting. Anything
   * arriving from a non-loopback peer is still treated as the client itself,
   * so a spoofed header from the open internet buys nothing.
   *
   * `||`, not `??`: an explicitly empty `TRUST_PROXY` used to survive as `""`,
   * which index.ts reads as "don't set trust proxy at all". Express then
   * ignores `X-Forwarded-For` entirely and every request through the tunnel
   * reads as 127.0.0.1 — one shared bucket in all twelve limiters, and a
   * sign-in lockout key of `email|127.0.0.1` that any stranger can trip on any
   * account's behalf. An empty value now falls back to the safe default.
   */
  trustProxy: process.env.TRUST_PROXY || (isProd ? "loopback" : ""),

  clientOrigins,

  /**
   * The host this app is actually reached at, e.g. "snapsher.example.com".
   *
   * The same-origin check in security.ts otherwise compares the `Origin` header
   * against the `Host` header — two values that arrive in the same request and
   * are both written by whoever sent it. Setting this replaces the second half
   * of that comparison with something the attacker does not control, which
   * matters because that check is the *only* CSRF defence on sign-in and
   * sign-up: there is no session yet, so there is no token to demand.
   *
   * Optional, and unset falls back to the `Host` header, so forgetting it
   * degrades to the previous behaviour rather than locking everyone out.
   */
  publicHost: process.env.PUBLIC_HOST?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "") || "",

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
    updateAvatar: { windowMs: HOUR, max: 20 },
    /** A password-guessing surface, same shape as sign-in — kept just as tight. */
    deleteAccount: { windowMs: 15 * MINUTE, max: 10 },
    /**
     * Sending a request is otherwise unbounded: the 409 that stops a repeat
     * send is cleared by cancelling the request, and cancelling is something
     * the sender may do, so send → cancel → send loops forever. Thirty an hour
     * is far past what adding your actual friends takes.
     */
    friendRequest: { windowMs: HOUR, max: 30 },
    /** Every like is a write plus a JOIN; a hundred an hour is generous for a feed of 100. */
    like: { windowMs: HOUR, max: 300 },
    /**
     * Writing a comment, not reading one. Reads stay on the shared API budget
     * because opening a few threads while scrolling a feed is ordinary use;
     * writing sixty an hour is not, on an app whose whole premise is one photo
     * every twelve hours.
     */
    createComment: { windowMs: HOUR, max: 60 },
    /**
     * Each search is a leading-wildcard LIKE, which SQLite can only answer with
     * a full scan of the users table. The client debounces to one per 250ms,
     * so this only ever binds on something that isn't the client.
     */
    userSearch: { windowMs: 15 * MINUTE, max: 120 },
    verifyEmail: { windowMs: 15 * MINUTE, max: 20 },
    /** Four emails per pending sign-up (the initial send plus three resends), so 10/hour per IP is already generous headroom above what a real signup needs. */
    resendCode: { windowMs: HOUR, max: 10 },
  },

  /**
   * Two layers, because a single account-wide lock is a weapon pointed at the
   * account's owner: anyone who knows the address can burn five attempts and
   * lock the real user out, repeatedly, even with the correct password.
   *
   * `perIp` is therefore the barrier, and it is scoped to one account *from
   * one address*, so an attacker only locks themselves out.
   *
   * `perAccount` counts failures across every address at once, but auth.ts
   * refuses on it only when the presented password is *also* wrong — a correct
   * password signs in regardless of it. It has to work that way: at 50
   * failures an hour, roughly ten source addresses can hold an account-wide
   * lock open indefinitely, and if that lock refused outright it would be a
   * remote denial of service against any account whose email address is known.
   *
   * The honest consequence is that `perAccount` no longer slows a distributed
   * campaign down; it tells the owner one is happening, and what actually
   * bounds the guessing rate is `perIp` together with the `signIn` limiter
   * above. Those are per-address too, so the real defence against a large
   * botnet is password strength, which is why the rules are enforced at
   * sign-up rather than treated as advice.
   */
  lockout: {
    perIp: { maxFailures: 5, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
    perAccount: { maxFailures: 50, windowMs: HOUR, lockMs: HOUR },
    /**
     * Wrong verification codes. A pending sign-up already destroys itself after
     * `verification.maxAttempts` wrong codes (see verificationStore.ts), so the
     * only thing left to catch here is restarting sign-up to buy a fresh batch
     * of guesses — a loop that resets every counter living in the database,
     * because it replaces the row those counters are on.
     *
     * auth.ts therefore applies this one shape twice: once keyed on the source
     * address, and once on the address being verified. The first counts the
     * loop run from one source across many addresses; the second counts it run
     * from many sources against one address, which is the case that actually
     * ends with somebody else's email bound to an attacker's account.
     *
     * Deliberately lower than `rateLimits.verifyEmail`'s 20/15min: that limiter
     * counts every request, this counts only failures, so failures alone can
     * never reach 20 without the limiter already having cut the caller off
     * first — a lock that can't outrun the limiter guarding it isn't a second
     * layer. Arming at 8 makes it the one that actually bites.
     */
    verifyCode: { maxFailures: 8, windowMs: 15 * MINUTE, lockMs: 30 * MINUTE },
    /**
     * Outbound verification mail, keyed on the destination address rather than
     * the caller, because `/signup` is unauthenticated and names its own
     * recipient. Four an hour is what `verification.maxResends` already intends
     * per pending sign-up (one send plus three resends); the difference is that
     * this counter isn't reset by destroying the row, so it still holds when
     * one address is signed up for over and over from rotating sources. What it
     * protects is a stranger's inbox and the sending domain's reputation —
     * spam complaints against that domain take real sign-ups down with them.
     */
    verificationSend: { maxFailures: 4, windowMs: HOUR, lockMs: HOUR },
  },

  /**
   * Outbound email — only the sign-up code uses it today. Delivery is a plain
   * `fetch` to Resend's REST API rather than their SDK: the homeserver deploy
   * is `git pull` + `npm run build` + `pm2 restart` and never runs
   * `npm install`, so a new package.json dependency builds fine on the laptop
   * and crashes the process on boot over there.
   */
  email: {
    resendApiKey: process.env.RESEND_API_KEY?.trim() || "",
    /**
     * Must sit on a domain verified in Resend; anything else the API refuses
     * outright. The fallback is Resend's shared sandbox sender, which only
     * delivers to the Resend account's own address — enough to smoke-test the
     * wiring, useless for real users, which is the right way round for a value
     * someone forgot to set.
     */
    from: process.env.EMAIL_FROM?.trim() || "Snapsher <onboarding@resend.dev>",
    sendTimeoutMs: envInt("EMAIL_SEND_TIMEOUT_MS", 10_000),
    /**
     * Print verification codes to the console instead of sending them, for
     * development with no Resend key. Set in the `dev` npm script and nowhere
     * else — deliberately *not* derived from `isProd` like everything else
     * here.
     *
     * Every other control in the app fails safe when `NODE_ENV` goes missing
     * (no HTML is served at all, and the boot banner shouts). This one would
     * fail open: the process would tell every signer-upper a code was on its
     * way while writing it in plaintext to `pm2 logs`, where log access, a
     * shipper, or a backup is enough to complete anyone's sign-up. Requiring
     * its own opt-in means a homeserver that loses its environment refuses
     * sign-ups instead of leaking codes.
     */
    logCodes: envFlag("EMAIL_LOG_CODES", false),
  },

  verification: {
    /** Long enough to switch to a mail app and back; short enough that a code lifted from a backup is stale before it's worth anything. */
    codeTtlMs: envInt("VERIFICATION_CODE_TTL_MS", 10 * MINUTE),
    /** Guesses allowed against one pending row. Exhausting it destroys the pending sign-up rather than locking it, so the only person it can inconvenience just re-runs one form — which is also why it can't be the thing that bounds guessing on its own, and why `lockout.verifyCode` is keyed on the address as well. */
    maxAttempts: envInt("VERIFICATION_MAX_ATTEMPTS", 5),
    /** Four emails per pending sign-up, total. */
    maxResends: envInt("VERIFICATION_MAX_RESENDS", 3),
    resendCooldownMs: envInt("VERIFICATION_RESEND_COOLDOWN_MS", 60 * 1000),
  },
} as const;

if (isProd && !config.cookieSecure) {
  console.warn(
    "[config] COOKIE_SECURE is off in production — session cookies will be sent over plain HTTP.",
  );
}

/**
 * Without a key, `sendVerificationEmail` (email.ts) fails every send in
 * production rather than pretending to succeed — the right failure mode, but
 * a silent one: `pm2 restart` preserves the old env and can't add a new key
 * (see the homeserver notes), so this is exactly the variable most likely to
 * still be missing after a deploy, and the first anyone would otherwise hear
 * of it is a stream of 502s from `/signup`.
 */
if (isProd && !config.email.resendApiKey) {
  console.warn(
    "[config] RESEND_API_KEY is unset in production — sign-up verification emails cannot be sent.",
  );
}

/**
 * Unset, the origin check in security.ts falls back to comparing the request's
 * `Origin` against its own `Host` — two headers written by the same sender.
 * A browser won't let script forge `Host`, which is what keeps that from being
 * exploitable today, but it is the only CSRF defence in front of sign-in and
 * sign-up (no session yet, so no token to demand) and it rests entirely on the
 * tunnel not rewriting `Host`. Warned about rather than enforced for the same
 * reason as the fallback exists: an unset value must degrade, not lock everyone
 * out.
 */
if (isProd && !config.publicHost) {
  console.warn(
    "[config] PUBLIC_HOST is unset in production — the origin check falls back to the Host header, which the sender also controls.",
  );
}

/**
 * The one combination that must never be true on the homeserver: plain-HTTP
 * cookies *and* a socket answering on more than loopback. That is a session
 * readable by anyone on the LAN or the tailnet, reached without passing through
 * Cloudflare or its TLS at all.
 *
 * Every part of the safe posture — the loopback bind, `Secure` cookies, HSTS —
 * is derived from `NODE_ENV`, so a PM2 restart that loses that one variable
 * silently produces exactly this state. It is also, unavoidably, what ordinary
 * development looks like, since dev binds broadly on purpose so the app can be
 * opened from a phone. There is no way to tell the two apart from inside the
 * process, so this warns rather than exits: taking the site down over a
 * mistyped variable would be the worse failure.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

if (!config.cookieSecure && !LOOPBACK_HOSTS.has(config.host)) {
  console.error(
    "\n" +
      "!!  [config] Serving insecure cookies on a non-loopback address\n" +
      `!!  bind=${config.host || "0.0.0.0 (all interfaces)"} cookieSecure=false NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}\n` +
      "!!  Expected while developing. On the homeserver it means NODE_ENV never reached\n" +
      "!!  this process: sessions are being served in the clear to the whole network,\n" +
      "!!  bypassing Cloudflare. Set NODE_ENV=production (or HOST and COOKIE_SECURE).\n",
  );
}

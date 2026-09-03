import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Full 000000-999999. `randomInt`, not `Math.random` — the latter is seeded
 * from a predictable source and isn't a secret generator. Padded and kept as a
 * *string* throughout: `Number("042199")` is `42199`, and a leading zero the
 * user is looking at on screen would otherwise never match what's stored.
 *
 * Six digits rather than four because nothing in the app can count guesses
 * across a restarted sign-up as reliably as the code space itself bounds them:
 * a pending row's five-attempt cap dies with the row, and re-running /signup
 * mints a clean one. Four digits is a 10,000-value space, which the verify
 * lockout's ~13 guesses/hour/IP walks in weeks from one source and in hours
 * from fifty. A million values puts the same attack out of reach, and costs a
 * real user two extra characters they are copying off a screen anyway.
 */
export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Bound to the address so one row's hash can't be replayed against another. */
export function hashCode(email: string, code: string): string {
  return crypto.createHash("sha256").update(`${email}:${code}`).digest("hex");
}

/**
 * Both sides are 64-char hex digests today, so this never actually sees a
 * mismatched length — but `timingSafeEqual` throws on one rather than
 * returning false, and a malformed stored hash should fail the comparison,
 * not 500 the request.
 */
export function codeHashMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

type SendResult = { ok: true } | { ok: false };

/**
 * The one place that talks to the provider. Both kinds of mail this app sends
 * are a 6-digit code to an address the *caller* named, so they share every
 * failure mode worth reasoning about — no key, a provider timeout, an error
 * body that must be logged rather than returned — and there is nothing to gain
 * from two copies of that.
 */
async function sendCode(
  email: string,
  code: string,
  message: { subject: string; text: string; logLabel: string },
): Promise<SendResult> {
  if (!config.email.resendApiKey) {
    // Dev has no key and must still work; production with no key must not
    // pretend it sent anything. "Fail closed, not down" — the process boots
    // and everything else serves, only sign-up and password reset refuse,
    // rather than users being told to check an inbox nothing was sent to.
    //
    // Gated on its own opt-in rather than on `isProd`, because every other
    // control in the app already hangs off `NODE_ENV` and this is the one whose
    // failure mode is silent: a PM2 restart that lost that variable would leave
    // the process claiming every code was sent while printing it in plaintext
    // to `pm2 logs`, where anyone with log or backup access could complete any
    // pending sign-up. `EMAIL_LOG_CODES` is set in the `dev` script and nowhere
    // else, so a homeserver that loses its env refuses sign-ups instead.
    if (!config.email.logCodes) {
      console.error("[email] RESEND_API_KEY is unset — cannot send codes.");
      return { ok: false };
    }
    console.log(`[email] ${message.logLabel} for ${email}: ${code}`);
    return { ok: true };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.email.from,
        to: [email],
        subject: message.subject,
        text: message.text,
      }),
      // Node's fetch has no default timeout. Without this, a provider that
      // accepts the connection and never answers holds the sign-up request —
      // and its Express handler — open for as long as the socket lives.
      signal: AbortSignal.timeout(config.email.sendTimeoutMs),
    });

    if (!res.ok) {
      // Logged, never returned to the client: a Resend error body names the
      // sending domain and account, and the signer-upper can do nothing with
      // either.
      console.error("[email] resend rejected", res.status, (await res.text()).slice(0, 500));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error("[email] resend request failed", err);
    return { ok: false };
  }
}

export function sendVerificationEmail(email: string, code: string): Promise<SendResult> {
  const minutes = Math.round(config.verification.codeTtlMs / 60_000);
  return sendCode(email, code, {
    subject: `${code} is your Snapsher code`,
    text:
      `Your Snapsher verification code is ${code}.\n\n` +
      `It expires in ${minutes} minutes. ` +
      `If you didn't try to sign up, you can ignore this email.`,
    logLabel: "verification code",
  });
}

/**
 * The wording carries real weight here in a way the sign-up code's doesn't.
 * `/forgot-password` answers 202 to any address, so a stranger can cause this
 * mail to arrive in an inbox whose owner did nothing — the message has to say
 * plainly that ignoring it leaves the account untouched, or a phishing-shaped
 * mail from the real sending domain is what a victim sees. It also names no
 * username and carries no link: there is nothing in it to act on except by
 * returning to a Snapsher tab the recipient opened themselves.
 */
export function sendPasswordResetEmail(email: string, code: string): Promise<SendResult> {
  const minutes = Math.round(config.verification.codeTtlMs / 60_000);
  return sendCode(email, code, {
    subject: `${code} is your Snapsher password reset code`,
    text:
      `Your Snapsher password reset code is ${code}.\n\n` +
      `It expires in ${minutes} minutes. ` +
      `If you didn't ask to reset your password, you can ignore this email — ` +
      `nothing has changed, and your password still works.`,
    logLabel: "password reset code",
  });
}

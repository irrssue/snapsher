import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Full 0000-9999. `randomInt`, not `Math.random` — the latter is seeded from a
 * predictable source and isn't a secret generator. Padded and kept as a
 * *string* throughout: `Number("0421")` is `421`, and a leading zero the user
 * is looking at on screen would otherwise never match what's stored.
 */
export function generateCode(): string {
  return String(crypto.randomInt(0, 10_000)).padStart(4, "0");
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

export async function sendVerificationEmail(email: string, code: string): Promise<SendResult> {
  if (!config.email.resendApiKey) {
    // Dev has no key and must still work; production with no key must not
    // pretend it sent anything. "Fail closed, not down" — the process boots
    // and everything else serves, only sign-up refuses, rather than every new
    // user being told to check an inbox nothing was ever sent to.
    if (config.isProd) {
      console.error("[email] RESEND_API_KEY is unset — cannot send verification codes.");
      return { ok: false };
    }
    console.log(`[email] verification code for ${email}: ${code}`);
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
        subject: `${code} is your Snapsher code`,
        text:
          `Your Snapsher verification code is ${code}.\n\n` +
          `It expires in ${Math.round(config.verification.codeTtlMs / 60_000)} minutes. ` +
          `If you didn't try to sign up, you can ignore this email.`,
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

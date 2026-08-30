# Ongoing: email sign-up verification

Shipped in commit `df480e7` (pushed to `main`, deployed to the homeserver, PM2 process restarted and online).

## What's done
- Sign-up now requires a 6-digit email code before the account is created.
- Email provider: **Resend**, called via plain REST (`https://api.resend.com/emails`) using native `fetch` — no SDK/package added, since the homeserver deploy never runs `npm install`.
- New server files: `server/src/email.ts` (code gen/hash/send), `server/src/verificationStore.ts` (pending-signup storage).
- New/changed endpoints: `POST /api/auth/signup` (now sends a code + parks a pending row instead of creating the account), `POST /api/auth/verify-email`, `POST /api/auth/resend-code`.
- Security review (separate Opus agent) caught and fixed a real hijack bug: a second `/signup` call for someone else's address could overwrite their pending row. Fixed with a possession token returned only to the original caller and required on verify/resend.
- Dev fallback: with no `RESEND_API_KEY` set, the code is logged to the console instead of emailed — `npm run dev` works with no credentials.

## What's NOT done yet — action needed
**Production sign-up currently 502s.** No `RESEND_API_KEY` is set in the homeserver's PM2 env, so every send fails closed (by design — it never pretends to succeed).

To fix, on the homeserver:
1. Get an API key from your Resend account, and a sender address on a domain verified in Resend (the default `onboarding@resend.dev` only delivers to your own Resend account's address — real users need a verified domain).
2. Set `RESEND_API_KEY` and `EMAIL_FROM` in the shell before starting PM2.
3. **Must be `pm2 delete snapsher` + `pm2 start` + `pm2 save`, not `pm2 restart`** — a plain restart preserves the old env and can't add a new key.
   - Use `--interpreter /home/irrssue/.nvm/versions/node/v22.23.1/bin/node` (a non-interactive ssh shell has no nvm on PATH).
4. Boot now logs a warning (`[config] RESEND_API_KEY is unset in production...`) if this is still missing — check `pm2 logs snapsher` after restart to confirm it's gone.

## Where to pick this back up
- Confirm the env vars are set and do a real sign-up end-to-end on snapsher.com.
- If Resend's domain verification is still pending, sign-up will keep 502ing until it's verified.

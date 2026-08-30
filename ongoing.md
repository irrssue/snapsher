# Ongoing: email sign-up verification

Shipped in commit `df480e7` (pushed to `main`, deployed to the homeserver, PM2 process restarted and online).

## What's done
- Sign-up now requires a 6-digit email code before the account is created.
- Email provider: **Resend**, called via plain REST (`https://api.resend.com/emails`) using native `fetch` — no SDK/package added, since the homeserver deploy never runs `npm install`.
- New server files: `server/src/email.ts` (code gen/hash/send), `server/src/verificationStore.ts` (pending-signup storage).
- New/changed endpoints: `POST /api/auth/signup` (now sends a code + parks a pending row instead of creating the account), `POST /api/auth/verify-email`, `POST /api/auth/resend-code`.
- Security review (separate Opus agent) caught and fixed a real hijack bug: a second `/signup` call for someone else's address could overwrite their pending row. Fixed with a possession token returned only to the original caller and required on verify/resend.
- Dev fallback: the code is logged to the console instead of emailed when `EMAIL_LOG_CODES=1` is set, which `npm run dev` sets for you — so local dev still needs no credentials. It is deliberately **not** keyed on `NODE_ENV` any more: a homeserver that lost that variable used to claim the send succeeded and print every code to the PM2 log.

## Status: done and deployed

The env vars this file used to list as outstanding are set on the homeserver and
`pm2 save`d, so they survive a reboot:

- `RESEND_API_KEY` and `EMAIL_FROM` (`Snapsher <noreply@mail.snapsher.com>`) — production sign-up sends real mail; it no longer 502s.
- `NODE_ENV=production` — loopback bind, `Secure` `__Host-` cookies, HSTS, `trust proxy`.
- `PUBLIC_HOST=snapsher.com` — pins the CSRF origin check to a configured host instead of falling back to the request's own `Host` header.
- `CLIENT_ORIGIN=https://www.snapsher.com` — the site answers on both the apex and `www` with no redirect, so `www` has to be allowed explicitly or every write from it would 403.

Verified after the restart: `POST /api/auth/continue` is accepted with an `Origin`
of `snapsher.com` and of `www.snapsher.com`, and refused with `origin_rejected`
from anything else. Boot logs no config warnings.

Remember the deploy constraint if these ever need changing: **`pm2 delete snapsher`
+ `pm2 start` + `pm2 save`, not `pm2 restart`** — a plain restart keeps the old env.
Start with `--interpreter /home/irrssue/.nvm/versions/node/v22.23.1/bin/node`, since
a non-interactive ssh shell has no nvm on `PATH`.

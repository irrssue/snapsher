# Snapsher

Peer-to-peer file transfer over WebRTC, paired by pointing one phone's camera at a circular code on the other's screen.
The server (`server.js`) only relays signalling (SSE down, POST up) and acts as a fallback file relay when no direct route exists.

No package.json, no dependencies, no build step.
Node stdlib only on the server, plain ES modules in `public/`.
Keep it that way: reach for the standard library or a native platform feature before adding anything.

## Running locally

```bash
TLS=0 node server.js
```

Serves on port 8442.
Without `TLS=0` the server generates a self-signed cert into `certs/` and serves HTTPS, which is what real phones need for camera access.
`.claude/launch.json` already defines this as a preview target named `snapsher`.

Tests are in `test.mjs`, run with `node test.mjs`.

## Deploy to the homeserver after EVERY change

Every change to this repo must be synced to the homelab box.
Do not leave a change local.

```bash
rsync -az --delete --exclude certs --exclude .claude ./ irrssue@homelab:~/snapsher/ && ssh irrssue@homelab 'pm2 restart snapsher --update-env >/dev/null'
```

This is already automated: the `Stop` hook in `.claude/settings.json` runs exactly that command at the end of every turn.
So in normal agent work there is nothing to type - just do not disable or bypass the hook.
Run the command by hand only when the hook did not fire, or to confirm a deploy landed:

```bash
ssh irrssue@homelab 'ls -l ~/snapsher/public && pm2 describe snapsher | grep -E "status|uptime"'
```

## Design

Black and white only.
No colour anywhere, including the mobile status bar tint (`theme-color` is `#000`).
No decorative borders.

No decorative background visual on either pairing screen: the sending screen shows only the circle code, the scanning screen only the camera circle.

## The circle code

`public/circle.js` is the whole format: a centre dot plus two concentric rings of 24 sectors, carrying a 36-bit session id and an 8-bit checksum.
The checksum has to stay wide because the decoder tries all 24 rotations, and a narrow one lets a misaligned read pass as a plausible but wrong id.
If you touch `encode`/`decodeBits`/`draw`, you have changed the wire format on both devices at once - re-run `test.mjs` and check a real scan, not just the unit test.

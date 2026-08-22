# Snapsher

Phone-to-phone file transfer with a screen and a camera, no network in the loop: the sender streams
the file's bytes into an animated QR-shaped code, and the receiver reads it back with its camera.
The server (`server.js`) only serves the app's own static files.

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

No decorative background visual on either pairing screen: the sending screen shows only the QR frame, the scanning screen only the camera circle.

## The QR frame and the fountain layer

`public/qr.js` is the whole code format: a bespoke, QR-*shaped* code (finder/timing/alignment patterns, Reed-Solomon-checked payload) — not ISO/IEC 18004. It is not meant to be read by a generic QR scanner, only by this app's own decoder. `public/fountain.js` is the streaming layer on top: frame headers and a systematic-carousel fountain code, so the receiver can lock onto the stream at any point and finish from any ~k frames in any order, no back-channel, no handshake.

Both files are pure functions with no DOM dependency, so `node test.mjs` exercises the full encode → rasterize → decode → fountain-reassemble pipeline without a browser. If you touch `qr.js`'s module geometry, masking, or Reed-Solomon parameters, or `fountain.js`'s header layout or carousel logic, you have changed the wire format on both devices at once - re-run `test.mjs` and check a real scan, not just the unit test. Real camera-to-screen scan reliability has not been verified on real hardware; see history.md's 2026-08-22 entry before assuming the tunable constants (`N`, `EC_FRACTION`, `SEND_INTERVAL`, `SCAN_INTERVAL`) are already right.

decimen-optical-transfer (the project that inspired this) is AGPL-3.0. Nothing here is ported from its source — see history.md for why that boundary matters and what was independently re-derived instead.

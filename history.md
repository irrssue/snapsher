# Project history

Working notes for whoever picks this up next, human or Claude.
Written 2026-08-08, at the point where the first end-to-end share worked on real hardware.

## What this is

A web app for sharing a photo or two between people in the same house.
One device picks a file and displays a circular code.
The other device opens the site, points its camera at the code, and the file arrives.

The original request also asked for Bluetooth transfer, storing nothing on the server, and auto-saving into the receiver's Photos folder.
Two of those three are not possible in a browser.
See "Constraints that shaped the design" below before proposing them again.

## Architecture

Four source files, no build step, no npm dependencies.

- `server.js` — static file serving, the signalling relay, and the fallback file relay.
- `public/circle.js` — the circle code: bit layout, canvas rendering, and camera decoding. Pure functions, no DOM beyond the canvas context passed in.
- `public/app.js` — the two user flows, WebRTC setup, chunked transfer.
- `public/index.html` and `public/style.css` — three sections, one visible at a time.

Signalling is Server-Sent Events downstream and POST upstream, keyed by a room id.
This was chosen over WebSockets purely to avoid the `ws` dependency, and it has been sufficient.
The server relays messages between the two members of a room without inspecting them.

The file itself travels over a WebRTC DataChannel in 16 KB chunks, preceded by one JSON metadata message.
On the same WiFi, ICE settles on host candidates and the bytes never touch the server.

## The circle code

A solid centre dot surrounded by two concentric rings of 24 sectors each.

Geometry lives in `G` in `circle.js`, in units where the code radius is 128: dot radius 28, inner ring 45 to 75, outer ring 85 to 115.
The decoder derives scale from the measured dot radius, so the absolute size in the camera frame does not matter.

Sector 0 of each ring is always filled and sector 1 always empty.
That four-bit pattern is the rotation reference.
The remaining 44 bits carry a 36-bit session id (9 hex characters) and an 8-bit checksum.

Decoding pipeline: greyscale, Otsu threshold, connected-component search for round dark blobs, take the eight largest as candidate centre dots, sample both rings in polar coordinates, then try all 24 rotations.

## Bugs found during the build, and why they matter

Each of these was reproduced before being fixed.
They are recorded because the same mistakes are easy to reintroduce.

**Otsu returned the first index of a tie plateau.**
On a synthetic image with only two grey levels, every threshold between them scores identically, and taking the first one put the threshold below every pixel.
The decoder found nothing at all.
The fix straddles the whole plateau and returns its midpoint.
This never shows up on camera input, only on clean synthetic images, which is exactly where the test suite lives.

**ICE candidates arrived before the offer they belonged to.**
`addIceCandidate` threw `InvalidStateError` because the remote description was still null.
Fixed with a candidate queue that buffers until the description is set, plus serialising the whole signalling handler through a promise chain so an offer is fully applied before the next message is touched.

**A four-bit checksum was too weak for a 24-rotation search.**
The decoder tries every rotation and accepts the first that passes the checksum, so a misaligned read had roughly a one in sixteen chance of passing.
It produced confidently wrong session ids about 28 percent of the time.
Fixed by widening the checksum to eight bits and requiring that exactly one rotation decodes.
If two rotations both decode, the frame is dropped rather than guessed.
Misreads went to zero.
Any future change to the bit layout must keep both of those properties.

**`display: grid` on `section` overrode the `hidden` attribute.**
All three screens rendered at once.
`section[hidden] { display: none }` fixes it.

**Stale console buffer during debugging.**
The browser tool kept replaying two old WebRTC errors after they had been fixed, which sent me chasing a bug that no longer existed.
Confirmed stale by loading a CSS file in the same tab and seeing the same two errors.
If an error count stays suspiciously constant across runs, check whether it is real.

## Testing

`node test.mjs` rasterises a circle code in pure JavaScript, with no canvas, and decodes it back at several rotations.
It also asserts that a blank frame produces no false positive.
Run it after any change to the bit layout or the decoder.

Decoder accuracy was measured in the browser against canvas-rendered codes at 200 random sizes and rotations: 189 correct, 0 misread, 11 not read.
A frame that is not read costs nothing, because the scanner just tries the next one at 5 frames per second.
Misreads are the failure mode that matters, and that number must stay at zero.

The relay was verified by SHA-256 comparison of a 3 MB file in and out, both locally and through the tunnel.

The camera scan itself was never verified by automation, since it needs a physical phone pointed at a screen.
It was confirmed working by hand on 2026-08-08.

## Constraints that shaped the design

**Bluetooth is impossible from a browser and always will be.**
Web Bluetooth is GATT-only, a browser cannot act as a BLE peripheral, and Safari does not implement it at all.
There is no path to browser-to-browser Bluetooth file transfer.
Both devices need a network.

**The save location cannot be chosen.**
Received files go wherever the browser puts downloads.
A web page cannot write into Photos or a named folder.

**The camera needs a secure context.**
A plain `http://192.168.x.x` address cannot call `getUserMedia`.
This is why the server generates a self-signed certificate for LAN use, and why the production deployment sits behind real TLS.

**GitHub Pages cannot host this.**
It serves static files only, and this app needs a live process for signalling and the relay.

## The relay fallback

Some networks block device-to-device traffic, most commonly guest WiFi with AP isolation.
When the data channel has not opened after `RELAY_AFTER` (6 seconds), the sender POSTs the file to `/relay/<room>` and the receiver, which is polling that URL, collects it.

A `claimed` flag on each side ensures the direct and relay paths cannot both fire.
The file is held in memory, deleted on first pickup, and expires after ten minutes.

Relayed files do pass through the server, unlike the direct path.
This was a deliberate trade: for one or two photos it is simpler and cheaper than running a TURN server, which would carry the same bytes anyway with far more machinery.

Limits, all in `server.js`: 25 MB per file, 10 files pending at once, 20 uploads per IP per ten minutes.
The rate limiter is naive in-memory counting and is marked with a `ponytail:` comment.
It is sized for a household, not for the public at large, even though the endpoint is publicly reachable.

To force the relay path during testing, set `RELAY_AFTER` to 0.
Remember to set it back.

## Deployment

Running on the homelab as PM2 process `snapsher`, bound to `127.0.0.1:3005`, behind Cloudflare Tunnel at `snapsher.com`.
`pm2 save` has been run, so it survives a reboot.

```bash
rsync -az --delete --exclude certs ./ irrssue@homelab:~/snapsher/
ssh irrssue@homelab 'pm2 restart snapsher --update-env'
```

`TLS=0` makes the server bind plain HTTP to `127.0.0.1:$PORT` and skip its own certificate, since the tunnel terminates TLS.
Without that variable it serves HTTPS on 8443 with a self-signed certificate, plus plain HTTP on 8442 for desktop development.

The tunnel ingress lives in `/etc/cloudflared/config.yml`, which is root-owned and needs a password to edit, so that step cannot be automated from here.
`~/.cloudflared/config.yml` must be kept identical to it.
Both files currently carry the `snapsher.com` and `www.snapsher.com` entries.

Note that `/etc/cloudflared/config.yml` is world-readable.
It can be read with plain `cat` even though editing needs sudo.

If the site returns a blank white page, that is the tunnel's `http_status:404` catch-all, which sends a 404 with an empty body.
It means the hostname is not in the active ingress list, or cloudflared was not restarted.
Check with `grep -c snap /etc/cloudflared/config.yml` and `systemctl show cloudflared -p ActiveEnterTimestamp --value`.

The tunnel cuts connections at 100 seconds and the signalling channel is a long-lived SSE stream.
`EventSource` reconnects on its own, so shares recover, but reconnects will appear in the logs.

## Possible next steps

None of these are needed yet.
Listed so the reasoning does not have to be redone.

- The receiver assembles the whole file in memory before saving, so large files will strain a phone. Streaming to disk via the File System Access API would fix it, but that API is Chrome-only, so it would need a fallback anyway.
- Only one file per session. Sending several would need the metadata message to describe a manifest.
- No video handling, by original request.
- The decoder samples on the assumption that the code is roughly face-on. Strong perspective is not corrected for. If scanning at an angle proves annoying in practice, that is where to look.
- There is no cleanup for the `uploads` rate-limit Map. It grows one entry per distinct IP and is never pruned. Harmless at household scale, worth fixing if exposure widens.

## 2026-08-22: replaced the transport with optical QR streaming

Everything above this line describes the WebRTC/circle-code version. That version is gone: the
"possible next steps" list above (manifest support, the uploads rate-limit Map) no longer applies
because the code it refers to — `/sig`, `/relay`, the circle code, WebRTC entirely — was deleted,
not extended. This section is the record of what replaced it and why.

### What prompted it

The user pointed at a Tom's Hardware piece on streaming a file's data directly through an animated
QR code at up to ~190 KB/s phone-to-phone, and its reference implementation,
[decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer) (verified
to actually exist and be what it claimed — the first automated summary of it looked suspiciously
clean, so it got checked against the GitHub API and cloned before anything was trusted from it).
They wanted snapsher's whole transport rebuilt around that idea, keeping the existing three-screen
UI shell (home / show-a-code / scan-a-code).

Two decisions were made explicitly before writing any code, via direct questions back to the user:
**full replacement** of WebRTC/signalling/relay (not a hybrid — `server.js` is now a plain static
file server), and a **hand-rolled, zero-dependency** QR encoder and decoder in `public/qr.js`,
matching the project's existing "stdlib before dependencies" rule and `circle.js`'s own precedent
of hand-rolled vision code, rather than vendoring a library like jsQR.

### Why the format isn't spec-compliant QR

`decimen-optical-transfer` is AGPL-3.0. Its actual wire protocol (fountain coding, frame headers,
pinned QR mask) was deliberately **not** ported from its source — that would have carried the
license into this repo. Everything in `public/qr.js` and `public/fountain.js` is an independent
re-derivation of the underlying published ideas (Luby Transform fountain codes, QR's own
finder/timing/alignment pattern structure, Reed-Solomon over GF(256)), the same way `circle.js` was
always an original design and not a copy of anything.

That independence is also what motivated cutting scope aggressively versus real QR: no
version-info or format-info blocks, a single pinned mask, plain raster-order data placement
instead of the spec's zigzag, and — biggest simplification — Reed-Solomon parity that is
**verified, not corrected**. A frame with any bit error is just dropped; there's no
Berlekamp-Massey/Chien/Forney in this codebase at all. That's a deliberate risk trade: this decoder
can only be checked in this environment against synthetic, self-generated test images
(`test.mjs` rasterizes at several rotations up to full about-face and checks round-trip), never
against a real phone camera. Every one of those simplifications is a subsystem that didn't have to
be hand-written and verified blind. `circle.js` had the same "confirmed working by hand" gap before
it was trusted — this is in the same position, just for a considerably bigger algorithm.

### The format

`public/qr.js`: fixed 41×41 modules (`N`), fixed Reed-Solomon parity fraction (`EC_FRACTION`, 0.2
of usable codewords). That currently works out to 141 payload bytes per frame, 35 of them parity.
Neither number is tuned against real hardware yet — see the README's "Transport" section for the
full tunable list.

`public/fountain.js`: 15-byte frame header (magic byte, session id, sequence number, total payload
length, an FNV-1a checksum of the whole payload) — no `k` field, since the receiver derives block
count from `totalLen` and the fixed block length. Systematic sweep of all source blocks, then
mid-degree repair frames forever, seeded deterministically per `(session, seq)` via a small
Mulberry32 PRNG so sender and receiver agree without a handshake. This is a considerably simpler
scheme than decimen's own (no robust-soliton distribution, no `Math.log`-determinism landmine to
guard against — see their `dlog()` if curious what that bug class looks like), traded down on
purpose since matching their exact degree distribution wasn't the point; matching their
*insight* (a one-way channel wants erasure-tolerant, order-independent frames) was.

### What changed in the UI

The three-screen flow is unchanged. The circle-shaped code became a square QR frame — the `.glow`
container was already just a plain square box (the circular *look* was always the circle code's own
drawing against a matching black page, not a CSS clip), so no layout rework was needed there.
`#home`'s pulsing dot lost the geometry-derived sizing comment (there's no `G` object to derive it
from any more) and became a small square instead of a circle, otherwise unchanged. The sender's
progress bar no longer means "percent sent" — there's no back-channel to know that — it now cycles
once per systematic sweep as an honest "still broadcasting" signal instead. The `?r=` shareable-link
fallback is gone: there's no server-side room for a pasted link to join any more.

### Batch size

Old cap was 500 MB, sized for LAN-speed WebRTC. Optical transfer is nowhere near that fast, so the
new cap is 20 MB — a guess, not a measurement, pending real throughput numbers. The receiver also
now holds the *entire* batch in memory and writes nothing out until the whole fountain payload has
reassembled (files no longer stream in one at a time the way they did over the DataChannel), which
pushes the sane cap down further than throughput alone would.

### What's still unverified

Real camera-to-screen scanning. `node test.mjs` passes — QR round-trip at seven rotations
including two past 90°, a fountain round-trip that drops 35% of frames and still reconstructs
exact bytes, and a server smoke test — but none of that touches a real lens, real motion blur, real
ambient light, or real phone CPU decode speed. `SEND_INTERVAL`, `SCAN_INTERVAL`, `N`, and
`EC_FRACTION` are first guesses. Whoever picks this up next should scan an actual phone against an
actual phone before trusting throughput or reliability numbers, exactly as this file's 2026-08-08
entry above had to before the circle code was trusted.

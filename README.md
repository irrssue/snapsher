# snapsher

File sharing between two phones with nothing but a screen and a camera.
One device streams the file straight into an animated QR code; the other reads it back with its
camera. No network round-trip for the transfer itself — the server only hands out the app's own
files.

```bash
node server.js
```

Then open `https://<your-lan-ip>:8443` on both devices and accept the self-signed certificate.
`http://localhost:8442` is there for desktop development only.
Camera access needs a secure context, so a plain `http://` LAN address cannot scan.

Set `TLS=0` when something upstream already terminates TLS, and the server binds plain HTTP to `127.0.0.1:$PORT` instead.

One device picks one or more files and shows an animated code.
The other opens the app, taps **Scan a code**, points its camera at the first device, and the
files download once enough of the stream has been seen.
A batch is capped at 20 MB in total — optical transfer is much slower than a LAN connection, and
that cap is a starting guess pending a real throughput number from actual hardware (see
"Transport" below).

## Transport

The file (or batch — see "The container" below) is fountain-coded into an endless carousel of
frames, and each frame is drawn as one QR-shaped code on a canvas, cycling on screen for as long as
the sender keeps the tab open. The receiver's camera samples frames from that stream and decodes
whichever ones it manages to read; a systematic sweep of the source blocks followed by
pseudorandom repair frames means the receiver can lock on at any point, in any order, and finish
once it's seen roughly one file's worth of distinct frames. Dropped or misread frames cost a
little time, never correctness — there's no retransmission because there's no back-channel: the
sender has no way to know when, or whether, the receiver finished, and the app doesn't pretend
otherwise (the sender's progress bar shows the current sweep cycling, not completion).

This is the same idea as [a project that streams file data through animated QR
codes](https://github.com/bashalarmistalt/decimen-optical-transfer) achieving ~190 KB/s
phone-to-phone — but that implementation compiles a WASM QR decoder and pulls in a build
pipeline. Snapsher's decoder and encoder are hand-written in `public/qr.js` with no dependencies,
matching the rest of this codebase, so real throughput here is unverified and likely lower until
it's been measured on actual devices. See "The QR frame" below for the constants to tune once that
number exists.

## The container

Sending several files packs them into one payload before it ever reaches the fountain layer: a
small JSON manifest (name/size/type per file), length-prefixed, followed by the files'
concatenated bytes. The whole thing reassembles atomically — there's no per-file progress within a
batch, only overall reconstruction progress, because the fountain decoder doesn't know it's
carrying more than one file until the very end.

## The QR frame

`public/qr.js` is the whole format: three finder patterns (for detection and orientation), one
timing pattern, one alignment pattern, and a data region read in plain raster order — not
ISO/IEC 18004. It intentionally isn't spec-compliant: no version-info or format-info blocks, a
single pinned mask, and Reed-Solomon parity that's *verified, not corrected* (a frame with any bit
error is dropped rather than repaired, since the fountain layer already expects lost frames and
recovering them the slow way isn't worth the code). None of that matters because the encoder and
decoder here are always each other's only reader — a generic QR scanner can't read this format,
and isn't meant to.

`public/fountain.js` is the streaming layer on top: frame headers, the systematic-carousel
fountain code, and the peeling decoder. Both files are pure functions with no DOM dependency
(`qr.js`'s `draw()`/`decode()` take a canvas context / grayscale buffer, nothing more), so
`node test.mjs` exercises the whole encode → rasterize → decode → fountain-reassemble pipeline
without a browser, the same way the old circle code was tested.

Tunable constants, all worth revisiting once real-device numbers exist:
- `qr.js`: `N` (modules per side — smaller reads more reliably, larger carries more per frame),
  `EC_FRACTION` (Reed-Solomon parity share).
- `app.js`: `SEND_INTERVAL` / `SCAN_INTERVAL` (frame draw/decode cadence), `CAPTURE` (camera crop
  resolution), `BATCH_MAX`.

## Deployment

Running on the homelab as PM2 process `snapsher` on `127.0.0.1:3005`, behind Cloudflare Tunnel at `snapsher.com` (and `www.snapsher.com`).

```bash
rsync -az --delete --exclude certs ./ irrssue@homelab:~/snapsher/
ssh irrssue@homelab 'pm2 restart snapsher --update-env'
```

## What this does not do

- **No Bluetooth.** Web Bluetooth is GATT-only and a browser cannot act as a peripheral, so browser-to-browser Bluetooth transfer is not possible at all. Safari has no Web Bluetooth either. Both devices need a camera and a screen, in the same room, in view of each other.
- **No back-channel.** The sender can't know when the receiver is done, or whether it's even there — see "Transport" above.
- **No choosing the save location.** Received files go wherever the browser saves downloads. A web page cannot write to Photos or to a specific folder.
- **No video.** Any file type transfers, but nothing is done to preview or handle video specially.
- **Memory-bound, and now more so.** The receiver holds the whole batch in memory and only writes files out once the entire fountain payload has reassembled — there's no partial/streaming save. Combined with optical transfer's much lower throughput, the sane batch size is far smaller than the old WebRTC path's, hence the 20 MB cap above.

# snapsher

Peer-to-peer file sharing between two browsers on the same network.
Files travel device-to-device over WebRTC; the server only relays a handful of signalling messages and never sees the file.

```bash
node server.js
```

Then open `https://<your-lan-ip>:8443` on both devices and accept the self-signed certificate.
`http://localhost:8442` is there for desktop development only.
Camera access needs a secure context, so a plain `http://` LAN address cannot scan.

Set `TLS=0` when something upstream already terminates TLS, and the server binds plain HTTP to `127.0.0.1:$PORT` instead.

One device picks one or more files and shows a circle code.
The other opens the app, taps **Scan a code**, points its camera at the first device, and the files download.
Each one saves itself as it arrives, so a batch is a single "download several files?" prompt and nothing else.
A batch is capped at 500 MB in total, since the receiver assembles each file in memory.
The sender's URL also carries the session id, so it can be pasted or messaged as a fallback when scanning isn't practical.

## Transport

The direct path is a WebRTC DataChannel.
On the same WiFi, ICE settles on host candidates and the file goes device-to-device at LAN speed without touching the server.

Some networks block device-to-device traffic entirely (AP isolation, common on guest WiFi).
When the data channel has not opened after six seconds, the sender POSTs the files to `/relay/<room>`, one request each, and the receiver polls that URL and collects them one per response.
Each response repeats the batch size, so the receiver knows to keep polling through the 404s while the next file is still uploading.
Files sit in the server's memory until collected, are dropped on pickup, and expire after ten minutes.
Relayed files do pass through the server, unlike the direct path.

Limits on the relay: 25 MB per room however many files that is, 10 rooms pending at once, 60 uploads per IP per ten minutes.
The 500 MB batch limit is a direct-path allowance; a batch that big has to go device-to-device.

## Deployment

Running on the homelab as PM2 process `snapsher` on `127.0.0.1:3005`, behind Cloudflare Tunnel at `snapsher.com` (and `www.snapsher.com`).

```bash
rsync -az --delete --exclude certs ./ irrssue@homelab:~/snapsher/
ssh irrssue@homelab 'pm2 restart snapsher --update-env'
```

The signalling channel is a long-lived SSE stream and the tunnel cuts connections at 100 seconds.
`EventSource` reconnects on its own, so a share that takes longer than that recovers rather than failing, but expect a reconnect in the logs.

## The circle code

A center dot with two concentric rings of 24 sectors.
Sector 0 of each ring is always filled and sector 1 always empty, which gives the decoder its rotation reference.
The remaining 44 bits hold a 36-bit session id and an 8-bit checksum.

Decoding runs entirely in `public/circle.js`: Otsu threshold, connected-component search for the center dot, polar sampling of both rings, then a check across all 24 rotations.
Measured against canvas-rendered codes at random sizes and rotations: 189/200 frames read correctly, 0 misread, the rest simply not read (the scanner just tries the next frame).

`node test.mjs` rasterises a code in pure JavaScript and decodes it back.

## What this does not do

- **No Bluetooth.** Web Bluetooth is GATT-only and a browser cannot act as a peripheral, so browser-to-browser Bluetooth transfer is not possible at all. Safari has no Web Bluetooth either. Both devices need to be on a network.
- **No choosing the save location.** Received files go wherever the browser saves downloads. A web page cannot write to Photos or to a specific folder.
- **No video.** Any file type transfers, but nothing is done to preview or handle video specially.
- **Memory-bound.** The receiver assembles each file in memory before saving it, so very large files will struggle on phones. Hence the 500 MB cap on a batch.

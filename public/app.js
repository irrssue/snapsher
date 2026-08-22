import * as qr from './qr.js?v=DEV';
import { Encoder, Decoder } from './fountain.js?v=DEV';

const $ = (id) => document.getElementById(id);

// Tunable, unverified against real hardware yet — see history.md.
const SEND_INTERVAL = 70; // ms between drawn frames (~14fps)
const SCAN_INTERVAL = 90; // ms between camera decode attempts (~11fps)
const CAPTURE = 480; // camera capture crop, px — more than circle.js used, QR needs finer resolution
const NO_SIGNAL_AFTER = 4000; // ms with nothing decoded before nudging the user

// Optical transfer is far slower than the old LAN WebRTC path was, so the
// sensible batch size is much smaller too. This is a guess pending a real
// throughput number from actual devices.
const BATCH_MAX = 20 << 20;

const show = (name) => {
  for (const s of document.querySelectorAll('section')) s.hidden = s.id !== name;
};
const pct = (el, v) => (el.style.width = `${Math.round(v * 100)}%`);

// Whatever loop is currently live, so Cancel can tear it down. There's no
// network peer to notify any more — cancelling just stops locally.
let active = null;

window.cancelTransfer = () => {
  const a = active;
  active = null;
  a?.stop();
  location.href = '/';
};

// ---- batch container: manifest + concatenated file bytes, as one fountain payload ----

function packBatch(files, bytesList) {
  const manifest = JSON.stringify(files.map((f, i) => ({ name: f.name, size: bytesList[i].length, type: f.type })));
  const manifestBytes = new TextEncoder().encode(manifest);
  const total = 4 + manifestBytes.length + bytesList.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, manifestBytes.length, false);
  out.set(manifestBytes, 4);
  let off = 4 + manifestBytes.length;
  for (const b of bytesList) { out.set(b, off); off += b.length; }
  return out;
}

function unpackBatch(payload) {
  const mlen = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
  const manifest = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + mlen)));
  let off = 4 + mlen;
  return manifest.map((m) => {
    const bytes = payload.subarray(off, off + m.size);
    off += m.size;
    return { name: m.name, type: m.type, bytes };
  });
}

// ---- sending ----

$('pick').onchange = (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > BATCH_MAX) {
    $('homeStatus').textContent =
      `${Math.round(bytes / (1 << 20))} MB is too much for optical transfer. Keep a batch under ${BATCH_MAX >> 20} MB.`;
    e.target.value = ''; // so picking the same set again still fires onchange
    return;
  }
  $('homeStatus').textContent = '';
  send(files);
};

async function send(files) {
  show('code');
  $('sendStatus').textContent = 'Preparing…';

  const bytesList = await Promise.all(files.map((f) => f.arrayBuffer().then((b) => new Uint8Array(b))));
  const enc = new Encoder(packBatch(files, bytesList));

  const cv = $('canvas');
  const ctx = cv.getContext('2d');
  let seq = 0;
  let stopped = false;
  active = { stop: () => { stopped = true; } };

  $('sendStatus').textContent = 'Point the other device’s camera at this code';
  const loop = () => {
    if (stopped) return;
    qr.draw(ctx, qr.encode(enc.frame(seq)), cv.width);
    // There's no back-channel, so this can't show real progress — only that a
    // sweep of all blocks is cycling, which is the best honest signal available.
    pct($('sendBar'), (seq % enc.k) / enc.k);
    seq++;
    setTimeout(loop, SEND_INTERVAL);
  };
  loop();
}

// ---- receiving ----

$('scanBtn').onclick = async () => {
  show('scan');
  const video = $('video');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    $('scanStatus').textContent = 'No camera access. Snapsher must be served over HTTPS.';
    return;
  }
  video.srcObject = stream;
  await video.play();
  receive(video, stream);
};

function receive(video, stream) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = CAPTURE;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const gray = new Uint8Array(CAPTURE * CAPTURE);
  const dec = new Decoder();

  let stopped = false;
  let nextClick = 0; // earliest a download may fire, so a batch's saves stay spaced out
  let sawFrame = false;
  active = { stop: () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); } };

  $('scanStatus').textContent = 'Looking for a code…';
  $('saved').textContent = '';
  const noSignal = setTimeout(() => {
    if (!sawFrame) $('scanStatus').textContent = 'Still looking… hold the phone steady and a little closer';
  }, NO_SIGNAL_AFTER);

  // Browsers gate a *run* of auto-triggered downloads behind one permission
  // prompt; each file also keeps its link on screen for a browser that blocks
  // anyway. Small files finish within a millisecond of each other here (the
  // whole batch reassembles at once), so saves are spaced out or the prompt
  // collapses down to just the first.
  const save = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.className = 'btn';
    a.textContent = `Save ${name}`;
    $('saved').appendChild(a);
    const at = Math.max(Date.now(), nextClick);
    nextClick = at + 400;
    setTimeout(() => a.click(), at - Date.now());
  };

  const finish = () => {
    clearTimeout(noSignal);
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    const payload = dec.assemble();
    if (!payload) {
      $('scanStatus').textContent = 'Transfer corrupted. Ask the sender to try again.';
      return;
    }
    const batch = unpackBatch(payload);
    for (const f of batch) save(new Blob([f.bytes], { type: f.type || 'application/octet-stream' }), f.name);
    pct($('recvBar'), 1);
    $('scanStatus').textContent = batch.length > 1 ? `Saved ${batch.length} files` : `Saved ${batch[0].name}`;
  };

  const tick = () => {
    if (stopped) return;
    if (video.videoWidth) {
      const side = Math.min(video.videoWidth, video.videoHeight);
      ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, CAPTURE, CAPTURE);
      const d = ctx.getImageData(0, 0, CAPTURE, CAPTURE).data;
      for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 151 + d[i * 4 + 2] * 28) >> 8;
      const frame = qr.decode(gray, CAPTURE, CAPTURE);
      if (frame && dec.addFrame(frame)) {
        if (!sawFrame) { sawFrame = true; $('scanStatus').textContent = 'Receiving…'; }
        if (dec.k) pct($('recvBar'), dec.solvedCount / dec.k);
        if (dec.complete) return void finish();
      }
    }
    setTimeout(tick, SCAN_INTERVAL);
  };
  tick();
}

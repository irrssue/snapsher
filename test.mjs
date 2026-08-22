// Self-check: rasterize QR frames in pure JS and decode them back, round-trip
// the fountain layer with simulated frame loss, and confirm the server still
// serves the app's own files.
import assert from 'node:assert';
import * as qr from './public/qr.js';
import { Encoder, Decoder, BLOCK_LEN } from './public/fountain.js';

/** Rasterizes a module grid at an arbitrary rotation, no Canvas2D involved.
 *  Margin has to clear a rotated square's bounding box (up to sqrt(2) at 45°)
 *  or the code clips off the synthetic canvas — that isn't a decoder bug. */
function raster(bits, size, rot) {
  const scale = size / (qr.N * 1.6);
  const g = new Uint8Array(size * size); // background = 0, matching qr.draw()'s black page
  const cx = size / 2, cy = size / 2;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const half = (qr.N * scale) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const ux = dx * cos + dy * sin;
      const uy = -dx * sin + dy * cos;
      const c = Math.floor((ux + half) / scale);
      const r = Math.floor((uy + half) / scale);
      if (r < 0 || c < 0 || r >= qr.N || c >= qr.N) continue;
      g[y * size + x] = bits[r * qr.N + c] ? 255 : 0;
    }
  }
  return g;
}

for (const rot of [0, 0.2, -0.15, 0.5, 1.0, -0.6, 2.9]) {
  const payload = new Uint8Array(qr.DATA_BYTES);
  crypto.getRandomValues(payload);
  const bits = qr.encode(payload);
  const gray = raster(bits, 300, rot);
  const out = qr.decode(gray, 300, 300);
  assert.ok(out, `qr decode failed at rot=${rot}`);
  assert.deepEqual([...out], [...payload], `qr payload mismatch at rot=${rot}`);
}

// Frames with no code in them must not produce a false positive.
assert.equal(qr.decode(new Uint8Array(300 * 300).fill(0), 300, 300), null);
assert.equal(qr.decode(new Uint8Array(300 * 300).fill(255), 300, 300), null);

// Fountain: a receiver that misses a third of the frames must still recover
// the exact original bytes, in no particular order, with no back-channel.
{
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(500);
  const payload = new TextEncoder().encode(text);
  const enc = new Encoder(payload);
  const dec = new Decoder();
  let seq = 0;
  while (!dec.complete) {
    const frame = enc.frame(seq++);
    if (Math.random() < 0.35) continue; // simulated loss
    dec.addFrame(frame);
    assert.ok(seq < enc.k * 30, 'fountain decoder did not converge');
  }
  const out = dec.assemble();
  assert.ok(out, 'fountain assemble failed');
  assert.equal(new TextDecoder().decode(out), text);
}

// A frame from an unrelated stream (bogus magic byte) must be ignored, not crash the decoder.
{
  const dec = new Decoder();
  const junk = new Uint8Array(BLOCK_LEN + 15).fill(7);
  assert.equal(dec.addFrame(junk), false);
}

// The server still just serves the app's own static files, version-stamped.
{
  const { spawn } = await import('node:child_process');
  const PORT = 8466;
  const base = `http://127.0.0.1:${PORT}`;
  const srv = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, TLS: '0', PORT: String(PORT) },
    cwd: import.meta.dirname,
    stdio: 'ignore',
  });

  for (let i = 0; ; i++) {
    try { await fetch(base); break; } catch { assert.ok(i < 50, 'server never came up'); await new Promise((r) => setTimeout(r, 100)); }
  }

  const html = await (await fetch(base)).text();
  assert.match(html, /app\.js\?v=[0-9a-f]{8}/, 'index.html was not version-stamped');

  for (const f of ['app.js', 'qr.js', 'fountain.js', 'style.css']) {
    const res = await fetch(`${base}/${f}`);
    assert.equal(res.status, 200, `${f} did not serve`);
  }
  assert.equal((await fetch(`${base}/nope`)).status, 404);

  srv.kill();
}

console.log('ok');

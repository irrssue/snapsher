// Snapsher QR frame: a bespoke, QR-*shaped* code (three finder patterns, a
// timing pattern, one alignment pattern, Reed-Solomon-checked payload) sized
// and laid out for this app only. It is not ISO/IEC 18004 — no version info,
// no format info, a fixed single mask, and a plain raster data order instead
// of the spec's zigzag — because the encoder and decoder here are always each
// other's only reader. See history.md for why that trade was made.
//
// Every frame carries exactly DATA_BYTES of payload (fountain.js pads/trims
// to that), protected by Reed-Solomon parity that is *verified, not
// corrected*: a frame with any bit error is dropped rather than repaired.
// Corruption and erasure are different problems, and dropping is cheap here —
// the fountain layer already assumes frames go missing and carries on. That
// also means this file never implements Berlekamp-Massey/Chien/Forney, only
// syndrome computation, which is a much smaller and safer thing to hand-write
// without a real device to test against.

// N and EC_FRACTION were raised from the original 41 / 0.2 after simulating
// realistic captures (tight framing edge-to-edge, gaussian blur, up to ~11.5°
// tilt, sensor noise): 55 modules is the largest grid that still decoded
// every simulated frame, and 0.08 still leaves 27 RS parity bytes — far more
// than the handful needed for detection-only validation (a false-accepted
// corrupt frame needs every one of those syndromes to hit zero by chance).
// Together with EC_FRACTION this roughly doubles payload bytes per frame.
// Still simulation-only, not real-device-verified — see history.md.
export const N = 55; // modules per side
const EC_FRACTION = 0.08; // share of the frame's codewords spent on Reed-Solomon parity

// ---- GF(256) arithmetic, primitive polynomial 0x11D (the standard QR field) ----

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

/** Reed-Solomon generator polynomial for `nsym` parity symbols, highest-degree coefficient first. */
function rsGeneratorPoly(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]; // g(x) * x
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]); // - alpha^i * g(x)
    }
    g = next;
  }
  return g;
}

/** Systematic RS encode: `data` codewords in, `nsym` parity codewords out. */
function rsEncode(data, nsym) {
  const gen = rsGeneratorPoly(nsym);
  const buf = new Uint8Array(data.length + nsym);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], factor);
  }
  return buf.subarray(data.length);
}

/** True iff `codewords` (data ++ parity, highest-degree first) evaluates to zero at every parity root. */
function rsValid(codewords, nsym) {
  for (let i = 0; i < nsym; i++) {
    let s = 0;
    for (let j = 0; j < codewords.length; j++) s = gfMul(s, GF_EXP[i]) ^ codewords[j];
    if (s !== 0) return false;
  }
  return true;
}

// ---- module geometry ----
// KIND classifies every module once at load: function pattern (dark/light) or free (data).

const FREE_KIND = 0, DARK = 1, LIGHT = 2;
const FINDER_CENTERS = [
  [3, 3],
  [3, N - 4],
  [N - 4, 3],
];
const ALIGN_CENTER = N - 9;

const KIND = new Uint8Array(N * N).fill(FREE_KIND);
const setKind = (r, c, k) => {
  if (r >= 0 && c >= 0 && r < N && c < N) KIND[r * N + c] = k;
};

for (const [fr, fc] of FINDER_CENTERS) {
  // 7x7 finder (concentric dark/light/dark) + 1-module light separator ring around it
  for (let dr = -4; dr <= 4; dr++) {
    for (let dc = -4; dc <= 4; dc++) {
      const m = Math.max(Math.abs(dr), Math.abs(dc));
      setKind(fr + dr, fc + dc, m === 4 ? LIGHT : m === 3 ? DARK : m === 2 ? LIGHT : DARK);
    }
  }
}
for (let i = 0; i < N; i++) {
  // timing pattern, only where a finder/separator hasn't already claimed the module
  if (KIND[6 * N + i] === FREE_KIND) setKind(6, i, i % 2 === 0 ? DARK : LIGHT);
  if (KIND[i * N + 6] === FREE_KIND) setKind(i, 6, i % 2 === 0 ? DARK : LIGHT);
}
for (let dr = -2; dr <= 2; dr++) {
  for (let dc = -2; dc <= 2; dc++) {
    // 5x5 alignment pattern, concentric dark/light/dark
    const m = Math.max(Math.abs(dr), Math.abs(dc));
    setKind(ALIGN_CENTER + dr, ALIGN_CENTER + dc, m === 1 ? LIGHT : DARK);
  }
}

const FREE = [];
for (let i = 0; i < N * N; i++) if (KIND[i] === FREE_KIND) FREE.push(i);

const CAP_BYTES = FREE.length >> 3;
export const EC_BYTES = Math.max(2, Math.round(CAP_BYTES * EC_FRACTION));
export const DATA_BYTES = CAP_BYTES - EC_BYTES;

const mask = (r, c) => ((r + c) % 2 === 0 ? 1 : 0);

// ---- encode + draw ----

/** `bytes` (length DATA_BYTES) -> a length-N*N array of 1 (printed) / 0 (background) modules. */
export function encode(bytes) {
  if (bytes.length !== DATA_BYTES) throw new Error(`qr: payload must be ${DATA_BYTES} bytes`);
  const ec = rsEncode(bytes, EC_BYTES);
  const codewords = new Uint8Array(CAP_BYTES);
  codewords.set(bytes, 0);
  codewords.set(ec, DATA_BYTES);

  const bits = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) if (KIND[i] === DARK) bits[i] = 1;

  const totalBits = codewords.length * 8;
  for (let i = 0; i < FREE.length; i++) {
    const idx = FREE[i];
    const r = (idx / N) | 0, c = idx % N;
    const bit = i < totalBits ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0;
    bits[idx] = bit ^ mask(r, c);
  }
  return bits;
}

// Standard QR quiet-zone width (4 modules of background) baked around the
// grid itself, not left to incidental black space on the page. Scanning a
// phone screen means the receiver's camera frame is often filled edge-to-edge
// by the sender's screen — with no margin drawn into the code, that leaves
// zero quiet zone and every sample at the frame's own edge falls outside the
// captured image, so tryDecodeFrom() rejects the whole frame every time.
// Simulated tight-framing + blur + rotation captures fail almost completely
// at 0 margin and pass 100% at 4 modules, matching the real QR spec's number.
const QUIET = 4;

/** Light-on-dark, matching the rest of the app: printed modules are white on a black square. */
export function draw(ctx, bits, size) {
  const m = size / (N + QUIET * 2);
  const off = QUIET * m;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (bits[r * N + c]) ctx.fillRect(Math.round(off + c * m), Math.round(off + r * m), Math.ceil(m), Math.ceil(m));
    }
  }
}

// ---- camera decoding ----

function otsu(gray) {
  const h = new Uint32Array(256);
  for (const v of gray) h[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * h[i];
  let sumB = 0, wB = 0, best = -1, lo = 128, hi = 128;
  for (let i = 0; i < 256; i++) {
    wB += h[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * h[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; lo = hi = i; } else if (between === best) hi = i;
  }
  return (lo + hi) >> 1;
}

/** Runs a 1:1:3:1:1 finder-pattern scan along one line; reports (center, unit) for each match. */
function scanRuns(pixelAt, length, onMatch) {
  let color = pixelAt(0);
  let runStart = 0;
  const runs = [0, 0, 0, 0, 0];
  let n = 0;
  for (let x = 1; x <= length; x++) {
    const p = x < length ? pixelAt(x) : color ^ 1; // force one final flush past the end
    if (p === color) continue;
    const runLen = x - runStart;
    runs[0] = runs[1]; runs[1] = runs[2]; runs[2] = runs[3]; runs[3] = runs[4]; runs[4] = runLen;
    n++;
    if (n >= 5 && color === 1) {
      const unit = (runs[0] + runs[1] + runs[3] + runs[4]) / 4;
      if (unit >= 1) {
        const ratio = runs[2] / unit;
        const outerOk = [runs[0], runs[1], runs[3], runs[4]].every((v) => v > unit * 0.4 && v < unit * 1.8);
        if (ratio > 2 && ratio < 4.5 && outerOk) {
          const seg2End = runStart - runs[3];
          const center = seg2End - runs[2] / 2;
          onMatch(center, unit);
        }
      }
    }
    runStart = x;
    color = p;
  }
}

function findFinderCandidates(bit, w, h) {
  const found = [];
  for (let y = 0; y < h; y++) {
    scanRuns((x) => bit[y * w + x], w, (cx, unit) => {
      const x0 = Math.round(cx);
      if (x0 < 0 || x0 >= w) return;
      let best = null;
      scanRuns((yy) => bit[yy * w + x0], h, (cy, u2) => {
        if (!best || Math.abs(cy - y) < Math.abs(best.cy - y)) best = { cy, u2 };
      });
      if (!best || Math.abs(best.cy - y) > unit * 2) return;
      found.push({ x: cx, y: best.cy, unit: (unit + best.u2) / 2 });
    });
  }
  return found;
}

/** Greedily merges nearby candidate points into one center per finder blob. */
function cluster(points) {
  const out = [];
  for (const p of points) {
    const c = out.find((c) => Math.hypot(c.x / c.n - p.x, c.y / c.n - p.y) < p.unit * 1.5);
    if (c) { c.x += p.x; c.y += p.y; c.unit += p.unit; c.n++; }
    else out.push({ x: p.x, y: p.y, unit: p.unit, n: 1 });
  }
  return out.map((c) => ({ x: c.x / c.n, y: c.y / c.n, unit: c.unit / c.n, n: c.n }));
}

/** Given 3 finder-blob candidates, decide which (if any) form a valid top-left/right/bottom-left triple. */
function classifyTriple(pts) {
  for (let ci = 0; ci < 3; ci++) {
    const corner = pts[ci];
    const [p, q] = pts.filter((_, i) => i !== ci);
    const dCP = Math.hypot(p.x - corner.x, p.y - corner.y);
    const dCQ = Math.hypot(q.x - corner.x, q.y - corner.y);
    const dPQ = Math.hypot(p.x - q.x, p.y - q.y);
    const avgUnit = (corner.unit + p.unit + q.unit) / 3;
    if (avgUnit < 1 || dCP < avgUnit * (N - 7) * 0.4 || dCQ < avgUnit * (N - 7) * 0.4) continue;
    const legRatio = dCP / dCQ;
    if (legRatio < 0.6 || legRatio > 1.67) continue;
    const expectedHyp = Math.hypot(dCP, dCQ);
    if (Math.abs(dPQ - expectedHyp) > expectedHyp * 0.25) continue;
    const v1x = p.x - corner.x, v1y = p.y - corner.y;
    const v2x = q.x - corner.x, v2y = q.y - corner.y;
    const cross = v1x * v2y - v1y * v2x; // > 0 when p is to the right and q is below (un-mirrored camera)
    const [topRight, bottomLeft] = cross > 0 ? [p, q] : [q, p];
    return { topLeft: corner, topRight, bottomLeft };
  }
  return null;
}

/** Samples the full module grid through the affine frame the triple implies, then RS-verifies it. */
function tryDecodeFrom(bit, w, h, { topLeft, topRight, bottomLeft }) {
  const span = N - 7;
  const ux = (topRight.x - topLeft.x) / span, uy = (topRight.y - topLeft.y) / span;
  const vx = (bottomLeft.x - topLeft.x) / span, vy = (bottomLeft.y - topLeft.y) / span;

  // Tilting the receiving camera relative to a flat sender screen rotates the
  // code's bounding box out past the frame's own edges — that's normal
  // handheld geometry, not damage, and it only ever clips the handful of
  // modules nearest a corner. Clamping to the nearest in-bounds pixel instead
  // of rejecting the whole frame turns that into (at worst) a couple of wrong
  // bits, which RS validation below still catches same as any other bit
  // error; the old behaviour discarded every frame at anything past a few
  // degrees of tilt for no reason tied to actual decode failure.
  const sample = (r, c) => {
    const px = topLeft.x + ux * (c - 3) + vx * (r - 3);
    const py = topLeft.y + uy * (c - 3) + vy * (r - 3);
    const x = Math.min(w - 1, Math.max(0, Math.round(px)));
    const y = Math.min(h - 1, Math.max(0, Math.round(py)));
    return bit[y * w + x];
  };

  const codewords = new Uint8Array(CAP_BYTES);
  const totalBits = CAP_BYTES * 8;
  for (let i = 0; i < FREE.length && i < totalBits; i++) {
    const idx = FREE[i];
    const r = (idx / N) | 0, c = idx % N;
    const bitVal = sample(r, c) ^ mask(r, c);
    if (bitVal) codewords[i >> 3] |= 1 << (7 - (i & 7));
  }
  if (!rsValid(codewords, EC_BYTES)) return null;
  return codewords.slice(0, DATA_BYTES);
}

/** grayscale frame -> DATA_BYTES payload, or null */
export function decode(gray, w, h) {
  const inv = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) inv[i] = 255 - gray[i];
  const thr = otsu(inv);
  const bit = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bit[i] = inv[i] < thr ? 1 : 0;

  const candidates = cluster(findFinderCandidates(bit, w, h))
    .filter((c) => c.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
  if (candidates.length < 3) return null;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        const tri = classifyTriple([candidates[i], candidates[j], candidates[k]]);
        if (!tri) continue;
        const payload = tryDecodeFrom(bit, w, h, tri);
        if (payload) return payload;
      }
    }
  }
  return null;
}

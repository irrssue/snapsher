// Snapsher circle code: a center dot + two concentric rings of 24 sectors.
// Sector 0 of each ring is always filled and sector 1 always empty -> rotation marker.
// Remaining 44 bits carry a 36-bit (9 hex char) session id + an 8-bit checksum.
// The checksum has to be wide: the decoder tries all 24 rotations, so a narrow
// one lets a misaligned read pass and yields a plausible but wrong id.

export const N = 24; // sectors per ring
// Geometry in canvas units, relative to a 128-unit code radius.
export const G = { dot: 28, r0in: 45, r0out: 75, r1in: 85, r1out: 115, r: 128 };
const MID0 = (G.r0in + G.r0out) / 2 / G.dot; // ring radii expressed in dot-radii
const MID1 = (G.r1in + G.r1out) / 2 / G.dot;

export const ID_LEN = 9;

export const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(ID_LEN))].map((b) => (b & 15).toString(16)).join('');

const nibbles = (hex) => [...hex].map((c) => parseInt(c, 16));
const check = (hex) => nibbles(hex).reduce((s, v) => (s * 17 + v) & 255, 0);
const pack = (v, n) => Array.from({ length: n }, (_, i) => (v >> (n - 1 - i)) & 1);

/** hex(9) -> {ring0, ring1} arrays of 24 bits each */
export function encode(hex) {
  const bits = nibbles(hex).flatMap((v) => pack(v, 4)).concat(pack(check(hex), 8)); // 44
  return {
    ring0: [1, 0, ...bits.slice(0, 22)],
    ring1: [1, 0, ...bits.slice(22, 44)],
  };
}

/** two 24-bit rings -> hex(9), or null if the markers or checksum don't hold */
export function decodeBits(ring0, ring1) {
  if (ring0[0] !== 1 || ring0[1] !== 0 || ring1[0] !== 1 || ring1[1] !== 0) return null;
  const bits = [...ring0.slice(2), ...ring1.slice(2)];
  const num = (at, n) => bits.slice(at, at + n).reduce((a, b) => (a << 1) | b, 0);
  let hex = '';
  for (let i = 0; i < ID_LEN * 4; i += 4) hex += num(i, 4).toString(16);
  return check(hex) === num(ID_LEN * 4, 8) ? hex : null;
}

// Deterministic PRNG so the same id always stipples the same way — a redraw
// (resize, re-render) must not reshuffle the dust under the camera.
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
/** ~unit-variance bell, three uniforms deep — enough for a soft edge. */
const bell = (rnd) => (rnd() + rnd() + rnd() - 1.5) * 1.15;

/** `t` (seconds) only drifts the loose dust; every decoder-sampled pixel is static. */
export function draw(ctx, hex, size, t = 0) {
  const s = size / (G.r * 2.35); // leave breathing room around the code
  const cx = size / 2;
  const cy = size / 2;
  const { ring0, ring1 } = encode(hex);
  const rnd = rng(check(hex) + 1);
  const px = Math.max(1, size / 430); // dust grain, ~1.2px on the 512 canvas

  // Light on dark: the code glows out of the page instead of sitting on a
  // white coin. `decode` inverts the camera frame to match.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  // Bulb flicker: two beating sines, so the dip pattern reads as irregular
  // without any state. Floor is 0.86 - the centre dot has to stay clearly the
  // brightest blob in the frame or `blobs` stops finding the code.
  const bulb = 0.86 + 0.14 * (0.5 + 0.5 * Math.sin(t * 3.1)) * (0.5 + 0.5 * Math.sin(t * 7.7));

  // Faint halo, well under the wedge brightness so it never reads as a bit.
  const halo = ctx.createRadialGradient(cx, cy, G.dot * s, cx, cy, G.r * s * 1.3);
  halo.addColorStop(0, `rgba(255,255,255,${0.13 * bulb})`);
  halo.addColorStop(0.35, `rgba(255,255,255,${0.055 * bulb})`);
  halo.addColorStop(0.65, `rgba(255,255,255,${0.018 * bulb})`);
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  // Solid centre dot: the decoder finds the code by looking for this blob, so
  // it stays a filled disc at full size and never gets stippled - only its
  // brightness flickers.
  const v = Math.round(255 * bulb);
  ctx.fillStyle = `rgb(${v},${v},${v})`;
  ctx.beginPath();
  ctx.arc(cx, cy, G.dot * s, 0, 7);
  ctx.fill();

  const grain = (r, a, alpha, dx = 0, dy = 0) => {
    ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
    const x = cx + (r * Math.cos(a) + dx) * s - px / 2;
    const y = cy + (r * Math.sin(a) + dy) * s - px / 2;
    ctx.fillRect(x, y, px, px);
  };

  for (const [bits, rin, rout] of [
    [ring0, G.r0in, G.r0out],
    [ring1, G.r1in, G.r1out],
  ]) {
    for (let k = 0; k < N; k++) {
      if (!bits[k]) continue;
      // Solid core, dusty edge. Pure stipple aliases away when the camera
      // downsamples the grain, so the sector keeps an inset filled body and
      // the dust only softens its boundary.
      // The body keeps the original wedge gap: widening it leaves the decoder
      // sampling white when the code is read half a sector out of alignment.
      const pad = (Math.PI / N) * 0.16;
      const a0 = (k / N) * 2 * Math.PI + pad;
      const a1 = ((k + 1) / N) * 2 * Math.PI - pad;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      // Radial inset of 6 is the most the decoder tolerates: it samples the
      // ring mid ±0.12 dot-radii, i.e. ±3.4 units either side of the middle.
      ctx.arc(cx, cy, (rout - 6) * s, a0, a1);
      ctx.arc(cx, cy, (rin + 6) * s, a1, a0, true);
      ctx.closePath();
      ctx.fill();

      const area = ((rout * rout - rin * rin) / 2) * (2 * Math.PI / N) * s * s;
      const n = Math.round(area / 0.5);
      for (let i = 0; i < n; i++) {
        // Grains spill radially only. Angular spill would darken the gap a
        // neighbouring 0-sector is read through when the code sits half a
        // sector off the decoder's grid.
        const r = Math.sqrt(rin * rin + rnd() * (rout * rout - rin * rin)) + bell(rnd) * 5;
        const a = ((k + 0.09 + 0.82 * rnd()) / N) * 2 * Math.PI;
        grain(r, a, 0.5 + 0.5 * rnd());
      }
    }
  }

  // Loose dust: only in the bands the decoder never samples (the ring gap and
  // outside the outer ring), purely to sell the cloud.
  for (const [lo, hi, alpha] of [[G.r0out + 4, G.r1in - 4, 0.3], [G.r1out + 5, G.r * 1.14, 0.22]]) {
    const n = Math.round((hi * hi - lo * lo) * s * s * 0.06);
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(lo * lo + rnd() * (hi * hi - lo * lo));
      const a = rnd() * 7;
      // Each grain wanders on its own two-frequency Lissajous path: a random
      // direction that curves back on itself, so nothing drifts out of its band.
      const amp = 2 + 3 * rnd();
      const [wx, wy, phx, phy] = [0.3 + rnd() * 0.5, 0.3 + rnd() * 0.5, rnd() * 7, rnd() * 7];
      grain(r, a, alpha * rnd(), amp * Math.sin(t * wx + phx), amp * Math.sin(t * wy + phy));
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
    // Empty histogram bins tie with the previous score; straddle the whole
    // plateau instead of clamping to its first index.
    if (between > best) { best = between; lo = hi = i; } else if (between === best) hi = i;
  }
  return (lo + hi) >> 1;
}

/** Round-ish dark blobs, largest first — candidates for the center dot. */
function blobs(dark, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (!dark[p] || seen[p]) continue;
    let top = 0, area = 0, sx = 0, sy = 0;
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    stack[top++] = p;
    seen[p] = 1;
    while (top) {
      const q = stack[--top];
      const x = q % w, y = (q / w) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && dark[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack[top++] = q - 1; }
      if (x < w - 1 && dark[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack[top++] = q + 1; }
      if (y > 0 && dark[q - w] && !seen[q - w]) { seen[q - w] = 1; stack[top++] = q - w; }
      if (y < h - 1 && dark[q + w] && !seen[q + w]) { seen[q + w] = 1; stack[top++] = q + w; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (area < 40) continue;
    if (bw / bh < 0.7 || bw / bh > 1.4) continue;
    if (area / (bw * bh) < 0.6) continue; // filled, not an arc
    out.push({ x: sx / area, y: sy / area, r: Math.sqrt(area / Math.PI) });
  }
  return out.sort((a, b) => b.r - a.r).slice(0, 8);
}

/** grayscale frame -> session id hex, or null */
export function decode(gray, w, h) {
  // The code is drawn light-on-dark, so invert once here and the rest of the
  // pipeline (blob search, sector means) keeps working on "dark = ink".
  gray = gray.map((v) => 255 - v);
  const thr = otsu(gray);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = gray[i] < thr ? 1 : 0;

  for (const dot of blobs(dark, w, h)) {
    if (dot.r * MID1 > Math.min(w, h) / 2) continue; // rings would fall outside the frame
    const mean = [];
    for (const mid of [MID0, MID1]) {
      for (let k = 0; k < N; k++) {
        let sum = 0, n = 0;
        // Stay well inside each sector: the drawn wedges have gaps at their
        // edges, and a slightly off-centre dot smears the outer samples.
        for (let ri = -1; ri <= 1; ri++) {
          const rad = dot.r * (mid + ri * 0.12);
          for (let ai = 0; ai < 5; ai++) {
            const a = ((k + 0.3 + (ai / 4) * 0.4) / N) * 2 * Math.PI;
            const x = Math.round(dot.x + rad * Math.cos(a));
            const y = Math.round(dot.y + rad * Math.sin(a));
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            sum += gray[y * w + x];
            n++;
          }
        }
        mean.push(n ? sum / n : 255);
      }
    }
    const lo = Math.min(...mean), hi = Math.max(...mean);
    if (hi - lo < 40) continue; // no contrast, not a code
    const bit = mean.map((m) => (m < (lo + hi) / 2 ? 1 : 0));

    // Accept only if exactly one rotation decodes. Two means we can't tell which
    // is the real alignment, so drop the frame rather than guess.
    const hits = new Set();
    for (let off = 0; off < N; off++) {
      const r0 = [], r1 = [];
      for (let k = 0; k < N; k++) {
        r0.push(bit[(k + off) % N]);
        r1.push(bit[N + ((k + off) % N)]);
      }
      const hex = decodeBits(r0, r1);
      if (hex) hits.add(hex);
    }
    if (hits.size === 1) return [...hits][0];
  }
  return null;
}

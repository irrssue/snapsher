// The one-way channel layer: turns a byte payload into an endless carousel of
// fixed-size frames that a receiver can lock onto from any point and finish
// from any ~k of them, in any order. This is an independent, from-scratch
// implementation of the well-known idea behind Luby Transform / fountain
// codes (a systematic sweep of the k source blocks, followed by repair
// frames XORing a pseudorandom subset) — not a port of any particular
// project's code.
//
// No back-channel and no handshake: every frame carries its own header
// (magic byte, session id, sequence number, total payload length, a
// checksum of the whole payload), so a receiver that starts watching
// mid-stream just keeps whatever frames land and reassembles once it has
// enough. A new sender (new session id, or the same session sending a
// different-length payload) makes an in-progress receiver drop what it had
// and lock onto the new stream automatically.

import { DATA_BYTES } from './qr.js?v=DEV';

const MAGIC = 0x53; // 'S'
export const HEADER_LEN = 15; // magic(1) + session(2) + seq(4) + totalLen(4) + checksum(4)
export const BLOCK_LEN = DATA_BYTES - HEADER_LEN;

export const newSession = () => crypto.getRandomValues(new Uint16Array(1))[0];

// ---- small standard primitives (PRNG, hash) — public-domain algorithms, reimplemented here ----

/** Mulberry32: a tiny, fast, well-distributed 32-bit PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, 32-bit. */
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic per-frame seed from (session, seq) — sender and receiver derive this independently. */
function frameSeed(session, seq) {
  let h = (Math.imul(session ^ 0x9e3779b9, 0x85ebca6b) ^ seq) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---- carousel: which source blocks a given frame XORs together ----

const cycleLength = (k) => 2 * k;

function repairIndices(k, session, seq) {
  const rnd = mulberry32(frameSeed(session, seq));
  const degree = Math.min(k, 3 + Math.floor(rnd() * 8)); // mid-degree, 3..10
  const set = new Set();
  while (set.size < degree) set.add(Math.floor(rnd() * k));
  return [...set];
}

/** Systematic sweep (seq < k: block `seq` alone) then repair frames, forever. */
function frameIndices(k, session, seq) {
  const pos = seq % cycleLength(k);
  return pos < k ? [pos] : repairIndices(k, session, seq);
}

// ---- frame header pack/unpack ----

function packFrame(session, seq, totalLen, checksum, blockBytes) {
  const frame = new Uint8Array(DATA_BYTES);
  const view = new DataView(frame.buffer);
  frame[0] = MAGIC;
  view.setUint16(1, session, false);
  view.setUint32(3, seq >>> 0, false);
  view.setUint32(7, totalLen >>> 0, false);
  view.setUint32(11, checksum >>> 0, false);
  frame.set(blockBytes, HEADER_LEN);
  return frame;
}

function unpackHeader(frame) {
  if (frame.length !== DATA_BYTES || frame[0] !== MAGIC) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    session: view.getUint16(1, false),
    seq: view.getUint32(3, false),
    totalLen: view.getUint32(7, false),
    checksum: view.getUint32(11, false),
    block: frame.subarray(HEADER_LEN),
  };
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

// ---- sender ----

export class Encoder {
  constructor(payload, session = newSession()) {
    this.session = session;
    this.totalLen = payload.length;
    this.checksum = fnv1a(payload);
    this.k = Math.max(1, Math.ceil(payload.length / BLOCK_LEN));
    this.blocks = [];
    for (let i = 0; i < this.k; i++) {
      const b = new Uint8Array(BLOCK_LEN);
      b.set(payload.subarray(i * BLOCK_LEN, Math.min((i + 1) * BLOCK_LEN, payload.length)));
      this.blocks.push(b);
    }
  }

  /** The DATA_BYTES-sized frame for carousel position `seq`. Feed straight to qr.js's encode(). */
  frame(seq) {
    const idx = frameIndices(this.k, this.session, seq);
    const out = new Uint8Array(BLOCK_LEN);
    for (const b of idx) xorInto(out, this.blocks[b]);
    return packFrame(this.session, seq, this.totalLen, this.checksum, out);
  }
}

// ---- receiver ----

export class Decoder {
  constructor() {
    this.session = null;
  }

  get framesSeen() {
    return this.seen?.size ?? 0;
  }

  get complete() {
    return this.k != null && this.solvedCount >= this.k;
  }

  /** Feed one DATA_BYTES frame from qr.js's decode(). Returns false if it wasn't a valid frame. */
  addFrame(frame) {
    const h = unpackHeader(frame);
    if (!h) return false;
    if (this.session === null || h.session !== this.session || h.totalLen !== this.totalLen) this._start(h);
    if (this.seen.has(h.seq) || this.complete) { this.seen.add(h.seq); return true; }
    this.seen.add(h.seq);

    const idx = new Set(frameIndices(this.k, this.session, h.seq));
    const data = h.block.slice();
    for (const b of [...idx]) {
      if (this.solved[b]) { xorInto(data, this.solved[b]); idx.delete(b); }
    }
    if (idx.size === 0) return true;
    if (idx.size === 1) { this._resolve(idx.values().next().value, data); return true; }

    const pending = { idx, data };
    for (const b of idx) {
      let set = this.byBlock.get(b);
      if (!set) this.byBlock.set(b, (set = new Set()));
      set.add(pending);
    }
    return true;
  }

  _start(h) {
    this.session = h.session;
    this.totalLen = h.totalLen;
    this.checksum = h.checksum;
    this.k = Math.max(1, Math.ceil(this.totalLen / BLOCK_LEN));
    this.solved = new Array(this.k).fill(null);
    this.solvedCount = 0;
    this.seen = new Set();
    this.byBlock = new Map();
  }

  /** Peeling cascade: solving one block can free up frames that were waiting on it. */
  _resolve(b0, data0) {
    const queue = [[b0, data0]];
    while (queue.length) {
      const [b, data] = queue.pop();
      if (this.solved[b]) continue;
      this.solved[b] = data;
      this.solvedCount++;
      const waiting = this.byBlock.get(b);
      if (!waiting) continue;
      this.byBlock.delete(b);
      for (const pending of waiting) {
        xorInto(pending.data, data);
        pending.idx.delete(b);
        if (pending.idx.size === 1) {
          const r = pending.idx.values().next().value;
          this.byBlock.get(r)?.delete(pending);
          if (!this.solved[r]) queue.push([r, pending.data]);
        }
      }
    }
  }

  /** The reassembled payload, checksum-verified, or null if not complete / corrupted. */
  assemble() {
    if (!this.complete) return null;
    const out = new Uint8Array(this.totalLen);
    for (let b = 0; b < this.k; b++) {
      const start = b * BLOCK_LEN;
      const len = Math.min(BLOCK_LEN, this.totalLen - start);
      out.set(this.solved[b].subarray(0, len), start);
    }
    return fnv1a(out) === this.checksum ? out : null;
  }
}

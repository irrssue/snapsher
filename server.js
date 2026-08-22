// Static server + SSE/POST signaling relay. No deps.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Cloudflare's zone settings rewrite our `no-cache` into `max-age=14400` and
// pin JS/CSS at the edge for hours, so headers are not a lever we control.
// The URL is. Every asset reference below is written `?v=DEV` and stamped here
// with a hash of the current public/ contents: a deploy changes the hash, so
// the edge has never seen the new URLs and cannot serve a stale module.
// HTML carries the stamp and is not edge-cached, so it always arrives fresh.
const VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(PUB).sort()) h.update(fs.readFileSync(path.join(PUB, f)));
  return h.digest('hex').slice(0, 8);
})();
// room -> {queue, clients: Map(id,res), cursors: Map(id,index), gc}
// A signalling message is kept until the other device has actually read it. The
// receiver's first `join` is POSTed in the same tick its SSE stream opens, so it
// routinely arrives before that stream is registered; writing only to whoever is
// attached right now drops the sender's offer on the floor and both sides wait
// forever. The queue plus a per-client cursor makes delivery survive that gap
// and any later reconnect.
const rooms = new Map();
const QUEUE_MAX = 200; // a pairing needs a few dozen messages; past that it's junk
const ROOM_TTL = 60_000; // hold an empty room's backlog this long for a reconnect
const STALE = 20_000; // an offer or candidate older than this belongs to a dead attempt
const relays = new Map(); // room -> {count, sent, size, files: [{name, type, body}]}
const RELAY_MAX = 25 << 20; // per room, however many files it holds
const RELAY_PENDING = 10; // rooms held at once
const RELAY_PER_IP = 60; // uploads per IP per window; a batch spends one per file
const RELAY_WINDOW = 10 * 60_000;
const uploads = new Map(); // ip -> recent upload timestamps

// ponytail: naive in-memory counters, fine for a household; swap for a real
// limiter if this ever faces more than a handful of people.
function throttled(req) {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
  const now = Date.now();
  const recent = (uploads.get(ip) || []).filter((t) => now - t < RELAY_WINDOW);
  recent.push(now);
  uploads.set(ip, recent);
  return recent.length > RELAY_PER_IP;
}

const handler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  const sig = url.pathname.match(/^\/sig\/([\w-]+)\/([\w-]+)$/);
  const rly = url.pathname.match(/^\/relay\/([\w-]+)$/);

  if (sig) return signal(req, res, sig[1], sig[2]);
  if (rly) return relay(req, res, rly[1]);

  const file = path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(PUB)) return end(res, 403, 'no');
  fs.readFile(file, (err, buf) => {
    if (err) return end(res, 404, 'not found');
    // HTML and JS ship as one unit; a cached app.js against a fresh index.html
    // throws on the first missing element and silently kills every handler.
    // Stamping both keeps the whole set moving to new URLs together.
    const ext = path.extname(file);
    const body =
      ext === '.html' || ext === '.js'
        ? Buffer.from(buf.toString().replaceAll('?v=DEV', `?v=${VERSION}`))
        : buf;
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  });
};

function room(name) {
  let r = rooms.get(name);
  if (!r) rooms.set(name, (r = { queue: [], clients: new Map(), cursors: new Map(), gc: null }));
  clearTimeout(r.gc);
  r.gc = null;
  return r;
}

/** Write everything this client has not seen yet, skipping its own messages. */
function flush(r, id) {
  const res = r.clients.get(id);
  if (!res) return;
  const now = Date.now();
  let i = r.cursors.get(id) || 0;
  for (; i < r.queue.length; i++) {
    const m = r.queue[i];
    // A device arriving late must not be handed a previous attempt's offer.
    if (m.from !== id && now - m.at < STALE) res.write(`data: ${m.data}\n\n`);
  }
  r.cursors.set(id, i);
}

/** Nobody attached: keep the backlog briefly, then let the room go. */
function sweep(r, name) {
  if (r.clients.size || r.gc) return;
  r.gc = setTimeout(() => rooms.delete(name), ROOM_TTL);
  r.gc.unref();
}

function signal(req, res, name, id) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    const r = room(name);
    r.clients.set(id, res);
    flush(r, id);
    req.on('close', () => {
      r.clients.delete(id);
      sweep(r, name);
    });
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy(); // signaling messages are tiny
    });
    req.on('end', () => {
      const r = room(name);
      r.queue.push({ from: id, at: Date.now(), data: body.replace(/\n/g, '') });
      if (r.queue.length > QUEUE_MAX) {
        r.queue.shift();
        for (const [cid, n] of r.cursors) r.cursors.set(cid, Math.max(0, n - 1));
      }
      for (const cid of r.clients.keys()) flush(r, cid);
      // A cancel ends the pairing, so nothing before it should reach a rescan.
      if (body.includes('"bye"')) {
        r.queue.length = 0;
        r.cursors.clear();
      }
      sweep(r, name);
      end(res, 200, 'ok');
    });
    return;
  }
  end(res, 405, 'no');
}

// Fallback for networks that block device-to-device traffic (AP isolation on
// guest WiFi, mostly). Files are held in memory and each is dropped once picked
// up. A batch arrives as one POST per file and leaves as one GET per file, so
// the cap is on the room's running total: the memory ceiling stays where it was
// no matter how the sender splits a batch up.
function relay(req, res, room) {
  if (req.method === 'POST') {
    const used = relays.get(room)?.size || 0;
    // Reject on the declared length so the client gets a real 413 instead of a
    // severed socket; the streaming guard below is the backstop if it lies.
    if (used + Number(req.headers['content-length']) > RELAY_MAX) return end(res, 413, 'too large');
    if (!relays.has(room) && relays.size >= RELAY_PENDING) return end(res, 503, 'relay busy');
    if (throttled(req)) return end(res, 429, 'slow down');
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (used + size > RELAY_MAX) {
        over = true;
        return req.destroy();
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return end(res, 413, 'too large');
      let r = relays.get(room);
      if (!r) {
        r = { count: Number(req.headers['x-count']) || 1, sent: 0, size: 0, files: [] };
        relays.set(room, r);
        setTimeout(() => relays.delete(room), 10 * 60_000).unref();
      }
      r.files.push({
        name: req.headers['x-name'] || 'file',
        type: req.headers['x-type'] || 'application/octet-stream',
        body: Buffer.concat(chunks),
      });
      r.size += size;
      end(res, 200, 'ok');
    });
    return;
  }
  // A cancelled sender drops whatever it already handed over.
  if (req.method === 'DELETE') {
    relays.delete(room);
    return end(res, 200, 'ok');
  }
  if (req.method === 'GET') {
    const r = relays.get(room);
    const f = r?.files.shift();
    // Nothing waiting yet is normal mid-batch: the next file is still uploading.
    if (!f) return end(res, 404, 'waiting');
    if (++r.sent >= r.count) relays.delete(room); // whole batch handed over
    res.writeHead(200, {
      'content-type': f.type,
      'x-name': f.name,
      'x-count': r.count,
      'content-length': f.body.length,
    });
    res.end(f.body);
    return;
  }
  end(res, 405, 'no');
}

const end = (res, code, msg) => {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(msg);
};

// getUserMedia needs a secure context, so a LAN http:// origin can't scan.
// Self-signed is enough; phones just have to tap through the warning once.
function cert() {
  const dir = path.join(__dirname, 'certs');
  const key = path.join(dir, 'key.pem');
  const crt = path.join(dir, 'cert.pem');
  if (!fs.existsSync(crt)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
      '-subj', '/CN=snapsher', '-keyout', key, '-out', crt], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

const port = Number(process.env.PORT) || 8443;

// TLS=0 when something upstream (Cloudflare Tunnel, nginx) already terminates it.
if (process.env.TLS === '0') {
  http.createServer(handler).listen(port, '127.0.0.1', () =>
    console.log(`snapsher on http://127.0.0.1:${port} — TLS terminated upstream`));
} else {
  https.createServer(cert(), handler).listen(port, () =>
    console.log(`snapsher on https://localhost:${port} (and https://<your-lan-ip>:${port})`));
  // localhost counts as a secure context, so plain http is fine for desktop dev.
  http.createServer(handler).listen(port - 1, () => console.log(`dev on http://localhost:${port - 1}`));
}


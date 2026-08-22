// Static file server. Snapsher's transfer is fully optical now (see
// public/qr.js and public/fountain.js) — no signalling and no relay needed,
// so this server only ever hands out the app's own files.
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

const handler = (req, res) => {
  const url = new URL(req.url, 'http://x');
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

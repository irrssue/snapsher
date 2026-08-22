// Self-check: rasterize a circle code in pure JS, then decode it back.
import assert from 'node:assert';
import { N, G, encode, decode, newId } from './public/circle.js';

function raster(hex, size, rot) {
  const { ring0, ring1 } = encode(hex);
  const g = new Uint8Array(size * size).fill(20); // dark field: the code is drawn light-on-dark
  const c = size / 2;
  const s = c / (G.r * 1.3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const r = Math.hypot(dx, dy) / s;
      let a = Math.atan2(dy, dx) - rot;
      a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const k = Math.floor((a / (2 * Math.PI)) * N) % N;
      const on =
        r < G.dot ||
        (r > G.r0in && r < G.r0out && ring0[k]) ||
        (r > G.r1in && r < G.r1out && ring1[k]);
      if (on) g[y * size + x] = 235;
    }
  }
  return g;
}

for (const rot of [0, 0.4, 2.1, 4.7]) {
  const hex = newId();
  assert.equal(decode(raster(hex, 300, rot), 300, 300), hex, `rot=${rot}`);
}

// A frame with no code in it must not produce a false positive.
assert.equal(decode(new Uint8Array(300 * 300).fill(200), 300, 300), null);

// Signalling: the receiver POSTs `join` in the same tick it opens its stream, so
// the sender's offer is often written before that stream exists. It must still
// arrive, or both devices sit on "Connecting…" forever.
{
  const { spawn } = await import('node:child_process');
  const PORT = 8465;
  const base = `http://127.0.0.1:${PORT}`;
  const srv = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, TLS: '0', PORT: String(PORT) },
    cwd: import.meta.dirname,
    stdio: 'ignore',
  });

  const post = (id, m) => fetch(`${base}/sig/room1/${id}`, { method: 'POST', body: JSON.stringify(m) });
  // Resolves with the first `data:` line the stream delivers.
  const stream = async (id) => {
    const res = await fetch(`${base}/sig/room1/${id}`);
    const reader = res.body.getReader();
    return {
      // Times out rather than hanging: a lost message is a stream that stays silent.
      next: () => Promise.race([
        (async () => {
        for (let buf = ''; ; ) {
          const { value, done } = await reader.read();
          if (done) return null;
          buf += new TextDecoder().decode(value);
          const line = buf.split('\n').find((l) => l.startsWith('data: '));
          if (line) return JSON.parse(line.slice(6));
        }
        })(),
        new Promise((r) => setTimeout(() => r('timed out'), 3000)),
      ]),
      close: () => reader.cancel(),
    };
  };

  for (let i = 0; ; i++) {
    try { await fetch(base); break; } catch { assert.ok(i < 50, 'server never came up'); await new Promise((r) => setTimeout(r, 100)); }
  }

  const sender = await stream('S');
  await post('R', { t: 'join' }); // receiver has no stream open yet
  assert.deepEqual(await sender.next(), { t: 'join' });
  await post('S', { t: 'offer' }); // ...and still none when the offer goes out

  const receiver = await stream('R');
  assert.deepEqual(await receiver.next(), { t: 'offer' }, 'offer lost to a late stream');

  await sender.close();
  await receiver.close();

  // Relay fallback carrying a batch: one POST per file in, one GET per file out,
  // in order, each pickup restating the count so the receiver knows to come back.
  const put = (name, body) =>
    fetch(`${base}/relay/room2`, { method: 'POST', headers: { 'x-name': name, 'x-count': '2' }, body });
  assert.equal((await put('a.jpg', 'AAA')).status, 200);
  assert.equal((await put('b.jpg', 'BBBB')).status, 200);

  const first = await fetch(`${base}/relay/room2`);
  assert.equal(first.headers.get('x-name'), 'a.jpg');
  assert.equal(first.headers.get('x-count'), '2');
  assert.equal(await first.text(), 'AAA');

  const second = await fetch(`${base}/relay/room2`);
  assert.equal(second.headers.get('x-name'), 'b.jpg');
  assert.equal(await second.text(), 'BBBB');

  // The whole batch is out, so the room is gone rather than lingering in memory.
  assert.equal((await fetch(`${base}/relay/room2`)).status, 404, 'relay held on past its count');

  // A cancel drops everything still waiting, not just the file at the head.
  await put('c.jpg', 'CCC');
  await put('d.jpg', 'DDD');
  await fetch(`${base}/relay/room2`, { method: 'DELETE' });
  assert.equal((await fetch(`${base}/relay/room2`)).status, 404, 'cancel left a file behind');

  srv.kill();
}

console.log('ok');

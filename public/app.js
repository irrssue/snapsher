import { draw, decode, newId } from './circle.js?v=DEV';

const $ = (id) => document.getElementById(id);
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const CHUNK = 16384;
const RELAY_AFTER = 6000; // give the direct connection this long before relaying
// The receiver assembles one file at a time in memory, but it holds every
// finished blob until the user has saved them, so the batch is what needs a cap.
const BATCH_MAX = 500 << 20;

/** Redraw the code every frame so the loose dust drifts. The bits never move. */
function drawLoop(id) {
  const cv = $('canvas');
  const ctx = cv.getContext('2d');
  const t0 = performance.now();
  const frame = (now) => {
    draw(ctx, id, cv.width, (now - t0) / 1000);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const show = (name) => {
  for (const s of document.querySelectorAll('section')) s.hidden = s.id !== name;
};
const pct = (el, v) => (el.style.width = `${Math.round(v * 100)}%`);

/** Candidates routinely arrive before the description they belong to. */
function iceQueue(pc) {
  const q = [];
  return {
    add: (c) => (pc.remoteDescription ? pc.addIceCandidate(c) : q.push(c)),
    flush: () => Promise.all(q.splice(0).map((c) => pc.addIceCandidate(c))),
  };
}

/** SSE down, POST up. The server just relays to the other member of the room. */
function signal(room) {
  const me = crypto.randomUUID();
  const es = new EventSource(`/sig/${room}/${me}`);
  let chain = Promise.resolve();
  return {
    // Serialized: an offer is fully applied before the next message is touched.
    onMessage: (fn) => {
      es.onmessage = (e) => {
        chain = chain.then(() => fn(JSON.parse(e.data))).catch((err) => console.error(err));
      };
    },
    // keepalive so a cancel's goodbye still leaves as the page navigates away.
    send: (m) => fetch(`/sig/${room}/${me}`, { method: 'POST', body: JSON.stringify(m), keepalive: true }),
    close: () => es.close(),
  };
}

// ---- cancelling ----

// Whatever pairing is currently live, so Cancel can take all of it down: the
// signalling stream, the peer connection, an upload in flight, and the copy the
// relay may already be holding for this room.
let active = null;

window.cancelTransfer = () => {
  const a = active;
  active = null;
  if (!a) return void (location.href = '/');
  a.upload?.abort();
  a.sig.send({ t: 'bye' }); // the other device stops waiting instead of timing out
  a.sig.close();
  a.pc.close();
  fetch(`/relay/${a.room}`, { method: 'DELETE', keepalive: true })
    .catch(() => {})
    .finally(() => (location.href = '/'));
};

// The sender's side of this is different: it keeps its session alive, because
// its code stays on screen and stays scannable. See the `bye` branch in send().
/** The sender cancelled: stop everything here too, without navigating. */
function peerCancelled(a) {
  active = null;
  a.upload?.abort();
  a.sig.close();
  a.pc.close();
  $('scanStatus').textContent = 'Cancelled on the other device';
}

// ---- sending ----

$('pick').onchange = (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > BATCH_MAX) {
    $('homeStatus').textContent = `${Math.round(bytes / (1 << 20))} MB is too much at once. Keep a batch under 500 MB.`;
    e.target.value = ''; // so picking the same set again still fires onchange
    return;
  }
  $('homeStatus').textContent = '';
  send(files);
};

async function send(files) {
  const id = newId();
  history.replaceState(null, '', `?r=${id}`); // sharable as a plain link too
  show('code');
  drawLoop(id);
  const sig = signal(id);

  // Everything below is one pairing attempt, and an attempt is disposable. A
  // receiver that cancels leaves a half-built connection behind while this
  // device carries on showing a perfectly good code, so the next scan has to be
  // able to start over on the same room rather than knock on a dead session.
  let pc, dc, ice, offered, claimed, fallback;
  const attempt = () => {
    pc?.close(); // takes its data channel and its pending candidates with it
    clearTimeout(fallback);
    pc = new RTCPeerConnection(ICE);
    dc = pc.createDataChannel('file');
    dc.binaryType = 'arraybuffer';
    ice = iceQueue(pc);
    offered = false;
    claimed = false; // whichever path starts first wins
    active = { room: id, sig, pc };
    pc.onicecandidate = (e) => e.candidate && sig.send({ t: 'ice', c: e.candidate });
    dc.onopen = () => {
      if (claimed) return;
      claimed = true;
      transfer(dc, files);
    };
  };
  attempt();

  sig.onMessage(async (m) => {
    if (m.t === 'bye') {
      // Not the end of the session: the code is still on screen and still valid,
      // so reset to waiting rather than tearing the signalling stream down.
      active?.upload?.abort(); // or a relayed file lands after the receiver's DELETE
      $('sendStatus').textContent = 'Cancelled. Scan this code again.';
      pct($('sendBar'), 0);
      return attempt();
    }
    if (m.t === 'join' && !offered) {
      offered = true;
      await pc.setLocalDescription(await pc.createOffer());
      sig.send({ t: 'offer', sdp: pc.localDescription });
      fallback = setTimeout(() => {
        if (claimed) return;
        claimed = true;
        viaRelay(files, id);
      }, RELAY_AFTER);
    }
    if (m.t === 'answer') {
      await pc.setRemoteDescription(m.sdp);
      await ice.flush();
    }
    if (m.t === 'ice') ice.add(m.c);
  });
}

/** One file at a time down the same channel: a header, then its bytes. */
async function transfer(dc, files) {
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  let sent = 0;
  for (const [i, file] of files.entries()) {
    $('sendStatus').textContent = label('Sending', file, i, files);
    // `count` and `total` never change across a batch, but repeating them means
    // the receiver knows the shape of the batch from whichever header it sees.
    dc.send(JSON.stringify({ name: file.name, size: file.size, type: file.type, count: files.length, total }));
    for (let off = 0; off < file.size; off += CHUNK) {
      // Keep the send buffer bounded or a large file blows up memory.
      while (dc.bufferedAmount > 4 << 20) await new Promise((r) => setTimeout(r, 20));
      if (dc.readyState !== 'open') return; // cancelled, or the peer went away
      const buf = await file.slice(off, off + CHUNK).arrayBuffer();
      dc.send(buf);
      sent += buf.byteLength;
      pct($('sendBar'), sent / total);
    }
  }
  pct($('sendBar'), 1);
  $('sendStatus').textContent = files.length > 1 ? `Sent ${files.length} files` : 'Sent';
}

const label = (verb, file, i, files) =>
  files.length > 1 ? `${verb} ${i + 1} of ${files.length}…` : `${verb} ${file.name}…`;

/** No direct route to the other device, so hand the files to the server instead. */
async function viaRelay(files, id) {
  // Cancelling mid-upload has to abort this, or the file lands on the relay
  // just after the DELETE and sits there waiting for a pickup that won't come.
  const upload = new AbortController();
  if (active) active.upload = upload;
  for (const [i, file] of files.entries()) {
    $('sendStatus').textContent = label('Relaying', file, i, files);
    const res = await fetch(`/relay/${id}`, {
      method: 'POST',
      headers: {
        'x-name': encodeURIComponent(file.name),
        'x-type': file.type || '',
        'x-count': String(files.length), // so the receiver knows how many pickups to wait for
      },
      body: file,
      signal: upload.signal,
    }).catch(() => null);
    if (upload.signal.aborted) return;
    if (!res?.ok) {
      $('sendStatus').textContent = res?.status === 413
        ? 'Too much to relay. Get both devices on the same WiFi.'
        : 'Could not reach the other device.';
      return;
    }
    pct($('sendBar'), (i + 1) / files.length);
  }
  $('sendStatus').textContent = files.length > 1 ? `Sent ${files.length} files (relayed)` : 'Sent (relayed)';
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

  const cv = document.createElement('canvas');
  cv.width = cv.height = 320;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const gray = new Uint8Array(320 * 320);

  const timer = setInterval(() => {
    if (!video.videoWidth) return;
    const side = Math.min(video.videoWidth, video.videoHeight);
    ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, 320, 320);
    const d = ctx.getImageData(0, 0, 320, 320).data;
    for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 151 + d[i * 4 + 2] * 28) >> 8;
    const id = decode(gray, 320, 320);
    if (!id) return;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    receive(id);
  }, 200);
};

// Fallback for when scanning isn't possible: open the sender's URL directly.
const linked = new URLSearchParams(location.search).get('r');
if (/^[0-9a-f]{9}$/.test(linked || '')) {
  show('scan');
  $('video').hidden = true;
  receive(linked);
}

function receive(room) {
  $('scanStatus').textContent = 'Connecting…';
  const sig = signal(room);
  const pc = new RTCPeerConnection(ICE);
  const ice = iceQueue(pc);
  pc.onicecandidate = (e) => e.candidate && sig.send({ t: 'ice', c: e.candidate });

  // The sender's SSE stream may not be registered yet, so keep knocking.
  const knock = setInterval(() => sig.send({ t: 'join' }), 700);
  sig.send({ t: 'join' });

  let claimed = false;
  let relaying = false; // the relay is the live path, so its poll loop keeps going
  let saved = 0, want = 1; // `want` is whatever the sender announced for this batch
  let nextClick = 0; // earliest a download may fire, so a burst stays spaced out
  active = { room, sig, pc };
  $('saved').textContent = '';

  // Browsers gate a *run* of auto-triggered downloads behind one permission
  // prompt ("this site wants to download multiple files"). That prompt is the
  // whole mechanism, so ask for every file: granting it is what lets the rest
  // through. Each file also keeps its link on screen, which covers the browser
  // that blocks anyway and the user who declined.
  const save = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.className = 'btn';
    a.textContent = `Save ${name}`;
    $('saved').appendChild(a);
    // Small files finish within a millisecond of each other, and downloads
    // fired that close together get collapsed into one prompt that only the
    // first survives. Space them, but only against the previous *click*, so a
    // batch arriving slowly on its own never accumulates a delay.
    const at = Math.max(Date.now(), nextClick);
    nextClick = at + 400;
    setTimeout(() => a.click(), at - Date.now());
    if (++saved < want) return;
    $('scanStatus').textContent = want > 1 ? `Saved ${want} files` : `Saved ${name}`;
    sig.close();
  };

  pc.ondatachannel = (e) => {
    if (claimed) return;
    claimed = true;
    const dc = e.channel;
    dc.binaryType = 'arraybuffer';
    let meta = null, parts = [], got = 0, done = 0;
    const complete = () => {
      save(new Blob(parts, { type: meta.type || 'application/octet-stream' }), meta.name);
      done += meta.size;
      parts = [];
      got = 0;
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        meta = JSON.parse(ev.data);
        want = meta.count || 1;
        $('scanStatus').textContent =
          want > 1 ? `Receiving ${saved + 1} of ${want}…` : `Receiving ${meta.name}…`;
        if (!meta.size) complete(); // a zero-byte file sends no chunks to close it out
        return;
      }
      parts.push(ev.data);
      got += ev.data.byteLength;
      pct($('recvBar'), (done + got) / (meta.total || 1));
      if (got >= meta.size) complete();
    };
  };

  // If nothing arrives directly, the sender will have handed it to the relay.
  // The relay hands back one file per GET, so a batch keeps polling after the
  // first pickup - including through the 404s while the next one is uploading.
  setTimeout(async function poll() {
    if (claimed && !relaying) return; // the data channel got there first
    const res = await fetch(`/relay/${room}`);
    if (res.status === 404) return void setTimeout(poll, relaying ? 800 : 1500);
    claimed = relaying = true;
    want = Number(res.headers.get('x-count')) || 1;
    $('scanStatus').textContent =
      want > 1 ? `Receiving ${saved + 1} of ${want} via relay…` : 'Receiving via relay…';
    pct($('recvBar'), (saved + 1) / want);
    save(await res.blob(), decodeURIComponent(res.headers.get('x-name') || 'file'));
    if (saved < want) setTimeout(poll, 800);
  }, RELAY_AFTER + 1500);

  sig.onMessage(async (m) => {
    if (m.t === 'bye') {
      claimed = true; // stop polling the relay for files that are gone
      relaying = false; // ...including the rest of a batch that was mid-pickup
      clearInterval(knock);
      return peerCancelled(active || { sig, pc });
    }
    if (m.t === 'offer') {
      clearInterval(knock);
      await pc.setRemoteDescription(m.sdp);
      await ice.flush();
      await pc.setLocalDescription(await pc.createAnswer());
      sig.send({ t: 'answer', sdp: pc.localDescription });
    }
    if (m.t === 'ice') ice.add(m.c);
  });
}

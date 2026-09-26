// Runs in a background thread so checking never slows the page down.
//  - mirror: keeps its own copy of the worm in step with the server and compares state hashes each second
//  - replay: downloads an hour of the event log and re-runs every stimulus to check every published result
import { createMirror } from '/shared/mirror.js';
import { replayLog } from '/shared/replay.js';
import { solvePow } from '/sha256.js';

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (x) => hex(await crypto.subtle.digest('SHA-256', typeof x === 'string' ? enc.encode(x) : x));

let wiringBytes = null, D = null, mirror = null;
async function wiring() {
  if (!wiringBytes) {
    wiringBytes = new Uint8Array(await (await fetch('/data/wiring.json')).arrayBuffer());
    D = JSON.parse(new TextDecoder().decode(wiringBytes));
  }
  return D;
}

// messages must be handled in order (sync depends on the events before it)
let chain = Promise.resolve();
onmessage = ({ data: m }) => { chain = chain.then(() => handle(m)).catch((e) => postMessage({ t: 'error', message: String(e && e.message || e) })); };

async function handle(m) {
  if (m.t === 'mirror-state') {
    mirror = createMirror(await wiring(), { sha256 });
    mirror.state(m.state);
    postMessage({ t: 'mirror-started', step: mirror.step });
  } else if (m.t === 'mirror-event') {
    if (mirror) mirror.event(m.ev);
  } else if (m.t === 'mirror-sync') {
    if (!mirror) return;
    const t0 = performance.now();
    const r = await mirror.sync(m.step, m.sha);
    if (r) postMessage({ t: 'check', ...r, ms: performance.now() - t0 });
  } else if (m.t === 'mirror-reset') {
    mirror = null;
  } else if (m.t === 'pow') {
    const t0 = performance.now();
    postMessage({ t: 'pow-solved', nonce: solvePow(m.challenge, m.bits), ms: performance.now() - t0 });
  } else if (m.t === 'replay') {
    const t0 = performance.now();
    await wiring();
    const text = await (await fetch(m.url, { cache: 'no-store' })).text();
    const res = await replayLog(text, wiringBytes, { sha256, onProgress: (f) => postMessage({ t: 'replay-progress', id: m.id, f }) });
    postMessage({ t: 'replay-done', id: m.id, res, ms: performance.now() - t0, bytes: text.length, lines: text.split('\n').filter(Boolean).length });
  }
}

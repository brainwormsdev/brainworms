// Browser client. Normally it only draws: the server runs the one worm and streams its
// activity. If the live connection is down, it runs its own copy (offline mode) until
// the connection comes back.
import { indexRoles, readouts } from '/shared/roles.js';
import { renderText, VIEW, SPEED, durationSteps } from '/shared/text.js';
import { WormCore } from '/shared/worm.js';
import { STEPS_PER_SECOND } from '/shared/sim.js';

const D = await fetch('/data/wiring.json').then((r) => r.json());
const N = D.n.length;
const roles = indexRoles(D);
const STEP_MS = 1000 / STEPS_PER_SECOND;
const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- colours and labels ---------- */
const COL = { eye: '#FFB84D', touch: '#FF9E7A', sn: '#7FC8FF', in: '#B9C9E8', mn: '#C49BFF', mus: '#FF6B5E', cil: '#56E6D2', other: '#6E7F8C' };
const KLABEL = { eye: 'eye photoreceptor', touch: 'touch sensor', sn: 'sensory neuron', in: 'interneuron', mn: 'motor neuron', mus: 'muscle', cil: 'ciliated swimming cell', other: 'gland / glia / pigment cell' };
const SEGNAME = { episphere: 'head', segment_0: 'segment 0', segment_1: 'segment 1', segment_2: 'segment 2', segment_3: 'segment 3', pygidium: 'tail', fragment: '' };
function kind(x) {
  if (x[6] & 1) return 'eye';
  if (x[6] & 4) return 'touch';
  if (x[6] & 64) return 'cil';
  if (x[1] === 0) return 'sn';
  if (x[1] === 1) return 'in';
  if (x[1] === 2) return 'mn';
  if (x[1] === 3) return /^MUS/.test(x[0]) ? 'mus' : 'other';
  return 'other';
}
const KIND = D.n.map(kind);
const sprites = {};
for (const hex of Object.values(COL)) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.12, hex); gr.addColorStop(0.45, hex + '55'); gr.addColorStop(1, hex + '00');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); sprites[hex] = c;
}
const dEdges = [];
for (let k = 0; k < D.e.length; k += 3) if (D.n[D.e[k]][5] && D.n[D.e[k + 1]][5]) dEdges.push(D.e[k], D.e[k + 1], D.e[k + 2]);

/* ---------- state ---------- */
const act = new Float32Array(N);         // what is drawn, 0..1
let prevF = null, curF = null;           // streamed frames {step, bytes, t}
let mode = 'connecting';                 // 'live' | 'offline' | 'connecting'
let local = null, localAcc = 0;          // offline worm
let you = null, watchers = 0;
let nowMsg = null;                       // {id, text, by, startStep, bmp, dur}
let queue = [];                          // [{id, text, by}]
const feed = new Map();                  // id -> item
const ripples = [];

function setMode(m) {
  mode = m;
  const el = $('status');
  el.dataset.mode = m;
  el.textContent = m === 'live' ? 'Live' : m === 'offline' ? 'Offline: this worm is only yours' : 'Connecting';
  $('watchers').textContent = m === 'live' ? `${watchers.toLocaleString()} watching ·` : '·';
}

/* ---------- live connection ---------- */
let ws = null, retry = 0;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let sock;
  try { sock = new WebSocket(proto + location.host + '/live'); } catch { return scheduleReconnect(); }
  ws = sock;
  sock.binaryType = 'arraybuffer';
  const failTimer = setTimeout(() => { if (mode !== 'live') goOffline(); }, 5000);
  sock.onmessage = (e) => {
    if (typeof e.data === 'string') { let m; try { m = JSON.parse(e.data); } catch { return; } onServer(m); }
    else onFrame(e.data);
  };
  sock.onclose = () => {
    clearTimeout(failTimer);
    if (ws === sock) ws = null;
    if (mode === 'live') goOffline();
    scheduleReconnect();
  };
}
function scheduleReconnect() { setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++)); }

function goOffline() {
  if (mode === 'offline') return;
  local = new WormCore(D, { onEvent: onLocalEvent });
  nowMsg = null; queue = []; feed.clear(); renderFeed();
  setMode('offline');
}

function onFrame(buf) {
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 1) return;
  const f = { step: dv.getUint32(1, true), bytes: new Uint8Array(buf, 5), t: performance.now() };
  prevF = curF && f.step - curF.step <= 4 ? curF : f;
  curF = f;
}

function onServer(m) {
  switch (m.t) {
    case 'hello':
      retry = 0; you = m.you; watchers = m.watchers; local = null;
      feed.clear(); for (const it of m.feed) feed.set(it.id, { ...it });
      queue = m.queue || [];
      nowMsg = m.current ? withBitmap(m.current) : null;
      setMode('live'); renderFeed(); break;
    case 'watchers': watchers = m.n; setMode(mode); break;
    case 'queued':
      queue.push({ id: m.id, text: m.text, by: m.by });
      feed.set(m.id, { id: m.id, kind: 'say', by: m.by, text: m.text, step: null, ahead: m.ahead });
      renderFeed(); break;
    case 'start':
      queue = queue.filter((q) => q.id !== m.id);
      nowMsg = withBitmap({ id: m.id, text: m.text, by: m.by, startStep: m.step });
      { const it = feed.get(m.id); if (it) it.step = m.step; }
      renderFeed(); break;
    case 'poke':
      feed.set(m.id, { id: m.id, kind: 'poke', by: m.by, cells: m.cells, step: m.step });
      if (m.by !== you) ripples.push({ cells: m.cells, t: performance.now(), hit: true });
      renderFeed(); break;
    case 'done': { const it = feed.get(m.id); if (it) { it.summary = m.summary; renderFeed(); } break; }
    case 'hide': feed.delete(m.id); renderFeed(); break;
    case 'feed': feed.clear(); for (const it of m.feed) feed.set(it.id, { ...it }); renderFeed(); break;
    case 'error': toast(m.message); break;
  }
}

/* ---------- offline worm ---------- */
let localIds = 0;
function onLocalEvent(ev) {
  if (ev.type === 'start') {
    queue = queue.filter((q) => q.id !== ev.id);
    const it = feed.get(ev.id); if (it) it.step = ev.step;
    nowMsg = withBitmap({ id: ev.id, text: ev.text, by: 'you', startStep: ev.step });
  } else if (ev.type === 'poke') {
    feed.set(ev.id, { id: ev.id, kind: 'poke', by: you || 'you', cells: ev.cells, step: ev.step });
  } else if (ev.type === 'done') {
    const it = feed.get(ev.id); if (it) it.summary = ev.summary;
  }
  renderFeed();
}

function withBitmap(m) { const bmp = renderText(m.text); return { ...m, bmp, dur: durationSteps(bmp) }; }
function currentStep(now) {
  if (mode === 'offline' && local) return local.step;
  if (!curF) return 0;
  return curF.step + Math.min(60, (now - curF.t) / STEP_MS);
}

/* ---------- sending ---------- */
function say(text) {
  text = (text || '').trim();
  if (!text) return;
  if (mode === 'live' && ws && ws.readyState === 1) { ws.send(JSON.stringify({ t: 'say', text })); return; }
  if (!local) goOffline();
  const id = 'L' + (++localIds);
  const shown = [...text].slice(0, 40).join('');
  const ahead = local.say(id, shown, { by: 'you' });
  queue.push({ id, text: shown, by: 'you' });
  feed.set(id, { id, kind: 'say', by: you || 'you', text: shown, step: null, ahead });
  renderFeed();
}
function sendPoke(cells) {
  if (mode === 'live' && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'poke', cells }));
  else { if (!local) goOffline(); local.poke('P' + (++localIds), cells, { by: 'you' }); }
}
let toastTimer = null;
function toast(text) { $('toast').textContent = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 4000); }

$('talk').addEventListener('submit', (e) => { e.preventDefault(); const inp = $('msg'); say(inp.value); inp.value = ''; });
$('chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) say(b.textContent); });
$('pokebtn').addEventListener('click', () => {
  project();
  const i = roles.touch[Math.floor(Math.random() * roles.touch.length)];
  pokeAt(proj[i * 3], proj[i * 3 + 1]);
});

/* ---------- stage and projection ---------- */
const stage = $('stage'), cv = $('brain'), cx = cv.getContext('2d');
let W = 0, H = 0;
function resize() {
  const DPR = Math.min(2, window.devicePixelRatio || 1), b = stage.getBoundingClientRect();
  W = b.width; H = b.height; cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); cx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
new ResizeObserver(resize).observe(stage); resize();

let yaw = 0.5, pitch = -0.12, bendS = 0, stS = 0, lastDrag = -1e9;
const proj = new Float32Array(N * 3);
function project() {
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const scale = Math.min(W * 0.95, H * 0.5), cxm = W / 2, cym = H * 0.52;
  const shrink = 1 - 0.07 * stS, flare = 1 + 0.12 * stS;
  for (const i of roles.drawn) {
    const p = D.n[i][5];
    let x = p[0] * flare, y = p[1] * shrink; const z = p[2] * flare;
    const s = (1 - p[1]) / 2; x += bendS * 0.42 * s * s; y -= Math.abs(bendS) * 0.06 * s * s;
    const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const persp = 1 / (1 + z2 * 0.35);
    proj[i * 3] = cxm + x1 * scale * persp; proj[i * 3 + 1] = cym - y2 * scale * persp; proj[i * 3 + 2] = persp;
  }
}

function render(now) {
  project();
  cx.globalCompositeOperation = 'source-over';
  cx.clearRect(0, 0, W, H);
  cx.globalCompositeOperation = 'lighter';
  const live = [];
  for (let k = 0; k < dEdges.length; k += 3) if (act[dEdges[k]] > 0.12) live.push(k);
  if (live.length > 450) { live.sort((p, q) => act[dEdges[q]] * dEdges[q + 2] - act[dEdges[p]] * dEdges[p + 2]); live.length = 450; }
  cx.lineWidth = 0.7;
  for (const k of live) {
    const a = dEdges[k], b = dEdges[k + 1];
    cx.strokeStyle = `rgba(160,200,255,${Math.min(0.22, act[a] * 0.2).toFixed(3)})`;
    cx.beginPath(); cx.moveTo(proj[a * 3], proj[a * 3 + 1]); cx.lineTo(proj[b * 3], proj[b * 3 + 1]); cx.stroke();
  }
  const base = Math.max(2.2, Math.min(W, H) / 210);
  for (const i of roles.drawn) {
    const v = act[i], k = KIND[i], pz = proj[i * 3 + 2];
    const rest = k === 'eye' ? 0.6 : k === 'touch' ? 0.42 : 0.24;
    const a = Math.min(0.85, rest + v * 0.7);
    const sz = (base * (k === 'eye' ? 1.7 : 1) + v * base * 1.5) * pz * 2.1;
    cx.globalAlpha = a * (0.55 + 0.45 * Math.min(1, pz));
    cx.drawImage(sprites[COL[k]], proj[i * 3] - sz / 2, proj[i * 3 + 1] - sz / 2, sz, sz);
  }
  cx.globalAlpha = 1;
  cx.globalCompositeOperation = 'source-over';
  for (let q = ripples.length - 1; q >= 0; q--) {
    const rp = ripples[q], t = (now - rp.t) / 700;
    if (t > 1) { ripples.splice(q, 1); continue; }
    let x = rp.x, y = rp.y;
    if (rp.cells) { x = 0; y = 0; for (const i of rp.cells) { x += proj[i * 3]; y += proj[i * 3 + 1]; } x /= rp.cells.length; y /= rp.cells.length; }
    cx.strokeStyle = rp.hit ? `rgba(255,107,94,${1 - t})` : `rgba(130,152,166,${(1 - t) * 0.7})`; cx.lineWidth = 2;
    cx.beginPath(); cx.arc(x, y, 8 + t * 46, 0, Math.PI * 2); cx.stroke();
  }
}

/* ---------- pokes and pointer ---------- */
function pokeAt(sx, sy) {
  project();
  let near = 1e9;
  for (const i of roles.drawn) { const d = Math.hypot(proj[i * 3] - sx, proj[i * 3 + 1] - sy); if (d < near) near = d; }
  if (near > Math.max(22, Math.min(W, H) * 0.05)) { ripples.push({ x: sx, y: sy, t: performance.now(), hit: false }); return; }
  const cells = roles.touch.map((i) => [Math.hypot(proj[i * 3] - sx, proj[i * 3 + 1] - sy), i]).sort((a, b) => a[0] - b[0]).slice(0, 6).map((c) => c[1]);
  ripples.push({ x: sx, y: sy, t: performance.now(), hit: true });
  sendPoke(cells);
}
function pokeWhere(cells) {
  if (!cells || !cells.length) return 'body';
  const segs = {}; let left = 0;
  for (const i of cells) { const s = D.segs[D.n[i][3]]; segs[s] = (segs[s] || 0) + 1; if (D.n[i][2] === 0) left++; }
  const seg = Object.entries(segs).sort((a, b) => b[1] - a[1])[0][0];
  return `${left >= cells.length / 2 ? 'left' : 'right'} ${SEGNAME[seg] || 'body'}`;
}

let drag = null;
stage.addEventListener('pointerdown', (e) => { const b = stage.getBoundingClientRect(); drag = { x: e.clientX, y: e.clientY, yaw, pitch, moved: false, bx: b.left, by: b.top }; stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', (e) => {
  const b = stage.getBoundingClientRect();
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 6) drag.moved = true;
    if (drag.moved) { yaw = drag.yaw + dx * 0.008; pitch = Math.max(-1.2, Math.min(1.2, drag.pitch + dy * 0.006)); lastDrag = performance.now(); }
  } else hover(e.clientX - b.left, e.clientY - b.top);
});
stage.addEventListener('pointerup', (e) => { if (drag && !drag.moved) pokeAt(e.clientX - drag.bx, e.clientY - drag.by); drag = null; });
stage.addEventListener('pointerleave', () => { $('tip').hidden = true; });
function hover(x, y) {
  const tip = $('tip');
  let best = -1, bd = 14;
  for (const i of roles.drawn) { const d = Math.hypot(proj[i * 3] - x, proj[i * 3 + 1] - y); if (d < bd) { bd = d; best = i; } }
  if (best < 0) { tip.hidden = true; return; }
  const n = D.n[best];
  tip.hidden = false; tip.style.left = x + 'px'; tip.style.top = y + 'px';
  tip.replaceChildren();
  const b = document.createElement('b'); b.textContent = n[0];
  const s = document.createElement('small');
  s.textContent = ` · ${KLABEL[KIND[best]]} · ${SEGNAME[D.segs[n[3]]] || ''}${n[2] === 0 ? ', left' : n[2] === 1 ? ', right' : ''}${n[7] ? ' · approx. position' : ''}`;
  tip.append(b, s);
}

/* ---------- panels ---------- */
const prcEls = new Map();
for (const [ids, row] of [[roles.eyeL, $('prcL')], [roles.eyeR, $('prcR')]]) {
  for (const i of ids) { const d = document.createElement('i'); d.className = 'prc'; d.title = D.n[i][0]; row.append(d); prcEls.set(i, d); }
}
const eyeview = $('eyeview'), eg = eyeview.getContext('2d');
function paintEye(now) {
  const w = eyeview.width, h = eyeview.height;
  eg.fillStyle = '#000'; eg.fillRect(0, 0, w, h);
  const step = currentStep(now);
  if (nowMsg && step - nowMsg.startStep >= nowMsg.dur + 2) nowMsg = null;
  if (nowMsg) {
    const pos = Math.max(0, (step - nowMsg.startStep) * SPEED);
    const cw = w / VIEW, ch = h / nowMsg.bmp.height;
    const x0 = Math.floor(pos), frac = pos - x0;
    eg.fillStyle = '#F4F7F9';
    for (let x = 0; x <= VIEW; x++) {
      const X = x0 + x; if (X < 0 || X >= nowMsg.bmp.width) continue;
      const col = nowMsg.bmp.cols[X]; if (!col) continue;
      for (let y = 0; y < nowMsg.bmp.height; y++) if (col & (1 << y)) eg.fillRect((x - frac) * cw, y * ch, Math.ceil(cw), Math.ceil(ch));
    }
  }
  eg.fillStyle = 'rgba(255,184,77,.8)'; eg.fillRect(w / 2 - 1, 0, 2, h);
  eg.font = '500 16px "IBM Plex Mono", monospace'; eg.fillStyle = 'rgba(130,152,166,.9)';
  eg.fillText('LEFT EYES', 10, h - 10); const t = 'RIGHT EYES'; eg.fillText(t, w - 10 - eg.measureText(t).width, h - 10);
  $('nowtext').textContent = nowMsg ? `Eyes: “${nowMsg.text}” from ${nowMsg.by === you ? 'you' : nowMsg.by}` : 'Eyes: dark';
  $('queuetext').textContent = queue.length ? `${queue.length} waiting` : '';
}

const spark = $('spark'), sg = spark.getContext('2d'); const hist = new Float32Array(300); let hp = 0, lastHist = 0;
function setLR(bar, txt, v, scale) {
  const x = Math.max(-1, Math.min(1, v / scale)), wv = Math.abs(x) * 50;
  bar.style.width = wv + '%'; bar.style.left = x > 0 ? (50 - wv) + '%' : '50%';
  txt.textContent = Math.abs(v) < scale * 0.08 ? 'even' : (x > 0 ? 'left ' : 'right ') + '+' + Math.round(Math.abs(x) * 100) + '%';
}
function paintReadouts(now, ro) {
  $('ncells').textContent = ro.nAct.toLocaleString();
  $('hudcells').textContent = ro.nAct.toLocaleString();
  $('hudstep').textContent = Math.floor(currentStep(now)).toLocaleString();
  setLR($('bendbar'), $('bendtxt'), ro.bend, 0.06);
  setLR($('cilbar'), $('ciltxt'), ro.cil, 0.06);
  const st = Math.min(1, ro.st / 0.9); $('stbar').style.width = (st * 100) + '%'; $('sttxt').textContent = Math.round(st * 100) + '%';
  for (const [i, el] of prcEls) {
    const v = Math.min(1, act[i] * 1.4);
    el.style.background = `rgba(255,184,77,${(0.08 + v * 0.92).toFixed(2)})`;
    el.style.boxShadow = v > 0.3 ? `0 0 ${Math.round(v * 10)}px rgba(255,184,77,.8)` : 'none';
  }
  if (now - lastHist > 66) { hist[hp] = ro.nAct; hp = (hp + 1) % hist.length; lastHist = now; }
  const w = spark.width, h = spark.height; sg.clearRect(0, 0, w, h);
  let top = 200; for (const v of hist) if (v > top) top = v;
  sg.strokeStyle = '#1B2A36'; sg.lineWidth = 1; sg.beginPath(); sg.moveTo(0, h - 1); sg.lineTo(w, h - 1); sg.stroke();
  const path = () => { sg.beginPath(); for (let k = 0; k < hist.length; k++) { const v = hist[(hp + k) % hist.length]; const x = k / (hist.length - 1) * w, y = h - 2 - (v / top) * (h - 6); k ? sg.lineTo(x, y) : sg.moveTo(x, y); } };
  path(); sg.lineTo(w, h); sg.lineTo(0, h); sg.closePath(); sg.fillStyle = 'rgba(86,230,210,.12)'; sg.fill();
  path(); sg.strokeStyle = '#56E6D2'; sg.lineWidth = 2; sg.stroke();
}

/* ---------- feed ---------- */
function dirWord(v) { return v > 0.012 ? 'left side' : v < -0.012 ? 'right side' : 'even'; }
function summaryText(it) {
  const s = it.summary;
  if (!s) {
    if (it.kind === 'say' && it.step == null) return it.ahead ? `waiting (${it.ahead} ahead)` : 'up next';
    return 'reacting…';
  }
  if (s.peak < 3) return 'barely registered';
  return `${s.peak.toLocaleString()} cells fired · muscles ${dirWord(s.bend)} · cilia ${dirWord(s.cil)}` + (s.st > 0.3 ? ' · full startle' : '') + (s.flood > 0 ? ' · flooded its light sensors' : '');
}
let feedQueued = false;
function renderFeed() {
  if (feedQueued) return; feedQueued = true;
  requestAnimationFrame(() => {
    feedQueued = false;
    const ul = $('feed'); ul.replaceChildren();
    const items = [...feed.values()].reverse();
    if (!items.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = mode === 'offline' ? 'Offline. Messages and pokes only reach your copy.' : 'Nothing yet. Say something.'; ul.append(li); }
    for (const it of items.slice(0, 40)) {
      const li = document.createElement('li'); li.className = it.kind;
      const who = document.createElement('span'); who.className = 'who' + (it.by === you || it.by === 'you' ? ' you' : '');
      who.textContent = (it.by === you || it.by === 'you' ? 'you' : it.by) + ' ';
      const what = document.createElement('b');
      what.textContent = it.kind === 'say' ? `“${it.text}”` : `poked the ${pokeWhere(it.cells)}`;
      const res = document.createElement('span'); res.className = 'res'; res.textContent = '→ ' + summaryText(it);
      li.append(who, what, res); ul.append(li);
    }
    $('feedcount').textContent = feed.size ? `${feed.size} recent` : '';
  });
}

/* ---------- optional token bar ---------- */
fetch('/config.json').then((r) => r.json()).then(({ site }) => {
  if (!site || (!site.ticker && !site.contract && !(site.links || []).length)) return;
  const bar = $('token');
  if (site.ticker) { const t = document.createElement('span'); t.className = 'tick'; t.textContent = site.ticker; bar.append(t); }
  if (site.contract) {
    const ca = document.createElement('span'); ca.className = 'ca';
    const lab = document.createTextNode('CA ');
    const code = document.createElement('code'); code.textContent = site.contract;
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      navigator.clipboard?.writeText(site.contract).then(() => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); })
        .catch(() => { const range = document.createRange(); range.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); });
    });
    ca.append(lab, code, btn); bar.append(ca);
  }
  for (const l of site.links || []) { const a = document.createElement('a'); a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = l.label; bar.append(a); }
  bar.hidden = false;
}).catch(() => {});

/* ---------- main loop ---------- */
function updateActivity(now) {
  if (mode === 'offline' && local) { act.set(local.sim.r); return; }
  if (!curF) return;
  const a = prevF === curF ? 1 : Math.min(1, (now - curF.t) / (STEP_MS * 2));
  const P = prevF.bytes, C = curF.bytes;
  for (let i = 0; i < N; i++) act[i] = (P[i] + (C[i] - P[i]) * a) / 255;
}
let last = performance.now();
function frame(now) {
  const dt = Math.min(250, now - last); last = now;
  if (mode === 'offline' && local) { localAcc += dt; while (localAcc >= STEP_MS) { local.tick(); localAcc -= STEP_MS; } }
  updateActivity(now);
  const ro = readouts(act, roles);
  bendS += (Math.max(-1, Math.min(1, ro.bend / 0.08)) - bendS) * 0.15;
  stS += (Math.min(1, ro.st / 0.9) - stS) * 0.2;
  if (!reduceMotion && !drag && now - lastDrag > 2500) yaw += 0.0025;
  render(now); paintEye(now); paintReadouts(now, ro);
  requestAnimationFrame(frame);
}
setMode('connecting');
renderFeed();
connect();
requestAnimationFrame(frame);

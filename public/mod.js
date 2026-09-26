// Moderator panel for BRAINWORM, served at /mod.
// Admin calls carry a bearer token kept in sessionStorage (this tab only). The feed comes from
// the public /live socket, reconciled with GET /admin/state every 10 s.
// Everything users type is untrusted: it is only ever written with textContent, never innerHTML.

const TOKEN_KEY = 'wormAdminToken';
const POLL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const FEED_CAP = 200;              // rows kept in memory
const PAGE = matchMedia('(min-width: 960px)').matches ? 40 : 20;   // rows drawn at a time ("Show older" adds more)
const HOLD_AFTER_TOUCH_MS = 2500;  // new rows wait this long after a tap, so nothing jumps under a finger
const LIVE_SILENCE_MS = 20_000;    // the server sends a frame at least once a second; silence means a dead socket
const MUTE_SPAN = { 1: '1 hour', 24: '24 hours', 168: '7 days' };
const GONE_LABEL = { hidden: 'hidden', cleared: 'cleared', removed: 'removed', aged: 'off feed' };
const SEGNAME = { episphere: 'head', segment_0: 'segment 0', segment_1: 'segment 1', segment_2: 'segment 2', segment_3: 'segment 3', pygidium: 'tail', fragment: '' };

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();
const fmtNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? nf.format(v) : '–');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const enc = encodeURIComponent;

/* ---------- small helpers ---------- */
function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function setText(el, s) { if (el.textContent !== s) el.textContent = s; }
/** Put `nodes` into `parent` in this order, moving as little as possible (keeps focus and scroll steady). */
function place(parent, nodes) {
  let ref = parent.firstElementChild;
  for (const n of nodes) {
    if (n === ref) { ref = ref.nextElementSibling; continue; }
    parent.insertBefore(n, ref);
  }
  while (ref) { const next = ref.nextElementSibling; ref.remove(); ref = next; }
}
function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'now';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm';
  const hr = Math.floor(m / 60); if (hr < 24) return hr + 'h';
  return Math.floor(hr / 24) + 'd';
}
function fmtSpan(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
function fmtSlow(sec) { return !sec ? 'Off' : sec % 60 === 0 && sec >= 120 ? `${sec / 60}m` : `${sec}s`; }

/* ---------- server clock ---------- */
// Countdowns (mutes, announcement) use server timestamps; correct for a phone clock that is off.
let clockSkew = 0;
const now = () => Date.now() + clockSkew;
function noteClock(res) {
  const d = Date.parse(res.headers.get('date') || '');
  if (!Number.isFinite(d)) return;
  const s = d + 500 - Date.now();          // the Date header has 1 s resolution
  clockSkew = Math.abs(s) > 2000 ? Math.round(s) : 0;
}

/* ---------- toasts ---------- */
function toast(text, kind = 'ok') {
  const host = kind === 'err' ? $('alerts') : $('toasts');
  const t = h('div', 'toast' + (kind === 'err' ? ' err' : ''), text);
  const drop = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  t.addEventListener('click', drop);
  host.append(t);
  const all = document.querySelectorAll('.toasts .toast');
  if (all.length > 3) all[0].remove();
  setTimeout(drop, kind === 'err' ? 6500 : 3200);
}

/* ---------- token and admin API ---------- */
function readToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function saveToken(t) { try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* private mode: token lives in memory only */ } }
function dropToken() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

let token = '';
let unlocked = false;

class Locked extends Error {}

async function request(path, method, t) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(path, { method, headers: { Authorization: 'Bearer ' + t }, cache: 'no-store', signal: ctrl.signal });
    noteClock(res);
    return res;
  } catch {
    throw new Error(ctrl.signal.aborted ? 'The server took too long to answer.' : 'Could not reach the server.');
  } finally {
    clearTimeout(timer);
  }
}

/** Admin call. Returns the JSON body (check body.ok). A 404 means the token is wrong or expired: lock. */
async function api(path, method = 'POST') {
  const t = token;
  if (!t) throw new Locked('locked');
  const res = await request(path, method, t);
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    if (token === t) lock('The server did not accept the token. Enter it again.');
    throw new Locked('locked');
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error((body && typeof body.error === 'string' && body.error) || `Server error ${res.status}.`);
  if (!body || typeof body !== 'object') throw new Error('Unexpected reply from the server.');
  return body;
}
function fail(e, what) { if (!(e instanceof Locked)) toast(`${what}: ${e.message}`, 'err'); }
function refused(r, fallback) { toast(typeof r.error === 'string' && r.error ? r.error : fallback, 'err'); }

/* ---------- lock screen ---------- */
function showLock(msg) {
  $('app').hidden = true;
  $('lock').hidden = false;
  document.body.classList.remove('lockdown');
  document.title = 'Mod panel · BRAINWORM';
  $('lockerr').textContent = msg || '';
  $('token').focus();
}

$('lockform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('token'), btn = $('unlock');
  const t = input.value.trim();
  $('lockerr').textContent = '';
  if (!t) { $('lockerr').textContent = 'Paste the admin token first.'; input.focus(); return; }
  btn.disabled = true; btn.textContent = 'Checking…';
  let result;
  try {
    const res = await request('/admin/state', 'GET', t);
    if (res.status === 200) {
      let s = null; try { s = await res.json(); } catch { /* handled below */ }
      result = s && typeof s === 'object' ? { ok: true, state: s } : { error: 'Unexpected reply from the server.' };
    } else if (res.status === 404 || res.status === 401 || res.status === 403) result = { bad: true };
    else result = { error: `The server answered ${res.status}. Try again in a moment.` };
  } catch (err) {
    result = { error: err.message };
  }
  btn.disabled = false; btn.textContent = 'Unlock';
  if (result.ok) {
    input.value = '';
    token = t; saveToken(t);
    start(result.state);
  } else if (result.bad) {
    $('lockerr').textContent = 'That token is not right.';
    input.select();
  } else {
    $('lockerr').textContent = result.error;
  }
});

$('lockbtn').addEventListener('click', () => {
  if (!confirm('Lock this panel? You will need the admin token again.')) return;
  lock('');
});

let tickTimer = 0;

function start(state) {
  unlocked = true;
  $('lock').hidden = true;
  $('app').hidden = false;
  if (state) { applyState(state, performance.now()); lastSync = Date.now(); }
  renderSync();
  renderMod();
  renderFeedNow();
  connectLive();
  schedulePoll(state ? POLL_MS : 0);
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
  setTimeout(loadWiring, 1500);
}

function lock(msg) {
  unlocked = false;
  token = '';
  dropToken();
  stopLive();
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  resetData();
  showLock(msg);
}

/* ---------- moderation state: pauses, slow mode, announcement ---------- */
const mod = { chatPaused: false, pokesPaused: false, slowSec: 0, announce: null };
const busy = { chat: false, pokes: false, slow: false, panic: false, ann: false };

function applyMod(m) {
  if (!m || typeof m !== 'object') return;
  if (typeof m.chatPaused === 'boolean') mod.chatPaused = m.chatPaused;
  if (typeof m.pokesPaused === 'boolean') mod.pokesPaused = m.pokesPaused;
  if (isNum(m.slowSec)) mod.slowSec = Math.max(0, m.slowSec);
  if ('announce' in m) {
    const a = m.announce;
    mod.announce = a && typeof a === 'object' && typeof a.text === 'string' && a.text ? { text: a.text, until: isNum(a.until) ? a.until : null } : null;
  }
  renderMod();
}

function setSwitch(btn, val, on, isBusy) {
  btn.setAttribute('aria-checked', on ? 'true' : 'false');
  btn.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  setText(val, on ? 'ON' : 'PAUSED');
}

function renderMod() {
  setSwitch($('chatTog'), $('chatVal'), !mod.chatPaused, busy.chat);
  setSwitch($('pokeTog'), $('pokeVal'), !mod.pokesPaused, busy.pokes);
  const sel = $('slow');
  if (!busy.slow) {
    const v = String(mod.slowSec || 0);
    if (![...sel.options].some((o) => o.value === v)) sel.add(new Option(fmtSlow(mod.slowSec), v));
    sel.value = v;
  }
  $('slowTog').classList.toggle('on', Number(sel.value) > 0);
  $('slowTog').setAttribute('aria-busy', busy.slow ? 'true' : 'false');
  $('panic').disabled = busy.panic;
  const down = unlocked && (mod.chatPaused || mod.pokesPaused);
  document.body.classList.toggle('lockdown', down);
  document.title = (down ? 'Paused · ' : '') + 'Mod panel · BRAINWORM';
  renderAnnounce();
}

async function togglePause(which) {
  if (busy[which]) return;
  const key = which === 'chat' ? 'chatPaused' : 'pokesPaused';
  const next = !mod[key];
  busy[which] = true; renderMod();
  try {
    const r = await api(`/admin/pause?${which}=${next ? 1 : 0}`);
    if (r.ok === false) refused(r, 'The server did not change that.');
    else {
      applyMod({ [key]: next, ...r });
      toast(`${which === 'chat' ? 'Chat' : 'Pokes'} ${mod[key] ? 'paused' : 'back on'}.`);
    }
  } catch (e) { fail(e, 'Could not change that'); }
  finally { busy[which] = false; if (unlocked) renderMod(); }
}
$('chatTog').addEventListener('click', () => togglePause('chat'));
$('pokeTog').addEventListener('click', () => togglePause('pokes'));

$('slow').addEventListener('change', async () => {
  const sec = Number($('slow').value);
  busy.slow = true; renderMod();
  try {
    const r = await api('/admin/slowmode?sec=' + sec);
    if (r.ok === false) refused(r, 'The server did not change slow mode.');
    else {
      mod.slowSec = isNum(r.slowSec) ? r.slowSec : sec;
      toast(mod.slowSec ? `Slow mode on: ${fmtSlow(mod.slowSec)} between messages.` : 'Slow mode off.');
    }
  } catch (e) { fail(e, 'Could not change slow mode'); }
  finally { busy.slow = false; if (unlocked) renderMod(); }
});

$('panic').addEventListener('click', async () => {
  if (busy.panic) return;
  if (!confirm('PANIC\n\nPause chat and pokes for everyone and clear the public feed?')) return;
  busy.panic = true; renderMod();
  const did = [];
  // Pause first so nothing new lands between the two calls.
  try {
    const r = await api('/admin/pause?chat=1&pokes=1');
    if (r.ok === false) refused(r, 'The server did not pause.');
    else { applyMod({ chatPaused: true, pokesPaused: true, ...r }); did.push('Chat and pokes paused'); }
  } catch (e) { fail(e, 'Could not pause'); }
  try {
    const r = await api('/admin/clear');
    if (r.ok === false) refused(r, 'The server did not clear the feed.');
    else did.push(did.length ? 'feed cleared' : 'Feed cleared');
  } catch (e) { fail(e, 'Could not clear the feed'); }
  busy.panic = false;
  if (!unlocked) return;
  renderMod();
  if (did.length) toast(did.join(', ') + '. Mute the raiders, then turn things back on.');
  refreshSoon();
});

/* ---------- announcement ---------- */
let annShown = null;   // text currently drawn in the box
let annLeftEl = null;
function renderAnnounce() {
  const box = $('annNow');
  const a = mod.announce;
  const left = a && a.until ? (a.until - now()) / 1000 : Infinity;
  const on = !!a && left > 0;
  $('annClear').disabled = busy.ann || !a;
  $('annPost').disabled = busy.ann;
  if (!on) {
    if (annShown !== '') { box.classList.remove('on'); box.replaceChildren('No announcement showing.'); annShown = ''; annLeftEl = null; }
    return;
  }
  if (annShown !== a.text) {
    box.classList.add('on');
    const head = h('span', null, 'Showing to everyone · ');
    annLeftEl = h('span', 'left');
    head.append(annLeftEl);
    box.replaceChildren(head, h('q', null, a.text));
    annShown = a.text;
  }
  setText(annLeftEl, isFinite(left) ? `${fmtSpan(left)} left` : 'until cleared');
}
function annCounter() {
  const n = $('annText').value.length;
  const c = $('annCount');
  setText(c, `${n}/80`);
  c.classList.toggle('full', n >= 80);
}
$('annText').addEventListener('input', annCounter);

$('annform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('annText').value.trim();
  const minutes = Number($('annMin').value);
  const err = $('annErr');
  err.textContent = '';
  if (!text) { err.textContent = 'Type the announcement first. To take one down, use Clear.'; $('annText').focus(); return; }
  busy.ann = true; renderAnnounce();
  try {
    const r = await api(`/admin/announce?text=${enc(text)}&minutes=${minutes}`);
    if (r.ok === false) err.textContent = typeof r.error === 'string' && r.error ? r.error : 'The server did not accept that announcement.';
    else {
      $('annText').value = ''; annCounter();
      applyMod({ announce: r.announce !== undefined ? r.announce : { text, until: now() + minutes * 60_000 } });
      toast('Announcement posted.');
      refreshSoon();
    }
  } catch (ex) { fail(ex, 'Could not post'); }
  finally { busy.ann = false; if (unlocked) renderAnnounce(); }
});

$('annClear').addEventListener('click', async () => {
  $('annErr').textContent = '';
  busy.ann = true; renderAnnounce();
  try {
    const r = await api(`/admin/announce?text=&minutes=${Number($('annMin').value)}`);
    if (r.ok === false) refused(r, 'The server did not clear the announcement.');
    else { applyMod({ announce: null }); toast('Announcement taken down.'); refreshSoon(); }
  } catch (ex) { fail(ex, 'Could not clear'); }
  finally { busy.ann = false; if (unlocked) renderAnnounce(); }
});

/* ---------- header numbers, stats, twitch ---------- */
let queueN = null;
let uptime = null;     // {sec, at}
let lastSync = 0, syncErr = '';

function setWatchers(n) { if (isNum(n)) setText($('watchers'), fmtNum(n)); }
function setQueue(n) { if (isNum(n)) { queueN = Math.max(0, n); renderQueue(); } }
function bumpQueue(d) { if (queueN != null) { queueN = Math.max(0, queueN + d); renderQueue(); } }
function renderQueue() {
  setText($('queue'), queueN == null ? '–' : fmtNum(queueN));
  $('queue').parentElement.classList.toggle('busy', queueN >= 8);
}

function renderStats(st) {
  if (!st || typeof st !== 'object') return;
  setText($('sMsg'), fmtNum(st.messagesLastMin));
  setText($('sPoke'), fmtNum(st.pokesLastMin));
  setText($('sRej'), fmtNum(st.rejectedLastMin));
  $('sRej').classList.toggle('hot', st.rejectedLastMin >= 5);
}
function renderUptime() {
  if (!uptime) return;
  const sec = uptime.sec + (Date.now() - uptime.at) / 1000;
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  setText($('sUp'), d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`);
}
function renderSync() {
  const el = $('sync');
  if (!lastSync) { setText(el, syncErr ? 'not synced' : 'syncing…'); el.classList.toggle('stale', !!syncErr); return; }
  const age = Date.now() - lastSync;
  const stale = age > 25_000;
  setText(el, stale ? `last sync ${fmtAgo(age)} ago` : age < 5000 ? 'synced now' : `synced ${fmtAgo(age)} ago`);
  el.classList.toggle('stale', stale);
}
function renderTwitch(tw) {
  const el = $('twitch');
  if (!tw || typeof tw !== 'object') { el.hidden = true; return; }
  el.hidden = false;
  if (!tw.enabled) { el.dataset.state = 'off'; el.replaceChildren(h('span', null, 'Twitch bridge off')); return; }
  const ch = h('b', null, '#' + String(tw.channel || '?'));
  const line = h('span');
  const bits = [tw.connected ? 'connected' : 'disconnected'];
  if (tw.connected) bits.push(tw.joined ? 'joined' : 'not joined');
  bits.push(`${fmtNum(tw.received)} received`);
  el.dataset.state = tw.connected && tw.joined ? 'ok' : 'warn';
  line.append('Twitch ', ch, ' · ' + bits.join(' · '));
  el.replaceChildren(line);
}

/* ---------- muted list ---------- */
let banList = [];
const banRows = new Map();       // key -> {li, who, why, left, btn, label, until, busy}
const keyByHandle = new Map();   // handle -> ban key, learned from /admin/ban replies
let mutedKeys = new Set(), mutedLabels = new Set();

function banLeft(until) {
  if (!isNum(until)) return 'until unmuted';
  const s = (until - now()) / 1000;
  return s > 0 ? `${fmtSpan(s)} left` : 'ending';
}
function renderBans(list) {
  banList = list.filter((b) => b && typeof b === 'object' && b.key != null);
  const sorted = [...banList].sort((a, b) => (isNum(a.until) ? a.until : Infinity) - (isNum(b.until) ? b.until : Infinity));
  const nodes = [];
  const seen = new Set();
  for (const b of sorted) {
    const key = String(b.key);
    seen.add(key);
    let row = banRows.get(key);
    if (!row) {
      const li = h('li', 'ban');
      const who = h('span', 'who'), why = h('span', 'why'), left = h('span', 'left');
      const btn = h('button', 'btn btn-ghost', 'Unmute');
      btn.type = 'button';
      btn.addEventListener('click', () => unban(key));
      li.append(who, why, left, btn);
      row = { li, who, why, left, btn, busy: false };
      banRows.set(key, row);
    }
    row.label = String(b.label || key);
    row.until = b.until;
    setText(row.who, row.label);
    setText(row.why, b.reason ? String(b.reason) : '');
    row.why.hidden = !b.reason;
    setText(row.left, banLeft(b.until));
    row.btn.setAttribute('aria-label', `Unmute ${row.label}`);
    nodes.push(row.li);
  }
  for (const key of [...banRows.keys()]) if (!seen.has(key)) banRows.delete(key);
  place($('bans'), nodes);
  const n = sorted.length;
  setText($('banCount'), n ? String(n) : '');
  setText($('jumpMuted'), n ? String(n) : '');
  $('bansEmpty').hidden = n > 0;
  mutedKeys = new Set(sorted.map((b) => String(b.key)));
  mutedLabels = new Set(sorted.map((b) => String(b.label || '')));
  for (const it of items.values()) {
    const m = isMuted(it);
    if (m !== it.muted) { it.muted = m; updateRow(it); }
  }
}
function isMuted(it) {
  const k = keyByHandle.get(it.by);
  return (k != null && mutedKeys.has(k)) || mutedLabels.has(it.by);
}
async function unban(key) {
  const row = banRows.get(key);
  if (!row || row.busy) return;
  row.busy = true; row.li.classList.add('busy');
  try {
    const r = await api('/admin/unban?key=' + enc(key));
    if (r.ok === false) refused(r, 'The server did not unmute them.');
    else {
      toast(`Unmuted ${row.label}.`);
      renderBans(banList.filter((b) => String(b.key) !== key));
    }
  } catch (e) { fail(e, 'Could not unmute'); }
  finally { row.busy = false; row.li.classList.remove('busy'); refreshSoon(); }
}

/* ---------- blocklist ---------- */
let blExtra = [], blBase = null;
const phraseRows = new Map();    // phrase -> {li, busy}

function renderBlocklist(bl) {
  if (!bl || typeof bl !== 'object') return;
  if (isNum(bl.base)) blBase = bl.base;
  if (Array.isArray(bl.extra)) renderExtra(bl.extra);
  else renderBlNote();
}
function renderExtra(list) {
  blExtra = list.filter((p) => typeof p === 'string' && p);
  const nodes = [];
  for (const p of blExtra) {
    let row = phraseRows.get(p);
    if (!row) {
      const li = h('li', 'phrase');
      const btn = h('button', null, '×');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Stop blocking “${p}”`);
      btn.addEventListener('click', () => unblock(p));
      li.append(h('span', null, p), btn);
      row = { li, busy: false };
      phraseRows.set(p, row);
    }
    nodes.push(row.li);
  }
  for (const p of [...phraseRows.keys()]) if (!blExtra.includes(p)) phraseRows.delete(p);
  place($('extra'), nodes);
  renderBlNote();
}
function renderBlNote() {
  const total = blExtra.length + (blBase || 0);
  setText($('blCount'), total ? fmtNum(total) : '');
  const parts = [];
  if (blExtra.length) parts.push(`${fmtNum(blExtra.length)} added here`);
  if (blBase != null) parts.push(`${fmtNum(blBase)} from the blocklist file`);
  setText($('blBase'), (parts.length ? parts.join(', plus ') + '. ' : '') + 'Messages containing any of them are rejected.');
}
$('blform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('blText');
  const phrase = input.value.trim().replace(/\s+/g, ' ');
  if (!phrase) { input.focus(); return; }
  if (blExtra.includes(phrase.toLowerCase()) || blExtra.includes(phrase)) { toast('That phrase is already blocked.'); return; }
  const btn = e.submitter || $('blform').querySelector('button');
  btn.disabled = true;
  try {
    const r = await api('/admin/blocklist/add?phrase=' + enc(phrase));
    if (r.ok === false) refused(r, 'The server did not add that phrase.');
    else {
      input.value = '';
      if (Array.isArray(r.extra)) renderExtra(r.extra); else refreshSoon();
      toast(`Blocking “${phrase.toLowerCase()}”.`);
    }
  } catch (ex) { fail(ex, 'Could not add'); }
  finally { btn.disabled = false; }
});
async function unblock(p) {
  const row = phraseRows.get(p);
  if (!row || row.busy) return;
  row.busy = true; row.li.classList.add('busy');
  try {
    const r = await api('/admin/blocklist/remove?phrase=' + enc(p));
    if (r.ok === false) refused(r, 'The server did not remove that phrase.');
    else {
      if (Array.isArray(r.extra)) renderExtra(r.extra); else renderExtra(blExtra.filter((x) => x !== p));
      toast(`No longer blocking “${p}”.`);
    }
  } catch (e) { fail(e, 'Could not remove'); }
  finally { row.busy = false; row.li.classList.remove('busy'); }
}
$('blReload').addEventListener('click', async () => {
  const btn = $('blReload');
  btn.disabled = true;
  try {
    const r = await api('/admin/reload-blocklist');
    if (r.ok === false) refused(r, 'The server did not reload the file.');
    else { toast(isNum(r.entries) ? `Reloaded the file. ${fmtNum(r.entries)} phrases in effect.` : 'Reloaded the file.'); refreshSoon(); }
  } catch (e) { fail(e, 'Could not reload'); }
  finally { btn.disabled = false; }
});

/* ---------- feed ---------- */
const items = new Map();        // id -> item (data + its row, once drawn)
const hiddenIds = new Set();    // hides that arrived before we knew the item
const counts = new Map();       // handle -> rows from them in memory
let seqN = 0;
let showLimit = PAGE;
let frozen = false, hideGone = false, holdUntil = 0, forceFlush = false, pendingCount = 0;
let wiring = null, wiringLoading = false;
const feedList = $('feed');

const isTwitch = (it) => it.src === 'twitch' || it.by.startsWith('twitch:');
const shownName = (it) => (it.by.startsWith('twitch:') ? it.by.slice(7) : it.by);

function pokeWhere(cells) {
  if (!wiring || !Array.isArray(cells) || !cells.length) return 'worm';
  const segs = {}; let left = 0, n = 0;
  for (const i of cells) {
    const c = Number.isInteger(i) ? wiring.n[i] : null;
    if (!c) continue;
    n++;
    const s = wiring.segs[c[3]];
    segs[s] = (segs[s] || 0) + 1;
    if (c[2] === 0) left++;
  }
  if (!n) return 'worm';
  const seg = Object.entries(segs).sort((a, b) => b[1] - a[1])[0][0];
  return `${left >= n / 2 ? 'left' : 'right'} ${SEGNAME[seg] || 'body'}`;
}
async function loadWiring() {
  // Only used to say where a poke landed, like the public feed does. Optional.
  if (wiring || wiringLoading || !unlocked) return;
  wiringLoading = true;
  try {
    const res = await fetch('/data/wiring.json');
    const D = res.ok ? await res.json() : null;
    if (D && Array.isArray(D.n) && Array.isArray(D.segs)) {
      wiring = { n: D.n, segs: D.segs };
      for (const it of items.values()) if (it.kind === 'poke') updateRow(it);
    }
  } catch { /* keep "poked the worm" */ }
  finally { wiringLoading = false; }
}

function whatText(it) {
  if (it.kind === 'poke') return `poked the ${pokeWhere(it.cells)}`;
  if (it.kind === 'tug') return `tug: “${it.a ?? '?'}” vs “${it.b ?? '?'}”`;
  return `“${it.text ?? ''}”`;
}
function dirWord(v) { return v > 0.012 ? 'left side' : v < -0.012 ? 'right side' : 'even'; }
function summaryText(it) {
  const s = it.summary;
  if (s == null) {
    if (it.kind !== 'poke' && it.step == null) return it.ahead ? `waiting (${it.ahead} ahead)` : 'up next';
    return 'reacting…';
  }
  if (typeof s === 'string') return s;
  if (typeof s !== 'object') return '';
  const out = [];
  if (s.tug && typeof s.tug === 'object') {
    const w = s.tug.winner;
    out.push(w === 'a' ? `bent toward “${it.a ?? 'A'}”` : w === 'b' ? `bent toward “${it.b ?? 'B'}”` : 'tie');
  }
  if (isNum(s.peak)) {
    if (s.peak < 3) out.push('barely registered');
    else {
      out.push(`${fmtNum(s.peak)} cells fired`, `muscles ${dirWord(s.bend)}`, `cilia ${dirWord(s.cil)}`);
      if (s.st > 0.3) out.push('full startle');
      if (s.flood > 0) out.push('flooded its light sensors');
    }
  }
  return out.length ? out.join(' · ') : 'done';
}

function upsert(raw) {
  if (!raw || typeof raw !== 'object' || raw.id == null) return null;
  const id = String(raw.id);
  let it = items.get(id);
  if (!it) {
    it = { id, kind: 'say', by: '?', k: isNum(raw.ts) ? raw.ts : now(), seq: ++seqN, seen: performance.now(), gone: hiddenIds.has(id) ? 'hidden' : null, busy: false, muted: false, el: null, r: null };
    items.set(id, it);
  }
  if (raw.kind === 'say' || raw.kind === 'poke' || raw.kind === 'tug') it.kind = raw.kind;
  if (raw.by != null) it.by = String(raw.by);
  if (raw.src != null) it.src = String(raw.src);
  if (raw.text != null) it.text = String(raw.text);
  if (raw.a != null) it.a = String(raw.a);
  if (raw.b != null) it.b = String(raw.b);
  if (Array.isArray(raw.cells)) it.cells = raw.cells;
  if (isNum(raw.step)) it.step = raw.step;
  if (isNum(raw.ts)) it.ts = raw.ts;
  if (isNum(raw.ahead)) it.ahead = raw.ahead;
  if (raw.summary != null) it.summary = raw.summary;
  it.muted = isMuted(it);
  updateRow(it);
  return it;
}

function setGone(it, why) {
  if (it.gone === why) return;
  // hiding a message that hasn't played yet also drops it from the worm's queue
  if (why === 'hidden' && (!it.gone || it.gone === 'aged') && it.kind !== 'poke' && it.step == null) bumpQueue(-1);
  it.gone = why;
  updateRow(it);
}

/** The server's whole public feed (hello, feed, or /admin/state). Rows we have that it lacks were removed. */
function applyFeedList(list, since) {
  if (!Array.isArray(list)) return;
  const ids = new Set();
  let oldest = Infinity;
  for (const raw of list) {
    const it = upsert(raw);
    if (!it) continue;
    ids.add(it.id);
    if (isNum(raw.ts) && raw.ts < oldest) oldest = raw.ts;
    if (it.gone === 'aged') setGone(it, null);
  }
  for (const it of items.values()) {
    if (ids.has(it.id) || it.gone || it.seen >= since) continue;
    if (!ids.size) setGone(it, 'cleared');
    else if (it.k < oldest) setGone(it, 'aged');     // scrolled off the end of the public feed
    else setGone(it, 'removed');
  }
  renderFeed();
}

function buildRow(it) {
  const li = h('li', 'row');
  li.dataset.id = it.id;
  const who = h('span', 'who'), tw = h('span', 'badge tw', 'Twitch'), cnt = h('span', 'count'), tag = h('span', 'tag'), ago = h('span', 'ago');
  const meta = h('div', 'meta');
  meta.append(who, tw, cnt, tag, ago);
  const msg = h('p', 'msg'), res = h('p', 'res');
  const acts = h('div', 'acts');
  acts.setAttribute('role', 'group');
  acts.setAttribute('aria-label', `Actions for ${it.by}`);
  const hide = h('button', 'act', 'Hide');
  hide.type = 'button'; hide.dataset.act = 'hide';
  hide.setAttribute('aria-label', `Hide this from the public feed (${it.by})`);
  const mutes = [1, 24, 168].map((hrs) => {
    const b = h('button', 'act mute');
    b.type = 'button'; b.dataset.act = 'mute'; b.dataset.h = String(hrs);
    b.append(h('small', null, 'Mute'), hrs === 168 ? '7d' : hrs + 'h');
    b.setAttribute('aria-label', `Mute ${it.by} for ${MUTE_SPAN[hrs]}`);
    return b;
  });
  acts.append(hide, ...mutes);
  li.append(meta, msg, res, acts);
  it.el = li;
  it.r = { who, tw, cnt, tag, ago, msg, res, hide, mutes };
  updateRow(it);
}

function updateRow(it) {
  const r = it.r;
  if (!r) return;
  it.el.className = 'row k-' + it.kind + (it.gone ? ' gone g-' + it.gone : '') + (it.busy ? ' busy' : '');
  it.el.setAttribute('aria-busy', it.busy ? 'true' : 'false');
  setText(r.who, shownName(it));
  r.tw.hidden = !isTwitch(it);
  const tags = [];
  if (it.busy) tags.push('working');
  if (it.muted) tags.push('muted');
  if (it.gone) tags.push(GONE_LABEL[it.gone]);
  setText(r.tag, tags.join(' · '));
  r.tag.hidden = !tags.length;
  r.tag.classList.toggle('soft', !it.muted && (it.busy || it.gone === 'aged'));
  setText(r.msg, whatText(it));
  setText(r.res, '→ ' + summaryText(it));
  setText(r.ago, fmtAgo(now() - (it.ts ?? it.k)));
  const c = counts.get(it.by) || 0;
  setText(r.cnt, c > 1 ? '×' + c : '');
  r.hide.disabled = !!it.gone || it.busy;
  for (const b of r.mutes) b.disabled = it.busy;
}

/* Rows never move under a finger: while you touch the feed, scroll into it, or freeze it,
   new rows wait behind the "N new" button. Existing rows keep their height when they change. */
function isHeld() {
  if (forceFlush) return false;
  if (frozen) return true;
  if (performance.now() < holdUntil) return true;
  const ae = document.activeElement;
  if (ae && ae !== document.body && feedList.contains(ae) && ae.matches(':focus-visible')) return true;
  const barH = $('bar').getBoundingClientRect().height;
  return feedList.getBoundingClientRect().top < barH - 2;
}

let renderQueued = false;
function renderFeed() {
  if (renderQueued) return;
  renderQueued = true;
  // hidden tabs don't run animation frames; keep the list current for when the mod switches back
  if (document.hidden) setTimeout(renderFeedNow, 250); else requestAnimationFrame(renderFeedNow);
}
function renderFeedNow() {
  renderQueued = false;
  const all = [...items.values()].sort((x, y) => y.k - x.k || y.seq - x.seq);
  for (let i = FEED_CAP; i < all.length; i++) { const it = all[i]; items.delete(it.id); if (it.el) it.el.remove(); }
  if (all.length > FEED_CAP) all.length = FEED_CAP;

  counts.clear();
  for (const it of all) counts.set(it.by, (counts.get(it.by) || 0) + 1);

  // While held, rows already on screen stay put. Anything that would land above the last of
  // them waits (counted in the pill); older rows can still be appended below.
  const held = isHeld();
  let lastOn = -1;
  if (held) for (let i = all.length - 1; i >= 0; i--) if (all[i].el && all[i].el.isConnected) { lastOn = i; break; }
  const nodes = [];
  let pending = 0, older = 0;
  for (let i = 0; i < all.length; i++) {
    const it = all[i];
    const onScreen = !!(it.el && it.el.isConnected);
    if (hideGone && it.gone && it.gone !== 'aged' && !(held && onScreen)) continue;
    if (held && !onScreen && i < lastOn) { pending++; continue; }
    if (nodes.length >= showLimit) { older++; continue; }
    if (!it.el) buildRow(it);
    else updateRow(it);
    nodes.push(it.el);
  }
  place(feedList, nodes);
  pendingCount = pending;

  const pill = $('newPill');
  pill.hidden = !pending;
  if (pending) {
    setText(pill, `↑ ${pending} new`);
    pill.setAttribute('aria-label', `Show ${pending} new ${pending === 1 ? 'item' : 'items'}`);
  }
  const more = $('more');
  more.hidden = !older;
  if (older) setText(more, `Show older (${older})`);
  $('feedEmpty').hidden = nodes.length > 0 || pending > 0;
  setText($('feedEmpty'), ws && liveState === 'live' ? 'Nothing in the feed yet.' : 'Waiting for the live feed…');
  setText($('feedCount'), all.length ? fmtNum(all.length) : '');
}

feedList.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const li = b.closest('li.row');
  const it = li && items.get(li.dataset.id);
  if (!it) return;
  if (b.dataset.act === 'hide') hideItem(it);
  else muteItem(it, Number(b.dataset.h));
});

async function hideItem(it) {
  if (it.busy || it.gone) return;
  it.busy = true; updateRow(it);
  try {
    const r = await api('/admin/hide?id=' + enc(it.id));
    it.busy = false;
    updateRow(it);   // the server's own "hide" broadcast may already have marked it
    if (r.ok !== false) { setGone(it, 'hidden'); toast('Hidden from the public feed.'); }
    else if (r.error) refused(r, '');
    else { if (!it.gone) setGone(it, 'removed'); toast('That was already gone from the public feed.'); }
  } catch (e) {
    it.busy = false; updateRow(it);
    fail(e, 'Could not hide');
  }
}

async function muteItem(it, hours) {
  const span = MUTE_SPAN[hours];
  if (!span || it.busy) return;
  const who = isTwitch(it) ? `${shownName(it)} (Twitch)` : it.by;
  if (!confirm(`Mute ${who} for ${span}?\n\n${whatText(it)}\n\nThey can't send messages or pokes until then, and their recent messages are hidden.`)) return;
  const rows = [...items.values()].filter((x) => x.by === it.by && !x.busy);
  for (const x of rows) { x.busy = true; updateRow(x); }
  try {
    const r = await api(`/admin/ban?id=${enc(it.id)}&hours=${hours}`);
    if (r.ok === false) refused(r, 'The server did not mute them.');
    else {
      const key = r.key != null ? String(r.key) : null;
      const label = r.label ? String(r.label) : it.by;
      if (key) {
        keyByHandle.set(it.by, key);
        const others = banList.filter((b) => String(b.key) !== key);
        renderBans([...others, { key, label, until: now() + hours * 3_600_000, reason: '' }]);
      }
      for (const x of rows) x.muted = true;
      toast(`Muted ${label} for ${span}.`);
      refreshSoon();
    }
  } catch (e) { fail(e, 'Could not mute'); }
  finally { for (const x of rows) { x.busy = false; updateRow(x); } }
}

$('freeze').addEventListener('click', () => {
  frozen = !frozen;
  $('freeze').setAttribute('aria-pressed', String(frozen));
  toast(frozen ? 'Feed frozen. New items wait behind the “new” button.' : 'Feed live again.');
  renderFeed();
});
$('hideGone').addEventListener('click', () => {
  hideGone = !hideGone;
  $('hideGone').setAttribute('aria-pressed', String(hideGone));
  renderFeed();
});
$('more').addEventListener('click', () => { showLimit = Math.min(FEED_CAP, showLimit + PAGE); renderFeed(); });
$('newPill').addEventListener('click', () => {
  holdUntil = 0;
  forceFlush = true; renderFeedNow(); forceFlush = false;
  $('feedcard').scrollIntoView({ block: 'start' });
  const first = feedList.querySelector('button');
  if (first && document.activeElement === $('newPill')) first.focus({ preventScroll: true });
});
$('feedcard').addEventListener('pointerdown', () => { holdUntil = Infinity; });
const releaseHold = () => {
  if (holdUntil !== Infinity) return;
  holdUntil = performance.now() + HOLD_AFTER_TOUCH_MS;
  setTimeout(() => { if (pendingCount) renderFeed(); }, HOLD_AFTER_TOUCH_MS + 50);
};
addEventListener('pointerup', releaseHold);
addEventListener('pointercancel', releaseHold);
addEventListener('scroll', () => { if (pendingCount && !isHeld()) renderFeed(); }, { passive: true });

/* ---------- state from /admin/state ---------- */
function applyState(s, since) {
  if (!s || typeof s !== 'object') return;
  setWatchers(s.watchers);
  setQueue(Array.isArray(s.queue) ? s.queue.length : s.queue);
  if (isNum(s.uptimeSec)) uptime = { sec: s.uptimeSec, at: Date.now() };
  renderUptime();
  applyMod(s);
  if (Array.isArray(s.bans)) renderBans(s.bans);
  renderBlocklist(s.blocklist);
  renderTwitch(s.twitch);
  renderStats(s.stats);
  if (Array.isArray(s.feed)) applyFeedList(s.feed, since);
}

let pollTimer = 0, polling = false, pollAgain = false;
function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }
const refreshSoon = () => { if (unlocked) schedulePoll(300); };
async function poll() {
  if (!unlocked) return;
  if (polling) { pollAgain = true; return; }
  polling = true;
  clearTimeout(pollTimer);
  const since = performance.now();
  try {
    const s = await api('/admin/state', 'GET');
    if (!unlocked) return;
    if (s.ok === false) throw new Error(typeof s.error === 'string' && s.error ? s.error : 'The server could not send its state.');
    applyState(s, since);
    lastSync = Date.now();
    if (syncErr) toast('Back in touch with the server.');
    syncErr = '';
  } catch (e) {
    if (e instanceof Locked) return;
    if (!syncErr) toast(`Could not refresh: ${e.message} Retrying.`, 'err');
    syncErr = e.message;
  } finally {
    polling = false;
    renderSync();
    if (unlocked) schedulePoll(pollAgain ? 200 : POLL_MS);
    pollAgain = false;
  }
}

/* ---------- live connection (same socket as the public page; counts as one viewer) ---------- */
let ws = null, retry = 0, retryTimer = 0, liveWanted = false, liveState = 'connecting', lastLiveAt = 0;

function setConn(state) {
  liveState = state;
  const el = $('conn');
  el.dataset.state = state;
  setText(el, state === 'live' ? 'Live' : state === 'offline' ? 'Offline' : 'Connecting');
}
function connectLive() {
  liveWanted = true;
  clearTimeout(retryTimer);
  if (ws) return;
  if (liveState !== 'offline') setConn('connecting');
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let sock;
  try { sock = new WebSocket(proto + location.host + '/live'); } catch { scheduleLive(); return; }
  ws = sock;
  sock.binaryType = 'arraybuffer';
  lastLiveAt = Date.now();
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    lastLiveAt = Date.now();
    if (typeof e.data !== 'string') return;   // brain activity frames: not needed here
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m && typeof m === 'object') onLive(m);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (!liveWanted) return;
    setConn('offline');
    renderFeed();
    scheduleLive();
  };
}
function scheduleLive() {
  clearTimeout(retryTimer);
  if (liveWanted) retryTimer = setTimeout(connectLive, Math.min(15_000, 1000 * 2 ** retry++));
}
function stopLive() {
  liveWanted = false;
  clearTimeout(retryTimer);
  if (ws) { const s = ws; ws = null; try { s.close(); } catch { /* ignore */ } }
  setConn('connecting');
}

function onLive(m) {
  switch (m.t) {
    case 'hello':
      retry = 0;
      setConn('live');
      setWatchers(m.watchers);
      if (Array.isArray(m.queue)) setQueue(m.queue.length);
      if (m.mod) applyMod(m.mod);
      applyFeedList(m.feed, Infinity);
      break;
    case 'watchers': setWatchers(m.n); break;
    case 'mod': applyMod(m); break;
    case 'queued':
      if (!items.has(String(m.id))) bumpQueue(1);
      upsert({ id: m.id, kind: 'say', by: m.by, src: m.src, text: m.text, ts: m.ts, ahead: m.ahead });
      renderFeed();
      break;
    case 'tugqueued':
      if (!items.has(String(m.id))) bumpQueue(1);
      upsert({ id: m.id, kind: 'tug', by: m.by, src: m.src, a: m.a, b: m.b, ts: m.ts, ahead: m.ahead });
      renderFeed();
      break;
    case 'start': {
      bumpQueue(-1);
      const it = items.get(String(m.id));
      if (it && isNum(m.step)) { it.step = m.step; updateRow(it); }
      break;
    }
    case 'poke':
      upsert({ id: m.id, kind: 'poke', by: m.by, src: m.src, cells: m.cells, step: m.step, ts: m.ts });
      renderFeed();
      break;
    case 'done': {
      const it = items.get(String(m.id));
      if (it && m.summary != null) { it.summary = m.summary; updateRow(it); }
      break;
    }
    case 'hide': {
      const id = String(m.id);
      const it = items.get(id);
      if (it) { if (!it.gone || it.gone === 'aged') setGone(it, 'hidden'); renderFeed(); }
      else { hiddenIds.add(id); if (hiddenIds.size > 500) hiddenIds.delete(hiddenIds.values().next().value); }
      break;
    }
    case 'feed': applyFeedList(m.feed, Infinity); break;
    default: break;   // board, record, error, ...: not needed here
  }
}

/* ---------- once a second ---------- */
function tick() {
  if (!unlocked) return;
  renderUptime();
  renderSync();
  renderAnnounce();
  for (const row of banRows.values()) setText(row.left, banLeft(row.until));
  const t = now();
  for (const it of items.values()) if (it.r && it.el.isConnected) setText(it.r.ago, fmtAgo(t - (it.ts ?? it.k)));
  if (pendingCount && !isHeld()) renderFeed();
  if (ws && ws.readyState === 1 && Date.now() - lastLiveAt > LIVE_SILENCE_MS) ws.close();   // phone slept; reconnect
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !unlocked) return;
  schedulePoll(0);
  if (!ws) { retry = 0; connectLive(); }
});

/* ---------- reset on lock ---------- */
function resetData() {
  for (const it of items.values()) if (it.el) it.el.remove();
  items.clear(); hiddenIds.clear(); keyByHandle.clear(); counts.clear();
  banRows.clear(); $('bans').replaceChildren(); banList = [];
  phraseRows.clear(); $('extra').replaceChildren(); blExtra = []; blBase = null;
  Object.assign(mod, { chatPaused: false, pokesPaused: false, slowSec: 0, announce: null });
  for (const k of Object.keys(busy)) busy[k] = false;
  queueN = null; uptime = null; lastSync = 0; syncErr = '';
  showLimit = PAGE; frozen = false; hideGone = false; holdUntil = 0; pendingCount = 0;
  $('freeze').setAttribute('aria-pressed', 'false');
  $('hideGone').setAttribute('aria-pressed', 'false');
  for (const id of ['watchers', 'queue', 'sMsg', 'sPoke', 'sRej', 'sUp']) setText($(id), '–');
  $('twitch').hidden = true;
  setText($('banCount'), ''); setText($('jumpMuted'), ''); $('bansEmpty').hidden = false;
  setText($('blCount'), ''); setText($('blBase'), 'Messages containing any of these phrases are rejected.');
  $('annText').value = ''; annCounter(); $('annErr').textContent = '';
  $('toasts').replaceChildren(); $('alerts').replaceChildren();
  renderMod();
  renderFeedNow();
}

/* ---------- boot ---------- */
new ResizeObserver(() => {
  const hgt = Math.round($('bar').getBoundingClientRect().height);
  if (hgt) document.documentElement.style.setProperty('--barh', hgt + 'px');
}).observe($('bar'));

token = readToken();
if (token) start(null);   // the first poll checks the saved token; a 404 brings the lock screen back
else showLock('');

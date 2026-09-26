// One live worm for everyone.
// The server owns the only simulation. It streams activity to every viewer at 15 frames/s,
// takes messages and pokes from anyone, and writes every stimulus to an event log that
// `npm run replay` can re-run to check the published summaries.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { WormCore } from '../shared/worm.js';
import { PARAMS, STEPS_PER_SECOND } from '../shared/sim.js';
import { config as defaultConfig } from './config.js';
import { checkMessage, loadBlocklist, RateLimiter } from './moderation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEP_MS = 1000 / STEPS_PER_SECOND;
const FRAME_EVERY = 2;          // steps per streamed frame (15 fps)
const REST_FRAME_EVERY = 30;    // when nothing is firing, one frame per second keeps clocks in sync
const FRAME_TYPE = 1;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const STATIC_ROOTS = { '/shared/': path.join(ROOT, 'shared'), '/data/': path.join(ROOT, 'data'), '/': path.join(ROOT, 'public') };

export function createWormServer(overrides = {}) {
  const config = { ...defaultConfig, ...overrides, limits: { ...defaultConfig.limits, ...(overrides.limits || {}) }, site: { ...defaultConfig.site, ...(overrides.site || {}) } };
  const wiringRaw = fs.readFileSync(path.join(ROOT, 'data', 'wiring.json'));
  const wiringHash = crypto.createHash('sha256').update(wiringRaw).digest('hex');
  const D = JSON.parse(wiringRaw);
  let blocklist = loadBlocklist(path.resolve(ROOT, config.blocklistFile));

  /* ---------- event log ---------- */
  let log = null, logPath = null;
  if (config.logDir) {
    const dir = path.resolve(ROOT, config.logDir);
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, `events-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    log = fs.createWriteStream(logPath, { flags: 'a' });
    log.write(JSON.stringify({ k: 'boot', v: 1, ts: Date.now(), params: PARAMS, wiringSha256: wiringHash }) + '\n');
  }
  const writeLog = (o) => { if (log) log.write(JSON.stringify(o) + '\n'); };

  /* ---------- the worm ---------- */
  const feed = [];
  const findItem = (id) => feed.find((f) => f.id === id);
  const clients = new Set();

  const worm = new WormCore(D, {
    onEvent(ev) {
      if (ev.type === 'start') {
        const it = findItem(ev.id); if (it) it.step = ev.step;
        writeLog({ k: 'say', step: ev.step, id: ev.id, by: ev.meta.by, text: ev.text });
        broadcast({ t: 'start', id: ev.id, step: ev.step, by: ev.meta.by, text: ev.text });
      } else if (ev.type === 'poke') {
        const item = { id: ev.id, kind: 'poke', by: ev.meta.by, cells: ev.cells, step: ev.step, ts: Date.now() };
        pushFeed(item);
        writeLog({ k: 'poke', step: ev.step, id: ev.id, by: ev.meta.by, cells: ev.cells });
        broadcast({ t: 'poke', ...item });
      } else if (ev.type === 'done') {
        const it = findItem(ev.id); if (it) it.summary = ev.summary;
        writeLog({ k: 'done', step: ev.step, id: ev.id, summary: ev.summary });
        broadcast({ t: 'done', id: ev.id, summary: ev.summary });
      }
    },
  });

  function pushFeed(item) {
    feed.push(item);
    while (feed.length > config.limits.feedSize) feed.shift();
  }

  /* ---------- streaming ---------- */
  const frame = Buffer.alloc(5 + worm.N);
  let lastWasRest = false;
  function sendFrame() {
    frame[0] = FRAME_TYPE;
    frame.writeUInt32LE(worm.step >>> 0, 1);
    worm.quantize(frame.subarray(5));
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512 * 1024) ws.send(frame, { binary: true });
    }
  }
  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }

  let nextStepAt = 0, timer = null, sweepTimer = null;
  function loop() {
    const now = performance.now();
    let n = 0;
    while (now >= nextStepAt && n < 5) {
      worm.tick();
      nextStepAt += STEP_MS; n++;
      const resting = worm.last.nAct === 0 && !worm.current;
      if (clients.size && (resting ? (!lastWasRest || worm.step % REST_FRAME_EVERY === 0) : worm.step % FRAME_EVERY === 0)) {
        sendFrame();
        lastWasRest = resting;
      }
    }
    if (now - nextStepAt > 1000) nextStepAt = now; // after a stall, don't try to catch up
  }

  /* ---------- live connections ---------- */
  const msgLimiter = new RateLimiter({ ratePerSec: config.limits.messagesPerMinutePerIp / 60, burst: 2 });
  const pokeLimiter = new RateLimiter({ ratePerSec: config.limits.pokesPerSecondPerIp, burst: 3 });
  const connsPerIp = new Map();
  let msgCounter = 0;
  const newId = (p) => p + (++msgCounter).toString(36) + crypto.randomBytes(2).toString('hex');

  function clientIp(req) {
    if (config.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  const httpServer = http.createServer(handleHttp);
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/live',
    maxPayload: 2048,
    perMessageDeflate: { threshold: 256, serverNoContextTakeover: true, clientNoContextTakeover: true },
    verifyClient: ({ origin }) => !config.allowedOrigins.length || config.allowedOrigins.includes(origin),
  });

  let watchersTimer = null;
  const announceWatchers = () => {
    if (watchersTimer) return;
    watchersTimer = setTimeout(() => { watchersTimer = null; broadcast({ t: 'watchers', n: clients.size }); }, 400);
  };

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const count = (connsPerIp.get(ip) || 0) + 1;
    if (count > config.limits.maxConnectionsPerIp) { ws.close(1013, 'Too many connections from this address'); return; }
    connsPerIp.set(ip, count);
    ws.handle = 'anon-' + crypto.randomBytes(2).toString('hex');
    clients.add(ws);
    const st = worm.status();
    ws.send(JSON.stringify({
      t: 'hello', you: ws.handle, step: worm.step, watchers: clients.size, feed,
      current: st.current && { id: st.current.id, text: st.current.text, startStep: st.current.startStep, by: st.current.meta.by },
      queue: st.queue.map((m) => ({ id: m.id, text: m.text, by: m.meta.by })),
    }));
    sendFrameTo(ws);
    announceWatchers();

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'say') {
        if (!msgLimiter.take(ip)) return reply(ws, { t: 'error', code: 'slow', message: 'Slow down: one message every few seconds.' });
        if (worm.queue.length >= config.limits.maxQueue) return reply(ws, { t: 'error', code: 'busy', message: 'The worm has a queue. Try again in a few seconds.' });
        const c = checkMessage(msg.text, blocklist);
        if (!c.ok) return reply(ws, { t: 'error', code: c.code, message: c.message });
        const id = newId('m');
        const ahead = worm.say(id, c.text, { by: ws.handle });
        pushFeed({ id, kind: 'say', by: ws.handle, text: c.text, step: null, ts: Date.now() });
        broadcast({ t: 'queued', id, by: ws.handle, text: c.text, ahead });
      } else if (msg.t === 'poke') {
        if (!pokeLimiter.take(ip)) return;
        worm.poke(newId('p'), Array.isArray(msg.cells) ? msg.cells.slice(0, 12) : [], { by: ws.handle });
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
      const c = (connsPerIp.get(ip) || 1) - 1;
      if (c <= 0) connsPerIp.delete(ip); else connsPerIp.set(ip, c);
      announceWatchers();
    });
    ws.on('error', () => {});
  });

  function sendFrameTo(ws) {
    const f = Buffer.alloc(5 + worm.N);
    f[0] = FRAME_TYPE; f.writeUInt32LE(worm.step >>> 0, 1); worm.quantize(f.subarray(5));
    ws.send(f, { binary: true });
  }
  const reply = (ws, o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

  /* ---------- http ---------- */
  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self' ws: wss:", "frame-ancestors 'none'", "base-uri 'none'",
    ].join('; '));
  }
  const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };

  function isAdmin(req) {
    if (!config.adminToken) return false;
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from('Bearer ' + config.adminToken);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  function handleHttp(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);

    if (p.startsWith('/admin/')) {
      if (req.method !== 'POST' || !isAdmin(req)) return json(res, 404, { error: 'not found' });
      if (p === '/admin/clear') { feed.length = 0; broadcast({ t: 'feed', feed }); return json(res, 200, { ok: true }); }
      if (p === '/admin/hide') {
        const id = url.searchParams.get('id'); const i = feed.findIndex((f) => f.id === id);
        if (i >= 0) feed.splice(i, 1);
        broadcast({ t: 'hide', id }); return json(res, 200, { ok: i >= 0 });
      }
      if (p === '/admin/reload-blocklist') { blocklist = loadBlocklist(path.resolve(ROOT, config.blocklistFile)); return json(res, 200, { ok: true, entries: blocklist.length }); }
      return json(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (p === '/healthz') return json(res, 200, { ok: true, step: worm.step, watchers: clients.size });
    if (p === '/config.json') return json(res, 200, { site: config.site, params: PARAMS, wiringSha256: wiringHash, stepsPerSecond: STEPS_PER_SECOND });
    if (p === '/log/current.jsonl') {
      if (!logPath) return json(res, 404, { error: 'logging is off' });
      res.writeHead(200, { 'Content-Type': MIME['.jsonl'], 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="events.jsonl"' });
      return fs.createReadStream(logPath).pipe(res);
    }

    const prefix = Object.keys(STATIC_ROOTS).find((k) => p.startsWith(k));
    const base = STATIC_ROOTS[prefix];
    let rel = p.slice(prefix.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep)) { res.writeHead(404); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': MIME['.txt'] }); return res.end('Not found'); }
      const ext = path.extname(file);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  return {
    worm, config, get logPath() { return logPath; },
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => {
        nextStepAt = performance.now();
        timer = setInterval(loop, 5);
        sweepTimer = setInterval(() => { msgLimiter.sweep(); pokeLimiter.sweep(); }, 60_000);
        httpServer.listen(port, host, () => resolve(httpServer.address()));
      });
    },
    async close() {
      clearInterval(timer); clearInterval(sweepTimer); clearTimeout(watchersTimer);
      for (const ws of clients) ws.terminate();
      await new Promise((r) => wss.close(() => r()));
      await new Promise((r) => httpServer.close(() => r()));
      if (log) await new Promise((r) => log.end(r));
    },
  };
}

// Run directly: `node server/server.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createWormServer();
  const addr = await app.listen();
  console.log(`Talk to the Worm: http://localhost:${addr.port}  (event log: ${app.logPath || 'off'})`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

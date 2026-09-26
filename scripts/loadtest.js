#!/usr/bin/env node
// Load test: open many viewers against a running server and measure whether the worm keeps real
// time and what each viewer costs in bandwidth.
//
//   MAX_CONN_PER_IP=100000 npm start            (in one terminal)
//   node scripts/loadtest.js http://localhost:3000 2000 60
//
// Arguments: base URL, number of viewers, seconds. Some viewers also send messages and pokes.
import WebSocket from 'ws';

const base = process.argv[2] || 'http://localhost:3000';
const viewers = Number(process.argv[3] || 1000);
const seconds = Number(process.argv[4] || 45);
const wsUrl = base.replace(/^http/, 'ws') + '/live';

let bytes = 0, frames = 0, jsons = 0, open = 0, failed = 0;
const socks = [];
for (let i = 0; i < viewers; i++) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  ws.on('open', () => { open++; });
  ws.on('message', (d, bin) => { bytes += d.length; if (bin) frames++; else jsons++; });
  ws.on('error', () => { failed++; });
  socks.push(ws);
  if (i % 200 === 199) await new Promise((r) => setTimeout(r, 100));
}
const t0 = Date.now();
const h0 = await (await fetch(base + '/healthz')).json();
const talkers = socks.slice(0, 50);
const touch = [1814, 1867, 2499, 1837, 2448, 681, 490, 499];
const talk = setInterval(() => {
  const ws = talkers[Math.floor(Math.random() * talkers.length)];
  if (ws.readyState === 1) ws.send(JSON.stringify(Math.random() < 0.3 ? { t: 'say', text: 'gm ' + Math.floor(Math.random() * 1000) } : { t: 'poke', cells: [touch[Math.floor(Math.random() * touch.length)]] }));
}, 150);

const lags = [];
const probe = setInterval(async () => {
  const a = Date.now();
  try { await fetch(base + '/healthz'); lags.push(Date.now() - a); } catch { /* ignore */ }
}, 1000);

await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(talk); clearInterval(probe);
const h1 = await (await fetch(base + '/healthz')).json();
const dt = (Date.now() - t0) / 1000;
const sps = (h1.step - h0.step) / dt;
const perViewer = bytes / Math.max(1, open) / dt;
lags.sort((a, b) => a - b);
console.log(JSON.stringify({
  viewers, open, failed, seconds: Math.round(dt),
  stepsPerSecond: Math.round(sps * 10) / 10,
  perViewerKBps: Math.round(perViewer / 102.4) / 10,
  totalMBps: Math.round(bytes / dt / 1e5) / 10,
  framesPerViewerPerSec: Math.round(frames / Math.max(1, open) / dt * 10) / 10,
  jsonPerViewerPerSec: Math.round(jsons / Math.max(1, open) / dt * 10) / 10,
  httpLatencyMs: { p50: lags[Math.floor(lags.length * 0.5)], p95: lags[Math.floor(lags.length * 0.95)], max: lags.at(-1) },
}, null, 1));
for (const ws of socks) ws.terminate();
process.exit(0);

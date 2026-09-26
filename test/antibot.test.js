import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createWormServer } from '../server/server.js';
import { solvePow, sha256Words } from '../public/sha256.js';

const client = (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
  const msgs = [];
  ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(String(d))); });
  const until = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timeout'); };
  return { ws, msgs, until, open: new Promise((r, j) => { ws.once('open', r); ws.once('error', j); ws.once('unexpected-response', (_q, res) => j(new Error('HTTP ' + res.statusCode))); }), closed: new Promise((r) => ws.once('close', (c) => r(c))) };
};

test('the browser SHA-256 matches node:crypto', () => {
  const enc = new TextEncoder();
  for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(200)]) {
    const mine = sha256Words(enc.encode(s)).map((w) => w.toString(16).padStart(8, '0')).join('');
    assert.equal(mine, crypto.createHash('sha256').update(s).digest('hex'));
  }
});

test('nothing is accepted before the proof-of-work, and a solved puzzle opens the door', async () => {
  const app = createWormServer({ logDir: '', ots: false, lab: false, pow: { bits: 10 }, limits: { messagesPerMinute: 600 } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const a = client(port); await a.open;
    const hello = await a.until((m) => m.t === 'hello');
    assert.equal(hello.pow.bits, 10);
    a.ws.send(JSON.stringify({ t: 'say', text: 'gm' }));
    assert.equal((await a.until((m) => m.t === 'error')).code, 'pow');
    a.ws.send(JSON.stringify({ t: 'pow', nonce: 12345 }));           // a wrong answer is ignored
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!a.msgs.some((m) => m.t === 'pow-ok'));
    a.ws.send(JSON.stringify({ t: 'pow', nonce: solvePow(hello.pow.challenge, hello.pow.bits) }));
    await a.until((m) => m.t === 'pow-ok');
    a.ws.send(JSON.stringify({ t: 'say', text: 'gm' }));
    await a.until((m) => m.t === 'queued' && m.text === 'gm');
    a.ws.terminate();
  } finally { await app.close(); }
});

test('one address cannot open connections faster than the limit', async () => {
  const app = createWormServer({ logDir: '', ots: false, lab: false, pow: { bits: 0 }, limits: { connectionsPerMinutePerIp: 6, maxConnectionsPerIp: 100 } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const results = [];
    for (let i = 0; i < 12; i++) {
      const c = client(port);
      try { await c.open; const r = await Promise.race([c.until((m) => m.t === 'hello', 800).then(() => 'ok'), c.closed.then(() => 'closed')]); results.push(r); }
      catch { results.push('closed'); }
      c.ws.terminate();
    }
    assert.ok(results.filter((r) => r === 'ok').length <= 6, results.join(','));
    assert.ok(results.includes('closed'));
  } finally { await app.close(); }
});

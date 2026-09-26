import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createWormServer } from '../server/server.js';
import { replayLog } from '../scripts/replay.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
  const msgs = [], frames = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) frames.push({ step: data.readUInt32LE(1), bytes: data.subarray(5) });
    else msgs.push(JSON.parse(String(data)));
  });
  const until = async (pred, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error('timed out waiting for message');
  };
  return { ws, msgs, frames, until, open: new Promise((r) => ws.once('open', r)) };
}

test('two viewers share one worm, and the log replays exactly', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worm-'));
  const app = createWormServer({ logDir, limits: { messagesPerMinutePerIp: 600 } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const a = client(port), b = client(port);
    await Promise.all([a.open, b.open]);
    const helloA = await a.until((m) => m.t === 'hello');
    const helloB = await b.until((m) => m.t === 'hello');
    assert.notEqual(helloA.you, helloB.you);

    a.ws.send(JSON.stringify({ t: 'say', text: 'gm' }));
    const q = await b.until((m) => m.t === 'queued' && m.text === 'gm');
    assert.equal(q.by, helloA.you);
    await b.until((m) => m.t === 'start' && m.id === q.id);

    // B sees activity caused by A's message
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !b.frames.some((f) => f.bytes.some((v) => v > 20))) await new Promise((r) => setTimeout(r, 50));
    assert.ok(b.frames.some((f) => f.bytes.some((v) => v > 20)), 'viewer B saw activity');

    // B pokes; A sees it
    const touch = app.worm.roles.touch.slice(0, 6);
    b.ws.send(JSON.stringify({ t: 'poke', cells: touch }));
    const p = await a.until((m) => m.t === 'poke');
    assert.equal(p.by, helloB.you);
    assert.deepEqual(p.cells, touch);

    // scams are refused, to the sender only
    a.ws.send(JSON.stringify({ t: 'say', text: 'new ca 0x4eb990547bce4a982432ca88cf5fae7eed1a2d35' }));
    const err = await a.until((m) => m.t === 'error');
    assert.equal(err.code, 'address');

    await a.until((m) => m.t === 'done' && m.id === p.id, 10000);

    // http surface
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Talk to the/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/shared/worm.js`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/clear`, { method: 'POST' })).status, 404);
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(health.ok, true);
    const logText = await (await fetch(`http://127.0.0.1:${port}/log/current.jsonl`)).text();
    assert.match(logText, /"k":"boot"/);

    a.ws.close(); b.ws.close();
  } finally {
    await app.close();
  }

  // replay the log from disk: every summary must be reproduced exactly
  const file = fs.readdirSync(logDir).map((f) => path.join(logDir, f))[0];
  const wiring = fs.readFileSync(new URL('../data/wiring.json', import.meta.url));
  const { segments } = replayLog(fs.readFileSync(file, 'utf8'), wiring);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].warnings, []);
  assert.ok(segments[0].checked >= 2);
  assert.equal(segments[0].matched, segments[0].checked, segments[0].mismatches.join('\n'));
});

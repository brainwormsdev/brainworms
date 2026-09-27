import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WormCore } from '../shared/worm.js';
import { LAMP, lampLight, placeLamp, lampDir } from '../shared/lamp.js';
import { BODY, UM_PER_UNIT } from '../shared/body.js';
import { encodeSnapshot, decodeSnapshot } from '../shared/state.js';
import { stateString, LOG_VERSION } from '../shared/replay.js';
import { PARAMS } from '../shared/sim.js';
import { replayLog } from '../scripts/replay.js';
import { loadD, wiringRaw, txRaw } from './data.js';

const D = loadD();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HEAD_UP = { p: [0, 0, 0], q: [1, 0, 0, 0] };

test('each side\'s eyes see the lamp on their own side, brighter when closer', () => {
  const right = lampLight(HEAD_UP, [5, 0, 0]), left = lampLight(HEAD_UP, [-5, 0, 0]), ahead = lampLight(HEAD_UP, [0, 5, 0]);
  assert.ok(right.R > 0 && right.L === 0, 'a lamp on the right lights only the right eyes');
  assert.ok(left.L > 0 && left.R === 0, 'a lamp on the left lights only the left eyes');
  assert.ok(ahead.L > 0 && Math.abs(ahead.L - ahead.R) < 1e-12, 'a lamp straight ahead lights both sides equally');
  assert.equal(right.R, left.L, 'the two sides mirror each other');
  const far = lampLight(HEAD_UP, [0, 20, 0]);
  assert.ok(far.L < ahead.L, 'farther is dimmer');
  // along an eye's own axis, at the falloff distance, it is half as bright as up close
  const e = LAMP.eye, l = Math.hypot(...e), axis = e.map((v) => (v / l) * LAMP.falloff);
  assert.ok(Math.abs(lampLight(HEAD_UP, axis).R - 0.5) < 1e-12);
  assert.equal(lampLight(HEAD_UP, [0, -5, 0]).L, 0, 'nothing is seen from straight behind');
});

test('lamps are placed inside the tank, and bad directions are refused', () => {
  const at = placeLamp([0, 0, 0], [0, 1, 0], BODY.tank);
  assert.deepEqual(at, [0, LAMP.distance, 0]);
  const pulled = placeLamp([0, 18, 0], [0, 1, 0], BODY.tank);
  assert.ok(Math.abs(Math.hypot(...pulled) - BODY.tank * LAMP.inside) < 1e-9);
  assert.equal(lampDir([0, 0, 0]), null);
  assert.equal(lampDir([1, 'x', 0]), null);
  assert.equal(lampDir([NaN, 1, 0]), null);
  assert.deepEqual(lampDir([0, 3, 4]), [0, 0.6, 0.8]);
  assert.equal(new WormCore(D).lamp('x', [0, 0, 0]), -1);
});

test('a lamp plays like a message and reports how near the worm came', () => {
  const w = new WormCore(D);
  const ev = []; w.onEvent = (e) => ev.push(e);
  assert.equal(w.lamp('L1', [0, 1, 0], { by: 'a' }), 0);
  for (let t = 0; t < LAMP.steps + 400; t++) w.tick();
  const start = ev.find((e) => e.type === 'start' && e.id === 'L1');
  assert.equal(start.kind, 'lamp');
  assert.deepEqual(start.pos, [0, LAMP.distance, 0]);
  const done = ev.find((e) => e.type === 'done' && e.id === 'L1').summary;
  assert.ok(done.lamp, 'the summary has the distances');
  assert.ok(Math.abs(done.lamp.from - LAMP.distance * UM_PER_UNIT) < 250, `started ${done.lamp.from} µm away`);
  for (const k of ['from', 'to', 'closest', 'mean']) assert.ok(Number.isInteger(done.lamp[k]) && done.lamp[k] >= 0);
  assert.ok(done.lamp.closest <= done.lamp.from && done.lamp.closest <= done.lamp.to);
  assert.equal(w.current, null, 'the lamp goes out after its 30 s');
});

test('a snapshot taken while a lamp is lit continues bit-for-bit', () => {
  const a = new WormCore(D);
  a.lamp('L1', [1, 0.2, -0.3]);
  a.say('m1', 'gm');
  for (let t = 0; t < 300; t++) a.tick();
  assert.equal(a.current.kind, 'lamp');
  const b = new WormCore(D).restore(decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(a.snapshot())))));
  assert.equal(stateString(b), stateString(a));
  const evA = [], evB = []; a.onEvent = (e) => evA.push(e); b.onEvent = (e) => evB.push(e);
  for (let t = 0; t < 1400; t++) { a.tick(); b.tick(); }
  assert.equal(stateString(b), stateString(a));
  assert.deepEqual(evB, evA);
  assert.ok(evA.some((e) => e.type === 'done' && e.id === 'L1' && e.summary.lamp));
});

test('a logged lamp replays exactly', async () => {
  const lines = [{ k: 'boot', v: LOG_VERSION, run: 't', chunk: 0, ts: 0, step: 0, params: PARAMS, wiringSha256: sha256(wiringRaw), transmittersSha256: sha256(txRaw) }];
  const w = new WormCore(D, {
    onEvent: (e) => {
      if (e.type === 'start' && e.kind === 'lamp') lines.push({ k: 'lamp', step: e.step, id: e.id, by: e.meta.by, dir: e.dir, pos: e.pos });
      if (e.type === 'start' && e.kind === 'say') lines.push({ k: 'say', step: e.step, id: e.id, by: e.meta.by, text: e.text });
      if (e.type === 'done') lines.push({ k: 'done', step: e.step, id: e.id, summary: e.summary });
    },
  });
  for (let t = 0; t < 45; t++) w.tick();
  w.lamp('L1', [-0.4, 0.5, 0.2], { by: 'a' });
  for (let t = 0; t < 400; t++) w.tick();
  w.poke('p1', w.roles.touch.slice(0, 3), { by: 'b' });
  lines.push({ k: 'poke', step: w.step - 0, id: 'p1', by: 'b', cells: w.roles.touch.slice(0, 3) });
  for (let t = 0; t < 1000; t++) w.tick();
  w.say('m1', 'after', { by: 'c' });
  for (let t = 0; t < 600; t++) w.tick();
  lines.push({ k: 'end', step: w.step, stateSha256: sha256(stateString(w)) });
  const { segments } = await replayLog(lines.map((l) => JSON.stringify(l)).join('\n'), wiringRaw);
  const s = segments[0];
  assert.deepEqual(s.warnings, []);
  assert.ok(s.checked >= 3);
  assert.equal(s.matched, s.checked, s.mismatches.join('\n'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WormCore } from '../shared/worm.js';
import { createBody, BODY, UM_PER_UNIT } from '../shared/body.js';
import { encodeSnapshot, decodeSnapshot } from '../shared/state.js';
import { stateString } from '../shared/replay.js';
import { encodeFrame, decodeFrame, FRAME_SPARSE, POSE_BYTES } from '../shared/frames.js';
import { loadD } from './data.js';

const D = loadD();
const CALM = { bend: 0, st: 0 }, BEATING = { L: 1, R: 1 };

test('at rest it swims all over the tank and never leaves it', () => {
  const b = createBody();
  const shells = [0, 0, 0, 0, 0];
  let maxd = 0, bumps = 0, wasTurning = false;
  for (let i = 0; i < 30 * 600; i++) {
    b.step(BEATING, CALM);
    const d = Math.hypot(...b.state.p);
    maxd = Math.max(maxd, d);
    shells[Math.min(4, Math.floor(d / BODY.tank * 5))]++;
    if (b.state.target && !wasTurning) bumps++;
    wasTurning = !!b.state.target;
  }
  assert.ok(maxd <= BODY.tank + 1e-9, `left the tank: ${maxd}`);
  assert.ok(bumps > 20, `only ${bumps} bumps in 10 minutes`);
  assert.ok(shells[1] + shells[2] > 0.05 * 30 * 600, `hugs the wall: ${shells}`);
  // swims about 0.5 mm/s at rest
  const mmPerS = b.state.dist * UM_PER_UNIT / 1000 / 600;
  assert.ok(mmPerS > 0.4 && mmPerS < 0.55, `rest speed ${mmPerS} mm/s`);
});

test('stopped cilia stop it and let it sink; stopping one side turns it to that side', () => {
  const run = (beat, n = 90) => { const b = createBody(); for (let i = 0; i < n; i++) b.step(beat, CALM); return b.state; };
  const still = run({ L: 0, R: 0 });
  assert.equal(still.beat, 0);
  assert.ok(still.p[1] < -2, 'sinks when every cilium stops');
  assert.ok(Math.abs(still.p[0]) < 1e-9 && Math.abs(still.p[2]) < 1e-9, 'straight down, no swimming');
  const left = run({ L: 0, R: 1 }), right = run({ L: 1, R: 0 });
  assert.ok(left.turn > 0 && right.turn < 0, 'turns toward the arrested side (+ = left)');
  assert.ok(Math.abs(left.turn + right.turn) < 1e-12, 'mirror images turn by the same amount');
});

test('the body is part of the state: snapshot mid-bump, restore, continue bit-for-bit', () => {
  const a = new WormCore(D);
  a.say('m', 'swim');
  let t = 0;
  while (!a.body.state.target && t < 30 * 60) { a.tick(); t++; }
  assert.ok(a.body.state.target, 'reached the wall and started turning');
  const b = new WormCore(D).restore(decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(a.snapshot())))));
  assert.equal(stateString(b), stateString(a));
  for (let i = 0; i < 900; i++) { a.tick(); b.tick(); }
  assert.deepEqual(b.body.snapshot(), a.body.snapshot());
  assert.equal(stateString(b), stateString(a));
});

test('every message reports how far it swam and how much the brain turned it', () => {
  const w = new WormCore(D);
  const ev = []; w.onEvent = (e) => ev.push(e);
  w.say('m', 'gm');
  w.say('s', '████████');
  for (let t = 0; t < 1500; t++) w.tick();
  const m = ev.find((e) => e.type === 'done' && e.id === 'm').summary;
  const s = ev.find((e) => e.type === 'done' && e.id === 's').summary;
  for (const x of [m, s]) {
    assert.ok(Number.isInteger(x.swim) && x.swim > 0);
    assert.ok(Number.isInteger(x.turn));
    assert.ok(x.stop === undefined || x.stop > 0, 'cilia-stopped time is reported only when they stopped');
  }
});

test('frames carry the pose: int16 position and rotation, float32 distance', () => {
  const w = new WormCore(D);
  for (let t = 0; t < 400; t++) w.tick();
  const b = w.body.state, pose = [...b.p, ...b.q, b.dist];
  const f = encodeFrame(w.sim.r, w.step, pose);
  assert.equal(f[0], FRAME_SPARSE + 2);
  assert.equal(f.length, 7 + POSE_BYTES);
  const out = new Uint8Array(w.N), got = new Float64Array(8);
  assert.equal(decodeFrame(f, out, got), w.step);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[k] - pose[k]) <= 0.0005);
  for (let k = 3; k < 7; k++) assert.ok(Math.abs(got[k] - pose[k]) <= 1 / 32767);
  assert.ok(Math.abs(got[7] - pose[7]) / pose[7] < 1e-6);
  // old frames without a pose still decode
  assert.equal(decodeFrame(encodeFrame(w.sim.r, 9), out, got), 9);
});

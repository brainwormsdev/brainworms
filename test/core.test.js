import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WormCore, TUG_ORDER, TUG_SCORED } from '../shared/worm.js';
import { encodeSnapshot, decodeSnapshot } from '../shared/state.js';
import { encodeFrame, decodeFrame, FRAME_DENSE, FRAME_SPARSE } from '../shared/frames.js';

const D = JSON.parse(fs.readFileSync(new URL('../data/wiring.json', import.meta.url)));

function collect(w) { const ev = []; w.onEvent = (e) => ev.push(e); return ev; }

test('a snapshot restored into a fresh worm continues bit-for-bit', () => {
  const a = new WormCore(D);
  const evA = collect(a);
  a.say('m1', 'gm worm');
  a.tug('t1', 'LEFT', 'wagmi');
  for (let t = 0; t < 140; t++) a.tick();
  a.poke('p1', a.roles.touch.slice(3, 9));
  for (let t = 0; t < 20; t++) a.tick();
  // round-trip through JSON, exactly as the event log stores it
  const snap = JSON.parse(JSON.stringify(encodeSnapshot(a.snapshot())));
  const b = new WormCore(D).restore(decodeSnapshot(snap));
  const evB = collect(b);
  const mark = evA.length;
  for (let t = 0; t < 1400; t++) { a.tick(); b.tick(); }
  assert.deepEqual(Array.from(b.sim.r), Array.from(a.sim.r));
  assert.deepEqual(Array.from(b.sim.fatigue), Array.from(a.sim.fatigue));
  assert.deepEqual(evB, evA.slice(mark));
  assert.ok(evB.some((e) => e.type === 'tug' && e.id === 't1'));
});

test('a tug shows each word to both sides and reports which way the body bent', () => {
  const w = new WormCore(D);
  const ev = collect(w);
  w.tug('t', '█████', '.');
  let guard = 0;
  while (!ev.some((e) => e.type === 'done' && e.id === 't') && guard++ < 5000) w.tick();
  const res = ev.find((e) => e.type === 'tug').result;
  const scoredOrder = TUG_ORDER.filter((_, k) => TUG_SCORED[k]);
  assert.equal(res.phases.length, scoredOrder.length);
  assert.ok(['a', 'b', 'tie'].includes(res.winner));
  const done = ev.find((e) => e.type === 'done' && e.id === 't');
  assert.deepEqual(done.summary.tug, res);
  // the score is the counterbalanced mean: passes with A on the left count +, the others -
  const recomputed = res.phases.reduce((s, v, k) => s + scoredOrder[k] * v, 0) / scoredOrder.length;
  assert.ok(Math.abs(recomputed - res.score) < 5e-5);
});

const tugOf = (a, b) => {
  const w = new WormCore(D); const ev = collect(w); w.tug('t', a, b);
  for (let i = 0; i < 9000 && !ev.some((e) => e.type === 'tug'); i++) w.tick();
  return ev.find((e) => e.type === 'tug').result;
};

test('swapping the two words flips the result, and the same word on both sides is about even', () => {
  const ab = tugOf('BONK', 'gm'), ba = tugOf('gm', 'BONK');
  assert.ok(Math.abs(ab.score) > 1e-4, `contest score ${ab.score}`);
  assert.ok(Math.sign(ab.score) === -Math.sign(ba.score));
  assert.ok(Math.abs(ab.score + ba.score) < 0.1 * Math.abs(ab.score), `${ab.score} vs ${ba.score}`);
  for (const w of ['gm', 'PEPE', 'LFG']) {
    const same = tugOf(w, w);
    assert.ok(Math.abs(same.score) < 0.1 * Math.abs(ab.score), `${w}|${w} scored ${same.score}`);
  }
});

test('pokes are ignored while a tug plays, accepted again after', () => {
  const w = new WormCore(D);
  const ev = collect(w);
  w.tug('t', 'a', 'b');
  w.tick();
  assert.equal(w.poke('p', w.roles.touch.slice(0, 3)), null);
  while (!ev.some((e) => e.type === 'tug')) w.tick();
  assert.ok(w.poke('p2', w.roles.touch.slice(0, 3)));
});

test('frames round-trip, sparse at rest and dense when the body lights up', () => {
  const w = new WormCore(D);
  const out = new Uint8Array(w.N);
  const rest = encodeFrame(w.sim.r, 7);
  assert.equal(rest[0], FRAME_SPARSE);
  assert.equal(rest.length, 7);
  assert.equal(decodeFrame(rest, out), 7);
  assert.ok(out.every((v) => v === 0));

  w.say('a', 'gm');
  for (let t = 0; t < 60; t++) w.tick();
  const f = encodeFrame(w.sim.r, w.step);
  assert.equal(decodeFrame(f, out), w.step);
  const q = w.quantize();
  for (let i = 0; i < w.N; i++) assert.equal(out[i], q[i] >= 2 ? q[i] : 0);
  assert.ok(f.length < 5 + w.N);

  w.say('b', '█████');
  let dense = null;
  for (let t = 0; t < 400 && !dense; t++) { w.tick(); const g = encodeFrame(w.sim.r, w.step); if (g[0] === FRAME_DENSE) dense = g; }
  assert.ok(dense, 'a full startle switches to the dense layout');
  assert.equal(dense.length, 5 + w.N);
});

test('a poke during a message is counted, not allowed to cut its summary short', () => {
  const clean = new WormCore(D); const evA = collect(clean);
  clean.say('m', 'gm worm');
  for (let t = 0; t < 1200; t++) clean.tick();
  const a = evA.find((e) => e.type === 'done' && e.id === 'm').summary;

  const poked = new WormCore(D); const evB = collect(poked);
  poked.say('m', 'gm worm');
  for (let t = 0; t < 1200; t++) { if (t === 40) poked.poke('p', poked.roles.touch.slice(0, 4)); poked.tick(); }
  const b = evB.find((e) => e.type === 'done' && e.id === 'm').summary;
  assert.equal(a.pokes, undefined);
  assert.equal(b.pokes, 1);
  assert.ok(b.steps >= a.steps * 0.9, `message summary ran ${b.steps} steps (clean: ${a.steps})`);
  assert.ok(evB.some((e) => e.type === 'done' && e.id === 'p'), 'the poke still gets its own summary');
});

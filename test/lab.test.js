import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WormCore } from '../shared/worm.js';
import { makeSim as makeSimFor } from '../shared/sim.js';
import {
  PROTOCOLS, canonicalJson, protocolJson, scrambleWiring, runLab, runExperiment, pokeTrain, labCells,
  drawCells, deriveSeed, mulberry32, quantile, describe, percentileOf, upperP, startlePeak,
} from '../shared/lab.js';
import { startLab, resultsSha256 } from '../server/lab.js';

const D = JSON.parse(fs.readFileSync(new URL('../data/wiring.json', import.meta.url)));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const M = D.e.length / 3;

// Every protocol exactly as registered before its first run. Editing a registered protocol would
// break the lab's pre-registration: add a new, separately versioned protocol instead, and pin it here.
const REGISTERED = [
  ['eyes-sides', 'fff039b419df072581aa6e15c691d0272fb637b391fc1ffdcc8bae1a18f694cf'],
  ['touch-startle', '574083072e051795c71eaeb614bd74f7b17cdcbffa6f6710b5ccaf5ea9d202f7'],
  ['light-latency', '587f57c327d8826b90140b531541f493de3e3ef114062142cedf5d699423fed5'],
  ['alphabet', 'fdbca930cd88209cb31aaca5d515c721acdffd08b6f9ed4c659cba6764c57fea'],
  ['fatigue', '98fc71bb57a366edaf388c0a0725853256e492e33e9e1d72f1caf7788f12c593'],
  // registered after the v1 results were known (see its `why`)
  ['touch-startle-v2', '8fb53810d2dde841abde3f4fdd105f9b63ec8da509190711f19ba815210bbed5'],
  // registered with the lamp, before any lamp was lit (2026-09-26T23:02:45Z)
  ['follow-the-light', '1e9494bc67a7aeafc80fef41a65a81b56d7b06f874e3a530bb6645978dd02634'],
];
// SHA-256 of the canonical JSON of the five v1 protocols, recorded before any experiment ran
const V1_SET = '8d3b25c2cc60e5346e0a0f58f151b3fa02952294520b4195bd7365e95fd6f1af';

function degrees(W) {
  const N = W.n.length, inD = new Int32Array(N), outD = new Int32Array(N), outSyn = new Int32Array(N);
  let syn = 0;
  for (let k = 0; k < W.e.length; k += 3) { outD[W.e[k]]++; inD[W.e[k + 1]]++; outSyn[W.e[k]] += W.e[k + 2]; syn += W.e[k + 2]; }
  return { inD, outD, outSyn, syn };
}

test('registered protocols are append-only and unchanged', () => {
  assert.ok(PROTOCOLS.length >= REGISTERED.length);
  REGISTERED.forEach(([id, hash], k) => {
    assert.equal(PROTOCOLS[k].id, id);
    assert.equal(sha(canonicalJson(PROTOCOLS[k])), hash, `protocol ${id} was edited after registration`);
  });
  assert.equal(sha(protocolJson(PROTOCOLS.slice(0, 5))), V1_SET);
});

test('protocol JSON is canonical, stable and frozen', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }, null] }), '{"a":[{"c":"x","d":2},null],"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: undefined }), TypeError);
  assert.throws(() => canonicalJson({ a: NaN }), TypeError);
  assert.equal(protocolJson(), canonicalJson(PROTOCOLS));
  assert.equal(protocolJson(), protocolJson());
  assert.equal(canonicalJson(JSON.parse(protocolJson())), protocolJson());
  assert.throws(() => { PROTOCOLS[0].rule = 'changed'; }, TypeError);
  assert.throws(() => { PROTOCOLS[0].params.drive = 2; }, TypeError);
  assert.throws(() => { PROTOCOLS.push({}); }, TypeError);
  const ids = new Set();
  for (const p of PROTOCOLS) {
    for (const k of ['id', 'title', 'question', 'stimulus', 'measure', 'control', 'rule']) assert.equal(typeof p[k], 'string', `${p.id}.${k}`);
    assert.ok(Array.isArray(p.chosen) && p.chosen.length > 0, `${p.id} lists its chosen parameters`);
    for (const c of p.chosen) assert.ok(c.name && c.value !== undefined && c.why, `${p.id}: chosen entries need name, value and why`);
    assert.ok(Number.isInteger(p.seed) && p.seed >= 0 && p.seed < 2 ** 32);
    assert.equal(typeof p.params, 'object');
    assert.ok(!ids.has(p.id)); ids.add(p.id);
    assert.doesNotMatch(`${p.title} ${p.question}`, /\b(reads?|understands?|chooses?|predicts?|decides?|thinks?|wants?)\b/i, `${p.id}: no claims of reading, choosing or predicting`);
  }
});

test('a scramble is deterministic for its seed and leaves the input alone', () => {
  const before = sha(JSON.stringify(D.e));
  const a = scrambleWiring(D, 42), b = scrambleWiring(D, 42), c = scrambleWiring(D, 43);
  assert.deepEqual(a.e, b.e);
  assert.notDeepEqual(a.e, c.e);
  assert.equal(a.n, D.n);
  assert.equal(sha(JSON.stringify(D.e)), before);
  assert.deepEqual(a.scramble, b.scramble);
  assert.equal(a.scramble.swaps, 10 * M);
  // it really shuffles: most connections end up somewhere new
  const orig = new Set(); for (let k = 0; k < D.e.length; k += 3) orig.add(D.e[k] * 1e4 + D.e[k + 1]);
  let kept = 0; for (let k = 0; k < a.e.length; k += 3) if (orig.has(a.e[k] * 1e4 + a.e[k + 1])) kept++;
  assert.ok(kept < 0.2 * M, `${kept} of ${M} connections unchanged`);
});

test('a scramble keeps every cell\'s in-degree, out-degree, outgoing synapses and the total', () => {
  const r = degrees(D);
  for (const seed of [1, 20260926]) {
    const s = degrees(scrambleWiring(D, seed));
    assert.deepEqual(s.inD, r.inD);
    assert.deepEqual(s.outD, r.outD);
    assert.deepEqual(s.outSyn, r.outSyn);
    assert.equal(s.syn, r.syn);
    assert.equal(s.syn, 26881);
  }
});

test('a scramble has no self-connections and no duplicate connections', () => {
  const W = scrambleWiring(D, 7), seen = new Set();
  assert.equal(W.e.length, D.e.length);
  for (let k = 0; k < W.e.length; k += 3) {
    assert.notEqual(W.e[k], W.e[k + 1], 'self-connection');
    const key = W.e[k] * 1e4 + W.e[k + 1];
    assert.ok(!seen.has(key), 'duplicate connection'); seen.add(key);
    assert.ok(W.e[k + 2] > 0);
  }
});

test('seeded helpers are deterministic', () => {
  const g = mulberry32(1), h = mulberry32(1);
  const xs = [g(), g(), g()];
  assert.deepEqual(xs, [h(), h(), h()]);
  assert.ok(xs.every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 32));
  assert.notEqual(deriveSeed(5, 'scramble', 0), deriveSeed(5, 'scramble', 1));
  assert.notEqual(deriveSeed(5, 'scramble', 0), deriveSeed(5, 'other-sensory', 0));
  const pool = Array.from({ length: 100 }, (_, i) => i * 3);
  const d = drawCells(pool, 10, 99);
  assert.deepEqual(d, drawCells(pool, 10, 99));
  assert.equal(new Set(d).size, 10);
  assert.deepEqual(d, [...d].sort((x, y) => x - y));
  assert.ok(d.every((x) => pool.includes(x)));
});

test('statistics: p95 by linear interpolation, percentiles with ties, Monte Carlo p', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Math.abs(quantile([1, 2, 3, 4], 0.95) - 3.85) < 1e-12);
  const c = describe([3, 1, 2, null]);
  assert.equal(c.n, 4); assert.equal(c.mean, 2); assert.equal(c.sd, 1); assert.equal(c.min, 1); assert.equal(c.max, 3);
  assert.deepEqual(c.values, [3, 1, 2, null]);
  assert.equal(percentileOf([1, 2, 2, 3], 2), 50);
  assert.equal(percentileOf([1, null], 5), 50);     // no response counts as slower than anything
  assert.equal(percentileOf([1, null], null), 75);
  assert.equal(upperP([1, 2, 3], 3), 0.5);
  assert.equal(upperP([1, 2, 3], 4), 0.25);
});

test('the lab\'s poke runner matches the site\'s poke bit for bit', () => {
  const cells = labCells(D);
  const set = cells.touch.slice(10, 16), prm = { drive: 1.2, pokeSteps: 5, pokes: 4, interval: 30 };
  const w = new WormCore(D), peaks = [];
  for (let k = 0; k < prm.pokes; k++) {
    assert.ok(w.poke('p' + k, set));
    let pk = 0;
    for (let t = 0; t < prm.interval; t++) { w.tick(); pk = Math.max(pk, w.last.nAct); }
    peaks.push(pk);
  }
  const mine = pokeTrain(D, set, prm, undefined, cells.roles);
  assert.deepEqual(mine.out.map((o) => o.peak), peaks);
  assert.deepEqual(Array.from(mine.r), Array.from(w.sim.r));
});

test('ending a peak measurement once activity can only decay changes nothing', () => {
  const cells = labCells(D), { roles } = cells;
  const cascade = D.n.findIndex((x) => x[0] === 'pygCirrusCR3r');   // a touch sensor whose poke lights up most of the body
  assert.ok(cascade >= 0);
  const picks = [cascade, ...cells.touch.slice(0, 6), ...cells.otherSensory.filter((_, k) => k % 60 === 0)];
  for (const W of [D, scrambleWiring(D, 5)]) {
    const sim = makeSimFor(W);
    for (const c of picks) {
      const full = startlePeak(sim, roles, [c], 1.2, 5, 60, { countFiring: true, stopWhenQuiet: false });
      const early = startlePeak(sim, roles, [c], 1.2, 5, 60, { countFiring: true, stopWhenQuiet: true });
      assert.deepEqual(early, full, `cell ${c}`);
    }
    const group = cells.touch.slice(0, 20);
    assert.deepEqual(startlePeak(sim, roles, group, 0.5, 10, 90, { stopWhenQuiet: true }), startlePeak(sim, roles, group, 0.5, 10, 90, { stopWhenQuiet: false }));
  }
});

test('the touch set has no photoreceptors (the build no longer tags eyespot-PRCR* cells as touch)', () => {
  const cells = labCells(D);
  assert.equal(cells.touchRole.length, 53);
  assert.equal(cells.touch.length, 53);
  const eyes = new Set(cells.eyes);
  assert.ok(cells.touch.every((i) => !eyes.has(i)));
  assert.ok(cells.otherSensory.every((i) => D.n[i][1] === 0 && !eyes.has(i) && !cells.touchRole.includes(i)));
});

test('smoke run: every protocol runs with 3 scrambles, deterministically', () => {
  const seen = [];
  const lab = runLab(D, { scrambles: 3, onProgress: (p) => seen.push(p.fraction) });
  assert.deepEqual(lab.results.map((r) => r.id), PROTOCOLS.map((p) => p.id));
  assert.equal(lab.protocolJson, protocolJson());
  assert.equal(lab.scrambles.made.length, 3);
  assert.ok(lab.scrambles.made.every((s) => s.swaps === 10 * M));
  assert.ok(seen.length > 10 && seen.every((f, k) => f >= 0 && f <= 1 && (k === 0 || f >= seen[k - 1])));
  assert.equal(seen[seen.length - 1], 1);
  for (const r of lab.results) {
    const p = PROTOCOLS.find((x) => x.id === r.id);
    assert.ok(['passes', 'fails', 'measured'].includes(r.verdict), `${r.id}: ${r.verdict}`);
    assert.equal(typeof r.summary, 'string');
    assert.ok(r.real && typeof r.real === 'object');
    if (p.params.scrambles) {
      assert.equal(r.control.n, 3); assert.equal(r.control.values.length, 3);
      assert.ok(r.percentile >= 0 && r.percentile <= 100);
      assert.match(r.deviation, /ran 3 scrambles; the registered protocol says 50/);
    } else {
      assert.equal(r.control, null); assert.equal(r.deviation, null);
    }
    if (/No pass rule/.test(p.rule)) assert.equal(r.verdict, 'measured');
    else assert.notEqual(r.verdict, 'measured');
  }
  assert.doesNotThrow(() => canonicalJson(lab.results));   // finite numbers only, nothing undefined
  // the alphabet covers every glyph, and a dark message fires nothing
  const abc = lab.results.find((r) => r.id === 'alphabet');
  assert.equal(abc.real.all.length, 96);
  assert.equal(abc.real.all.find((x) => x.glyph === ' ').peak, 0);
  // with fatigue off, repeated pokes do not shrink
  const fat = lab.results.find((r) => r.id === 'fatigue');
  assert.equal(fat.real.peaks.length, 10);
  assert.ok(fat.details.noFatigue.ratio > 0.9);
  // standalone runs (their own scrambles) give exactly the same results as the shared lab run
  for (const id of ['eyes-sides', 'light-latency', 'fatigue']) {
    const again = runExperiment(D, PROTOCOLS.find((x) => x.id === id), { scrambles: 3 });
    assert.deepEqual(again, lab.results.find((r) => r.id === id), id);
  }
});

test('server: the lab runs once in a worker, and a restart reads the cache', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'));
  const quiet = { log() {}, warn() {} };
  try {
    let done = null;
    const lab = startLab({ logDir, scrambles: 2, unref: false, logger: quiet, onDone: (r) => { done = r; } });
    assert.equal(lab.status().state, 'running');
    assert.equal(startLab({ logDir, scrambles: 2, logger: quiet }), lab);   // at most one worker
    const r = await lab.ready;
    assert.equal(lab.status().state, 'done');
    assert.equal(lab.status().cached, false);
    assert.equal(done, r);
    assert.equal(lab.results(), r);
    assert.equal(r.results.length, PROTOCOLS.length);
    assert.equal(r.key.scrambles, 2);
    assert.equal(r.protocolSha256, sha(protocolJson()));
    assert.equal(r.resultsSha256, resultsSha256(r.results));
    const file = path.join(logDir, 'lab-results.json');
    assert.ok(fs.existsSync(file));
    // a fresh process (a restart) finds the cached results instead of running the worker again
    const script = `import { startLab } from ${JSON.stringify(new URL('../server/lab.js', import.meta.url).href)};
      const lab = startLab({ logDir: ${JSON.stringify(logDir)}, scrambles: 2, logger: { log() {}, warn() {} } });
      lab.ready.then((r) => console.log(JSON.stringify({ cached: lab.status().cached, sha: r.resultsSha256 })));`;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
    assert.deepEqual(out, { cached: true, sha: r.resultsSha256 });
    await lab.stop();
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

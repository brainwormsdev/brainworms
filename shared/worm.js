// One worm: the simulation plus everything that stimulates it (message queue, tugs, pokes)
// and per-event summaries. Pure and deterministic: no timers, no I/O, no randomness.
// The server runs one of these for everyone; the browser runs one in offline mode;
// scripts/replay.js runs one to re-check a server's event log.
import { makeSim } from './sim.js';
import { indexRoles, readouts } from './roles.js';
import { renderText, renderHalf, applyEyes, applyEyesSplit, durationSteps, halfDurationSteps, SPEED } from './text.js';
import { createBody, UM_PER_UNIT } from './body.js';
import { LAMP, lampDir, placeLamp, lampLight, applyLamp } from './lamp.js';

export const MAX_POKE_CELLS = 6;
export const POKE_STEPS = 5;
export const POKE_DRIVE = 1.2;
// A tug shows word A to one half of the view and word B to the other in five passes:
// a warm-up A|B that isn't scored, then A|B, B|A, B|A, A|B. Each word is scored on each side
// equally often, and each scored side follows each kind of pass once, so the model's own
// left/right lean and the fatigue left over from the previous pass both cancel out.
// TUG_GAP dark steps after each pass let activity settle before the next one.
export const TUG_ORDER = [1, 1, -1, -1, 1];   // +1 = word A on the left eyes
export const TUG_SCORED = [0, 1, 1, 1, 1];
export const TUG_GAP = 90;
const TRACK_LIMIT = { say: 400, poke: 120, lamp: LAMP.steps + 150 };
const round3 = (v) => Math.round(v * 1000) / 1000;
const round5 = (v) => Math.round(v * 100000) / 100000;

export class WormCore {
  /**
   * @param {{n:any[], e:number[]}} D wiring data
   * @param {{onEvent?: (ev: object) => void}} opts
   *   onEvent receives {type:'start'|'poke'|'tug'|'done', id, step, ...}
   */
  constructor(D, { onEvent } = {}) {
    this.D = D;
    this.sim = makeSim(D);
    this.roles = indexRoles(D);
    this.stepCount = 0;
    this.queue = [];
    this.current = null;
    this.pokes = [];
    this.tracked = [];
    this.onEvent = onEvent || (() => {});
    this.last = { nAct: 0, bend: 0, cil: 0, st: 0 };
    this.body = createBody();
  }

  get step() { return this.stepCount; }
  get N() { return this.sim.N; }

  /** Keep only distinct touch-sensor cell ids, at most MAX_POKE_CELLS. */
  validPokeCells(cells) {
    if (!Array.isArray(cells)) return [];
    const out = [];
    for (const c of cells) {
      if (Number.isInteger(c) && this.roles.touchSet.has(c) && !out.includes(c)) out.push(c);
      if (out.length >= MAX_POKE_CELLS) break;
    }
    return out;
  }

  _prepare(m) {
    if (m.kind === 'lamp') return { ...m, dir: [...m.dir], duration: LAMP.steps };
    if (m.kind === 'tug') {
      const bmpA = renderHalf(m.a), bmpB = renderHalf(m.b);
      const phase = Math.max(halfDurationSteps(bmpA), halfDurationSteps(bmpB));
      return { ...m, bmpA, bmpB, phase, duration: TUG_ORDER.length * (phase + TUG_GAP), acc: TUG_ORDER.map(() => 0), n: TUG_ORDER.map(() => 0) };
    }
    const bmp = renderText(m.text);
    return { ...m, kind: 'say', bmp, duration: durationSteps(bmp) };
  }

  _ahead() { return this.queue.length - 1 + (this.current ? 1 : 0); }

  /** Queue a message. Returns how many messages play before it. */
  say(id, text, meta = {}) {
    this.queue.push(this._prepare({ kind: 'say', id, text, meta }));
    return this._ahead();
  }

  /** Queue a tug between two words. Returns how many stimuli play before it. */
  tug(id, a, b, meta = {}) {
    this.queue.push(this._prepare({ kind: 'tug', id, a, b, meta }));
    return this._ahead();
  }

  /**
   * Queue a lamp, lit `dir` of wherever the worm is when its turn comes. `dir` is kept exactly as
   * given (it's what gets logged) and normalised only when the lamp is placed, so every replay places
   * it identically. Returns how many play before it, or -1 for a bad direction.
   */
  lamp(id, dir, meta = {}) {
    if (!lampDir(dir)) return -1;
    this.queue.push(this._prepare({ kind: 'lamp', id, dir, meta }));
    return this._ahead();
  }

  get tugPlaying() { return !!(this.current && this.current.kind === 'tug'); }

  /** Poke touch sensors now. Returns the cells used, or null if none were valid or a tug is playing. */
  poke(id, cells, meta = {}) {
    if (this.tugPlaying) return null;   // a poke would push the tug one way
    const valid = this.validPokeCells(cells);
    if (!valid.length) return null;
    this.pokes.push({ cells: valid, left: POKE_STEPS });
    this._track({ id, kind: 'poke', meta });
    this.onEvent({ type: 'poke', id, step: this.stepCount, cells: valid, meta });
    return valid;
  }

  _track(ev, limit = TRACK_LIMIT[ev.kind]) {
    // A new stimulus closes the summaries of earlier ones, so each summary covers one stimulus.
    // The exception is a message still in front of the eyes: it keeps its summary to the end and
    // counts the pokes that landed during it, so its score is never cut short and never hidden.
    for (const o of this.tracked) {
      if (ev.kind === 'poke' && this.current && o.id === this.current.id) { o.pokes = (o.pokes || 0) + 1; continue; }
      this._finish(o);
    }
    this.tracked = this.tracked.filter((o) => !o.done);
    const b = this.body.state;
    this.tracked.push({ ...ev, start: this.stepCount, limit, peak: 0, bend: 0, cil: 0, st: 0, flood: 0, turn0: b.turn, dist0: b.dist, done: false,
      ...(ev.kind === 'lamp' ? { lampN: 0, dSum: 0, d0: 0, dEnd: 0, dMin: 1e9 } : {}) });
  }

  _finish(o) {
    if (o.done) return;
    o.done = true;
    const b = this.body.state;
    const summary = {
      peak: o.peak, bend: round3(o.bend), cil: round3(o.cil), st: round3(o.st), flood: round3(o.flood), steps: this.stepCount - o.start,
      swim: Math.round((b.dist - o.dist0) * UM_PER_UNIT), turn: Math.round((b.turn - o.turn0) * 180 / Math.PI),   // µm swum, degrees turned (+ = left)
    };
    if (o.stop) summary.stop = Math.round(o.stop / 3) / 10;   // seconds
    if (o.kind === 'lamp' && o.lampN) {   // distances to the lamp while it was lit, in µm
      const um = (u) => Math.round(u * UM_PER_UNIT);
      summary.lamp = { from: um(o.d0), to: um(o.dEnd), closest: um(o.dMin), mean: um(o.dSum / o.lampN) };
    }
    if (o.tug) summary.tug = o.tug;
    if (o.pokes) summary.pokes = o.pokes;
    this.onEvent({ type: 'done', id: o.id, kind: o.kind, step: this.stepCount, meta: o.meta, summary });
  }

  /** Advance one simulation step. */
  tick() {
    const { sim, roles } = this;
    sim.ext.fill(0);

    if (!this.current && this.queue.length) {
      const m = this.queue.shift();
      m.startStep = this.stepCount;
      this.current = m;
      if (m.kind === 'lamp') m.pos = placeLamp(this.body.state.p, lampDir(m.dir), this.body.P.tank);
      this._track({ id: m.id, kind: m.kind, meta: m.meta }, m.kind === 'tug' ? m.duration + 300 : undefined);
      this.onEvent(m.kind === 'tug'
        ? { type: 'start', kind: 'tug', id: m.id, step: this.stepCount, a: m.a, b: m.b, meta: m.meta }
        : m.kind === 'lamp'
          ? { type: 'start', kind: 'lamp', id: m.id, step: this.stepCount, dir: [...m.dir], pos: [...m.pos], meta: m.meta }
          : { type: 'start', kind: 'say', id: m.id, step: this.stepCount, text: m.text, meta: m.meta });
    }
    let tugNow = null, tugPhase = -1;
    if (this.current) {
      const m = this.current, t = this.stepCount - m.startStep;
      let flood = 0;
      if (m.kind === 'tug') {
        tugNow = m;
        tugPhase = Math.floor(t / (m.phase + TUG_GAP));
        const within = t % (m.phase + TUG_GAP);
        if (within < m.phase) {
          const aLeft = TUG_ORDER[tugPhase] === 1;
          flood = applyEyesSplit(sim.ext, roles, aLeft ? m.bmpA : m.bmpB, within * SPEED, aLeft ? m.bmpB : m.bmpA, within * SPEED);
        }
      } else if (m.kind === 'lamp') {
        const light = lampLight(this.body.state, m.pos);
        applyLamp(sim.ext, roles, light);
        const o = this.tracked.find((x) => x.id === m.id);
        if (o) {
          if (o.lampN === 0) o.d0 = light.d;
          o.lampN++; o.dSum += light.d; o.dEnd = light.d;
          if (light.d < o.dMin) o.dMin = light.d;
        }
      } else {
        flood = applyEyes(sim.ext, roles, m.bmp, t * SPEED);
      }
      const o = this.tracked[0];
      if (o && o.id === m.id && flood > o.flood) o.flood = flood;
      if (t + 1 >= m.duration) { m.finished = true; this.current = null; }
    }
    for (let q = this.pokes.length - 1; q >= 0; q--) {
      const p = this.pokes[q];
      for (const i of p.cells) sim.ext[i] += POKE_DRIVE;
      if (--p.left <= 0) this.pokes.splice(q, 1);
    }

    sim.step();
    this.stepCount++;
    const ro = readouts(sim.r, roles);
    this.last = ro;
    this.body.step(sim.r, roles, ro);

    if (tugNow) {
      tugNow.acc[tugPhase] += ro.bend;
      tugNow.n[tugPhase]++;
      if (tugNow.finished) this._tugResult(tugNow);
    }

    for (const o of this.tracked) {
      if (o.done) continue;
      if (ro.nAct > o.peak) o.peak = ro.nAct;
      if (Math.abs(ro.bend) > Math.abs(o.bend)) o.bend = ro.bend;
      if (Math.abs(ro.cil) > Math.abs(o.cil)) o.cil = ro.cil;
      if (ro.st > o.st) o.st = ro.st;
      if (this.body.state.beat < 0.5) o.stop = (o.stop || 0) + 1;   // steps with its cilia mostly stopped
      const age = this.stepCount - o.start;
      const playing = this.current && this.current.id === o.id;
      if (age > o.limit || (age > 30 && ro.nAct === 0 && !playing)) this._finish(o);
    }
    this.tracked = this.tracked.filter((o) => !o.done);
  }

  _tugResult(m) {
    // mean left-minus-right muscle activity in each scored pass; + score = the body bent toward word A
    const passes = m.acc.map((s, k) => s / m.n[k]);
    const scored = passes.filter((_, k) => TUG_SCORED[k]);
    const score = passes.reduce((s, v, k) => s + TUG_SCORED[k] * TUG_ORDER[k] * v, 0) / scored.length;
    const result = { score: round5(score), winner: Math.abs(score) < 2e-5 ? 'tie' : score > 0 ? 'a' : 'b', phases: scored.map(round5) };
    const o = this.tracked.find((t) => t.id === m.id);
    if (o) o.tug = result;
    this.onEvent({ type: 'tug', id: m.id, step: this.stepCount, a: m.a, b: m.b, meta: m.meta, result });
  }

  /** Activity quantised to bytes (0..255) for streaming. */
  quantize(out = new Uint8Array(this.sim.N)) {
    const r = this.sim.r;
    for (let i = 0; i < r.length; i++) { const v = r[i] * 255; out[i] = v >= 255 ? 255 : v <= 0 ? 0 : Math.round(v); }
    return out;
  }

  /** What is in front of the eyes: current stimulus, scroll position, and what is queued. */
  status() {
    const pub = (m) => (m.kind === 'tug'
      ? { kind: 'tug', id: m.id, a: m.a, b: m.b, meta: m.meta }
      : m.kind === 'lamp'
        ? { kind: 'lamp', id: m.id, dir: [...m.dir], ...(m.pos ? { pos: [...m.pos] } : {}), meta: m.meta }
        : { kind: 'say', id: m.id, text: m.text, meta: m.meta });
    return {
      current: this.current ? { ...pub(this.current), startStep: this.current.startStep } : null,
      queue: this.queue.map(pub),
    };
  }

  /**
   * Everything needed to continue this worm exactly: activity, fatigue, queue, open summaries.
   * restore(snapshot()) on a fresh WormCore continues bit-for-bit identically.
   */
  snapshot() {
    const item = (m) => (m.kind === 'tug' ? { kind: 'tug', id: m.id, a: m.a, b: m.b, meta: m.meta }
      : m.kind === 'lamp' ? { kind: 'lamp', id: m.id, dir: [...m.dir], meta: m.meta }
        : { kind: 'say', id: m.id, text: m.text, meta: m.meta });
    const cur = this.current;
    return {
      step: this.stepCount,
      r: Float32Array.from(this.sim.r),
      fatigue: Float32Array.from(this.sim.fatigue),
      queue: this.queue.map(item),
      current: cur ? { ...item(cur), startStep: cur.startStep, ...(cur.kind === 'tug' ? { acc: [...cur.acc], n: [...cur.n] } : {}), ...(cur.pos ? { pos: [...cur.pos] } : {}) } : null,
      pokes: this.pokes.map((p) => ({ cells: [...p.cells], left: p.left })),
      tracked: this.tracked.map((o) => ({ ...o, meta: { ...o.meta }, ...(o.tug ? { tug: { ...o.tug, phases: [...o.tug.phases] } } : {}) })),
      last: { ...this.last },
      body: this.body.snapshot(),
    };
  }

  restore(s) {
    this.stepCount = s.step;
    this.sim.r.set(s.r);
    this.sim.fatigue.set(s.fatigue);
    this.queue = s.queue.map((m) => this._prepare(m));
    this.current = null;
    if (s.current) {
      const { startStep, acc, n, pos, ...m } = s.current;
      this.current = Object.assign(this._prepare(m), { startStep }, acc ? { acc: [...acc], n: [...n] } : {}, pos ? { pos: [...pos] } : {});
    }
    this.pokes = s.pokes.map((p) => ({ cells: [...p.cells], left: p.left }));
    this.tracked = s.tracked.map((o) => ({ ...o }));
    this.last = { ...s.last };
    if (s.body) this.body.restore(s.body);
    return this;
  }
}

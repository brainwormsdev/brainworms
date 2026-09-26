// One worm: the simulation plus everything that stimulates it (message queue, pokes)
// and per-event summaries. Pure and deterministic: no timers, no I/O, no randomness.
// The server runs one of these for everyone; the browser runs one in offline mode;
// scripts/replay.js runs one to re-check a server's event log.
import { makeSim } from './sim.js';
import { indexRoles, readouts } from './roles.js';
import { renderText, applyEyes, durationSteps, SPEED } from './text.js';

export const MAX_POKE_CELLS = 6;
export const POKE_STEPS = 5;
export const POKE_DRIVE = 1.2;
const TRACK_LIMIT = { say: 400, poke: 120 };
const round3 = (v) => Math.round(v * 1000) / 1000;

export class WormCore {
  /**
   * @param {{n:any[], e:number[]}} D wiring data
   * @param {{onEvent?: (ev: object) => void}} opts
   *   onEvent receives {type:'start'|'poke'|'done', id, step, ...}
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

  /** Queue a message. Returns how many messages play before it. */
  say(id, text, meta = {}) {
    this.queue.push({ id, text, meta, bmp: renderText(text) });
    return this.queue.length - 1 + (this.current ? 1 : 0);
  }

  /** Poke touch sensors now. Returns the cells used, or null if none were valid. */
  poke(id, cells, meta = {}) {
    const valid = this.validPokeCells(cells);
    if (!valid.length) return null;
    this.pokes.push({ cells: valid, left: POKE_STEPS });
    this._track({ id, kind: 'poke', meta });
    this.onEvent({ type: 'poke', id, step: this.stepCount, cells: valid, meta });
    return valid;
  }

  _track(ev) {
    // a new stimulus closes the summaries of earlier ones, so each summary covers one stimulus
    for (const o of this.tracked) this._finish(o);
    this.tracked = [{ ...ev, start: this.stepCount, peak: 0, bend: 0, cil: 0, st: 0, flood: 0, done: false }];
  }

  _finish(o) {
    if (o.done) return;
    o.done = true;
    this.onEvent({
      type: 'done', id: o.id, kind: o.kind, step: this.stepCount, meta: o.meta,
      summary: { peak: o.peak, bend: round3(o.bend), cil: round3(o.cil), st: round3(o.st), flood: round3(o.flood), steps: this.stepCount - o.start },
    });
  }

  /** Advance one simulation step. */
  tick() {
    const { sim, roles } = this;
    sim.ext.fill(0);

    if (!this.current && this.queue.length) {
      const m = this.queue.shift();
      m.startStep = this.stepCount;
      m.duration = durationSteps(m.bmp);
      this.current = m;
      this._track({ id: m.id, kind: 'say', meta: m.meta });
      this.onEvent({ type: 'start', id: m.id, step: this.stepCount, text: m.text, meta: m.meta });
    }
    if (this.current) {
      const m = this.current;
      const flood = applyEyes(sim.ext, roles, m.bmp, (this.stepCount - m.startStep) * SPEED);
      const t = this.tracked[0];
      if (t && t.id === m.id && flood > t.flood) t.flood = flood;
      if (this.stepCount - m.startStep + 1 >= m.duration) { m.finished = true; this.current = null; }
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

    for (const o of this.tracked) {
      if (o.done) continue;
      if (ro.nAct > o.peak) o.peak = ro.nAct;
      if (Math.abs(ro.bend) > Math.abs(o.bend)) o.bend = ro.bend;
      if (Math.abs(ro.cil) > Math.abs(o.cil)) o.cil = ro.cil;
      if (ro.st > o.st) o.st = ro.st;
      const age = this.stepCount - o.start;
      const playing = o.kind === 'say' && this.current && this.current.id === o.id;
      if (age > TRACK_LIMIT[o.kind] || (age > 30 && ro.nAct === 0 && !playing)) this._finish(o);
    }
    this.tracked = this.tracked.filter((o) => !o.done);
  }

  /** Activity quantised to bytes (0..255) for streaming. */
  quantize(out = new Uint8Array(this.sim.N)) {
    const r = this.sim.r;
    for (let i = 0; i < r.length; i++) { const v = r[i] * 255; out[i] = v >= 255 ? 255 : v <= 0 ? 0 : Math.round(v); }
    return out;
  }

  /** What is in front of the eyes: current message, scroll position, and what is queued. */
  status() {
    return {
      current: this.current ? { id: this.current.id, text: this.current.text, startStep: this.current.startStep, meta: this.current.meta } : null,
      queue: this.queue.map((m) => ({ id: m.id, text: m.text, meta: m.meta })),
    };
  }
}

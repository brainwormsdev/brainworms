// A live mirror of the server's worm. Given the server's exact state once, then every stimulus as
// it happens, it runs its own copy and checks it against the hash the server sends each second.
// The browser runs this in a worker ("your tab matches the server"); the tests run it in Node.
import { WormCore } from './worm.js';
import { decodeSnapshot } from './state.js';
import { stateString, applyInput } from './replay.js';

/** @param {{sha256: (s: string) => string|Promise<string>}} opts */
export function createMirror(D, { sha256 }) {
  let worm = null, pending = [];
  return {
    get step() { return worm ? worm.step : -1; },
    get running() { return !!worm; },
    reset() { worm = null; pending = []; },
    /** Start from the server's state (from a {t:'state'} message). */
    state(state) { worm = new WormCore(D).restore(decodeSnapshot(state)); pending = []; },
    /** A stimulus as broadcast: {k:'say'|'tug'|'poke'|'lamp', step, id, by, text|a,b|cells|dir}. */
    event(e) { if (worm && e.step >= worm.step) pending.push(e); },
    /** The server's hash at `step`: catch up, hash, compare. */
    async sync(step, sha) {
      if (!worm || step < worm.step) return null;
      while (pending.length && pending[0].step < step) {
        const e = pending.shift();
        while (worm.step < e.step) worm.tick();
        applyInput(worm, e);
      }
      while (worm.step < step) worm.tick();
      const mine = await sha256(stateString(worm));
      return { step, ok: mine === sha, mine, theirs: sha };
    },
  };
}

/** Turn a server broadcast into a mirror event (or null). */
export function mirrorEvent(m) {
  if (m.t === 'start') {
    if (m.kind === 'tug') return { k: 'tug', step: m.step, id: m.id, by: m.by, a: m.a, b: m.b };
    if (m.kind === 'lamp') return { k: 'lamp', step: m.step, id: m.id, by: m.by, dir: m.dir };
    return { k: 'say', step: m.step, id: m.id, by: m.by, text: m.text };
  }
  if (m.t === 'poke') return { k: 'poke', step: m.step, id: m.id, by: m.by, cells: m.cells };
  return null;
}

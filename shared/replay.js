// Re-run an event log and check that every published result comes out the same. Runs unchanged
// in Node (scripts/replay.js, tests) and in the browser (public/verify-worker.js), so anyone can
// check the server with nothing but a web page.
//
// A log chunk starts at boot (the worm at rest) or at a checkpoint (the worm's exact state), then
// lists every stimulus with the step it reached the worm and every result; a sealed chunk ends
// with a hash of the state it left behind.
import { WormCore } from './worm.js';
import { PARAMS } from './sim.js';
import { encodeSnapshot, decodeSnapshot } from './state.js';

export const LOG_VERSION = 5;

/** The canonical state string that gets hashed (queued messages are left out: they're logged when they start). */
export const stateString = (worm) => JSON.stringify(encodeSnapshot({ ...worm.snapshot(), queue: [] }));

/** Apply one logged stimulus to a worm that has been ticked to its step. */
export function applyInput(worm, inp) {
  if (inp.k === 'poke') worm.poke(inp.id, inp.cells, { by: inp.by });
  else if (inp.k === 'say') worm.say(inp.id, inp.text, { by: inp.by });
  else if (inp.k === 'tug') worm.tug(inp.id, inp.a, inp.b, { by: inp.by });
  else if (inp.k === 'lamp') worm.lamp(inp.id, inp.dir, { by: inp.by });
}

/**
 * @param {string} text the event log (JSONL)
 * @param {Uint8Array} wiringBytes the exact bytes of data/wiring.json
 * @param {{sha256: (x: string|Uint8Array) => string|Promise<string>, onProgress?: (f: number) => void}} opts
 */
export async function replayLog(text, wiringBytes, { sha256, onProgress = () => {} }) {
  const D = JSON.parse(new TextDecoder().decode(wiringBytes));
  const wiringHash = await sha256(wiringBytes);
  const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const segments = [];
  let seg = null;
  for (const row of rows) {
    if (row.k === 'boot' || row.k === 'checkpoint') { seg = { head: row, rows: [] }; segments.push(seg); continue; }
    if (!seg) { seg = { head: null, rows: [] }; segments.push(seg); }
    seg.rows.push(row);
  }
  const out = [];
  for (const { head, rows } of segments) {
    const warnings = [];
    const got = new Map();
    const worm = new WormCore(D, { onEvent: (ev) => { if (ev.type === 'done') got.set(ev.id, ev.summary); } });
    if (!head) warnings.push('log does not start with a boot or checkpoint line');
    else {
      if (head.v !== LOG_VERSION) warnings.push(`log was written by model version ${head.v}; this code is version ${LOG_VERSION}`);
      if (head.wiringSha256 !== wiringHash) warnings.push('wiring file differs from the one the server used');
      if (JSON.stringify(head.params) !== JSON.stringify(PARAMS)) warnings.push('model parameters differ from the ones the server used');
      if (head.k === 'checkpoint') {
        if (await sha256(JSON.stringify(head.state)) !== head.stateSha256) warnings.push('checkpoint state does not match its own hash');
        worm.restore(decodeSnapshot(head.state));
      } else if (head.step) warnings.push(`boot line at step ${head.step}, expected 0`);
    }
    const startStateSha256 = head ? await sha256(stateString(worm)) : null;
    if (head && head.k === 'checkpoint' && startStateSha256 !== head.stateSha256) warnings.push('restored state differs from the checkpoint');
    const inputs = rows.filter((r) => r.k === 'say' || r.k === 'poke' || r.k === 'tug' || r.k === 'lamp');
    const expected = new Map(rows.filter((r) => r.k === 'done').map((r) => [r.id, r.summary]));
    const end = rows.find((r) => r.k === 'end');
    const first = worm.step;
    let last = worm.step;
    for (const r of rows) last = Math.max(last, r.step || 0);
    const span = Math.max(1, (end ? end.step : last) - first);
    // the launch moment: from the arming step, the first step whose startle level passes the threshold
    let watch = null, launch = null;
    const tickTo = (s) => {
      while (worm.step < s) {
        worm.tick();
        if (watch && watch.first == null && worm.last.st > watch.threshold) watch.first = worm.step;
        if (worm.step % 3000 === 0) onProgress((worm.step - first) / span);
      }
    };
    for (const r of rows) {
      if (r.k === 'say' || r.k === 'poke' || r.k === 'tug' || r.k === 'lamp') {
        tickTo(r.step);
        if (r.k !== 'poke' && (worm.current || worm.queue.length)) warnings.push(`${r.k} ${r.id} logged at step ${r.step} while another was playing`);
        applyInput(worm, r);
      } else if (r.k === 'launch-armed') {
        tickTo(r.step);
        watch = { from: r.step, threshold: r.startle, first: null };
      } else if (r.k === 'launch-disarmed') {
        tickTo(r.step); watch = null;
      } else if (r.k === 'launch-moment') {
        tickTo(r.step);
        const stateOk = (await sha256(stateString(worm))) === r.stateSha256;
        const firstOk = watch ? watch.first === r.step : null;
        launch = { step: r.step, stateOk, firstOk, armedAt: watch ? watch.from : null };
        if (!stateOk) warnings.push(`launch moment at step ${r.step}: state differs from the logged hash`);
        if (firstOk === false) warnings.push(`launch moment logged at step ${r.step}, but the first startle after arming was at step ${watch.first}`);
        watch = null;
      }
    }
    let endStateSha256 = null;
    if (end) {
      tickTo(end.step);
      endStateSha256 = await sha256(stateString(worm));
      if (endStateSha256 !== end.stateSha256) warnings.push('state at the end of the chunk differs from the logged hash');
    } else tickTo(last + 1);
    onProgress(1);
    const mismatches = [];
    let checked = 0, matched = 0;
    for (const [id, want] of expected) {
      checked++;
      const have = got.get(id);
      if (have && JSON.stringify(have) === JSON.stringify(want)) matched++;
      else mismatches.push(`${id}: log says ${JSON.stringify(want)}, replay gives ${JSON.stringify(have)}`);
    }
    out.push({ inputs: inputs.length, checked, matched, mismatches, warnings, steps: worm.step - first, startStateSha256, endStateSha256, endChecked: !!end, launch });
  }
  return { segments: out };
}

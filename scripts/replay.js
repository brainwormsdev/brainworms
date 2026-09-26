#!/usr/bin/env node
// Re-run a server event log and check that every published summary comes out the same.
//
//   npm run replay -- var/events-2026-09-26T19-55-00-000Z.jsonl
//   npm run replay -- https://your-site.example/log/current.jsonl
//
// The worm is deterministic: same wiring + same stimuli at the same steps = same activity.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WormCore } from '../shared/worm.js';
import { PARAMS } from '../shared/sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {{segments: Array<{inputs:number, checked:number, matched:number, mismatches:string[], warnings:string[]}>}} */
export function replayLog(text, wiringRaw) {
  const D = JSON.parse(wiringRaw);
  const hash = crypto.createHash('sha256').update(wiringRaw).digest('hex');
  const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const segments = [];
  let seg = null;
  for (const row of rows) {
    if (row.k === 'boot') { seg = { boot: row, rows: [] }; segments.push(seg); continue; }
    if (!seg) { seg = { boot: null, rows: [] }; segments.push(seg); }
    seg.rows.push(row);
  }
  return {
    segments: segments.map(({ boot, rows }) => {
      const warnings = [];
      if (!boot) warnings.push('log does not start with a boot line');
      else {
        if (boot.wiringSha256 !== hash) warnings.push('wiring file differs from the one the server used');
        if (JSON.stringify(boot.params) !== JSON.stringify(PARAMS)) warnings.push('model parameters differ from the ones the server used');
      }
      const got = new Map();
      const worm = new WormCore(D, { onEvent: (ev) => { if (ev.type === 'done') got.set(ev.id, ev.summary); } });
      const inputs = rows.filter((r) => r.k === 'say' || r.k === 'poke');
      const expected = new Map(rows.filter((r) => r.k === 'done').map((r) => [r.id, r.summary]));
      let lastStep = 0;
      for (const r of rows) lastStep = Math.max(lastStep, r.step || 0);
      for (const inp of inputs) {
        while (worm.step < inp.step) worm.tick();
        if (inp.k === 'say') {
          if (worm.current || worm.queue.length) warnings.push(`message ${inp.id} logged at step ${inp.step} while another was playing`);
          worm.say(inp.id, inp.text, { by: inp.by });
        } else {
          worm.poke(inp.id, inp.cells, { by: inp.by });
        }
      }
      while (worm.step <= lastStep) worm.tick();
      const mismatches = [];
      let checked = 0, matched = 0;
      for (const [id, want] of expected) {
        checked++;
        const have = got.get(id);
        if (have && JSON.stringify(have) === JSON.stringify(want)) matched++;
        else mismatches.push(`${id}: log says ${JSON.stringify(want)}, replay gives ${JSON.stringify(have)}`);
      }
      return { inputs: inputs.length, checked, matched, mismatches, warnings };
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src) { console.error('Usage: npm run replay -- <events.jsonl file or URL>'); process.exit(2); }
  const text = /^https?:\/\//.test(src) ? await (await fetch(src)).text() : fs.readFileSync(src, 'utf8');
  const wiringRaw = fs.readFileSync(path.join(ROOT, 'data', 'wiring.json'));
  const { segments } = replayLog(text, wiringRaw);
  let bad = 0;
  segments.forEach((s, k) => {
    console.log(`Run ${k + 1}: ${s.inputs} messages and pokes, ${s.matched}/${s.checked} summaries reproduced exactly`);
    for (const w of s.warnings) console.log('  warning: ' + w);
    for (const m of s.mismatches.slice(0, 10)) console.log('  mismatch: ' + m);
    bad += s.mismatches.length + s.warnings.length;
  });
  process.exit(bad ? 1 : 0);
}

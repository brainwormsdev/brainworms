#!/usr/bin/env node
// Re-run a server event log and check that every published result comes out the same.
//
//   npm run replay -- var/events-2026-09-26T19-55-00-000Z-c0000.jsonl
//   npm run replay -- https://your-site.example/log/current.jsonl
//
// The same check runs in the browser: the site's "Replay it in your browser" button uses
// shared/replay.js, exactly like this script does.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { replayLog as replay } from '../shared/replay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

/** Node wrapper: replayLog(text, wiringBuffer) with SHA-256 from node:crypto. */
export const replayLog = (text, wiringRaw) => replay(text, new Uint8Array(wiringRaw), { sha256 });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src) { console.error('Usage: npm run replay -- <events.jsonl file or URL>'); process.exit(2); }
  const text = /^https?:\/\//.test(src) ? await (await fetch(src)).text() : fs.readFileSync(src, 'utf8');
  const wiringRaw = fs.readFileSync(path.join(ROOT, 'data', 'wiring.json'));
  const { segments } = await replayLog(text, wiringRaw);
  let bad = 0;
  segments.forEach((s, k) => {
    console.log(`Run ${k + 1}: ${s.inputs} messages, tugs and pokes over ${s.steps} steps, ${s.matched}/${s.checked} results reproduced exactly` + (s.endChecked ? ', end state matches' : ''));
    for (const w of s.warnings) console.log('  warning: ' + w);
    for (const m of s.mismatches.slice(0, 10)) console.log('  mismatch: ' + m);
    bad += s.mismatches.length + s.warnings.length;
  });
  process.exit(bad ? 1 : 0);
}

#!/usr/bin/env node
// BRAINWORM lab: run every pre-registered experiment on the real wiring and its scrambles, and print
// each question, rule, result and verdict. Same code as the site's lab (shared/lab.js), so every
// machine gets the same numbers and the same results hash.
//
//   node scripts/lab.js                         the registered run (50 scrambles per experiment)
//   node scripts/lab.js --scrambles 10          quicker; flagged as a deviation from the protocols
//   node scripts/lab.js --json lab.json         also write every number to a file
//   node scripts/lab.js --only eyes-sides,fatigue
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOLS, runLab, protocolJson } from '../shared/lab.js';
import { labIdentity, resultsSha256 } from '../server/lab.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { scrambles: undefined, json: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--scrambles') o.scrambles = Number(v());
    else if (a === '--json') o.json = v();
    else if (a === '--only') o.only = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '-h' || a === '--help') { o.help = true; }
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.scrambles !== undefined && !(Number.isInteger(o.scrambles) && o.scrambles >= 1)) throw new Error('--scrambles must be a whole number ≥ 1');
  return o;
}

const f = (x, d = 4) => (x === null || x === undefined ? 'none' : typeof x === 'number' ? Number(x.toPrecision(d)).toString() : String(x));
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${x.toFixed(1)}`);
const wrap = (label, text, width = 100) => {
  const pad = ' '.repeat(12), words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const w of words) { if (line && (line + ' ' + w).length > width - 12) { lines.push(line); line = w; } else line = line ? line + ' ' + w : w; }
  if (line) lines.push(line);
  return lines.map((l, k) => (k ? pad : (label + pad).slice(0, 12)) + l).join('\n');
};
const ctl = (c, unit = '') => (c ? `${c.n} scrambles: mean ${f(c.mean)}${unit}, sd ${f(c.sd)}, p95 ${f(c.p95)}${unit}, min ${f(c.min)}, max ${f(c.max)}` : 'none');

function printResult(r, k, ms, sha) {
  console.log(`\n━━ ${k}. ${r.title}  [${r.id} v${r.version}]  protocol ${sha.slice(0, 16)}…`);
  if (r.protocol.registeredAfter) console.log(wrap('POST HOC', `registered after ${r.protocol.registeredAfter}. ${r.protocol.why}`));
  console.log(wrap('Question', r.question));
  console.log(wrap('Rule', r.rule));
  const R = r.real, kind = r.protocol.kind;
  if (kind === 'eyes-sides') {
    console.log(wrap('Real', `lateralization ${f(R.lateralization)} = |L_cil ${f(R.L_cil)}| + |L_bend ${f(R.L_bend)}|; movers' mean activity ${f(R.movers)}`));
    console.log(wrap('Control', ctl(r.control)));
    const P = r.details.parts;
    console.log(wrap('Parts', `|L_cil| ${f(P.L_cil.realAbs)} vs p95 ${f(P.L_cil.controlAbs.p95)} (percentile ${pct(P.L_cil.percentile)}); |L_bend| ${f(P.L_bend.realAbs)} vs p95 ${f(P.L_bend.controlAbs.p95)} (percentile ${pct(P.L_bend.percentile)}); movers in scrambles: mean ${f(r.details.movers.control.mean)}`));
  } else if (kind === 'touch-startle') {
    console.log(wrap('Real', `touch peak ${f(R.touch)} at step ${R.touchPeakStep} (${R.touchCells} cells); other sensory mean ${f(R.other)} (draws: ${r.details.otherDraws.map((d) => f(d.peak, 3)).join(', ')}); ratio ${f(R.ratio, 3)}`));
    console.log(wrap('Control', ctl(r.control)));
    console.log(wrap('Conditions', `≥ ratio × other: ${r.details.conditions.atLeastRatioTimesOther}; > scramble p95: ${r.details.conditions.aboveScrambleP95}`));
  } else if (kind === 'touch-startle-single') {
    const T = r.details.touchPokes, O = r.details.otherPokes;
    console.log(wrap('Real', `touch mean peak ${f(R.touch)} (${T.reachedStartle}/${T.of} pokes above threshold, ${T.cascades} whole-body); other sensory mean ${f(R.other)} (${O.reachedStartle}/${O.of}, ${O.cascades} whole-body); ratio ${f(R.ratio, 3)}`));
    console.log(wrap('Control', ctl(r.control)));
    console.log(wrap('Conditions', `≥ ratio × other: ${r.details.conditions.atLeastRatioTimesOther}; > scramble p95: ${r.details.conditions.aboveScrambleP95}`));
  } else if (kind === 'light-latency') {
    console.log(wrap('Real', R.steps === null ? 'no response' : `${R.steps} steps = ${f(R.ms, 4)} ms (first: ${R.firstMuscle})`));
    console.log(wrap('Control', `${ctl(r.control, ' steps')}; ${r.control.responded} of ${r.control.n} responded`));
  } else if (kind === 'alphabet') {
    const g = (x) => `${x.glyph === ' ' ? '␠' : x.glyph}:${x.peak}`;
    console.log(wrap('Top 10', R.top.map(g).join('  ')));
    console.log(wrap('Bottom 10', R.bottom.map(g).join('  ')));
    console.log(wrap('Ink ~ peak', `Spearman ρ = ${f(R.spearmanInkPeak, 3)} over ${R.all.length} glyphs`));
  } else if (kind === 'fatigue') {
    console.log(wrap('Cells', R.cells.join(', ')));
    console.log(wrap('Real', `peaks ${R.peaks.join(', ')}; ratio ${f(R.ratio, 3)}; startle peaks ${R.st.map((x) => f(x, 2)).join(', ')}`));
    const o = r.details.noFatigue;
    console.log(wrap('No fatigue', `peaks ${o.peaks.join(', ')}; ratio ${f(o.ratio, 3)}`));
  }
  if (r.percentile !== null) console.log(wrap('Percentile', `${pct(r.percentile)}${r.p !== null ? `   Monte Carlo p = ${f(r.p, 3)}` : ''}`));
  console.log(wrap('Verdict', r.verdict.toUpperCase() + (r.deviation ? `   (deviation: ${r.deviation})` : '')));
  console.log(wrap('Summary', r.summary));
  console.log(wrap('Time', `${(ms / 1000).toFixed(2)} s`));
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); o = { help: true, bad: true }; }
  if (o.help) { console.log('Usage: node scripts/lab.js [--scrambles N] [--json out.json] [--only id,id]\nProtocols: ' + PROTOCOLS.map((p) => p.id).join(', ')); process.exit(o.bad ? 2 : 0); }
  const protocols = o.only ? PROTOCOLS.filter((p) => o.only.includes(p.id)) : PROTOCOLS;
  if (o.only && protocols.length !== o.only.length) { console.error(`unknown protocol in --only; known: ${PROTOCOLS.map((p) => p.id).join(', ')}`); process.exit(2); }

  const { key, protocolSha256s, wiringRaw } = labIdentity({ root: ROOT, scrambles: o.scrambles });
  const D = JSON.parse(wiringRaw);
  console.log('BRAINWORM lab: pre-registered experiments on the Platynereis larva connectome (Verasztó et al., eLife 2025)');
  console.log(`wiring      ${D.n.length} cells, ${D.e.length / 3} connections   sha256 ${key.wiringSha256}`);
  console.log(`protocols   ${PROTOCOLS.length} registered   sha256 ${key.protocolSha256}   (SHA-256 of the canonical JSON of PROTOCOLS)`);
  console.log(`code        lab v${key.labVersion}   sha256 ${key.codeSha256}`);

  const tStart = performance.now(), cpu0 = process.cpuUsage();
  const times = {}, t = { scramble0: null, scramble1: null };
  let cur = null, curStart = 0;
  const tty = process.stderr.isTTY;
  const lab = runLab(D, {
    scrambles: o.scrambles, protocols,
    onProgress: (p) => {
      const now = performance.now();
      if (p.phase === 'scramble') { if (t.scramble0 === null) t.scramble0 = now; t.scramble1 = now; }
      if (p.phase === 'start') { cur = p.id; curStart = now; }
      if (p.phase === 'done') times[p.id] = now - curStart;
      if (tty) process.stderr.write(`\r  ${(p.fraction * 100).toFixed(0).padStart(3)}%  ${p.phase === 'scramble' ? 'scrambling the wiring' : cur || ''}          `);
    },
  });
  if (tty) process.stderr.write('\r' + ' '.repeat(60) + '\r');
  const total = performance.now() - tStart, cpu = process.cpuUsage(cpu0);
  const scrambleMs = t.scramble0 === null ? 0 : t.scramble1 - tStart;

  lab.results.forEach((r, k) => printResult(r, k + 1, times[r.id] || 0, protocolSha256s[r.id]));

  const rs = resultsSha256(lab.results);
  const sw = lab.scrambles.made;
  console.log('\n━━ Reproduce');
  console.log(`protocols   sha256 ${key.protocolSha256}${o.only ? '  (all registered protocols; this run used a subset)' : ''}`);
  for (const p of protocols) console.log(`            ${p.id.padEnd(14)} ${protocolSha256s[p.id]}`);
  console.log(`results     sha256 ${rs}   (canonical JSON of the results; same on every machine)`);
  if (sw.length) console.log(`scrambles   ${sw.length} × ${sw[0].swaps} successful swaps (acceptance ${f(sw.reduce((s, x) => s + x.swaps, 0) / sw.reduce((s, x) => s + x.attempts, 0), 3)})`);
  console.log(`time        ${(total / 1000).toFixed(2)} s total (${(scrambleMs / 1000).toFixed(2)} s making scrambles), CPU ${((cpu.user + cpu.system) / 1e6).toFixed(2)} s, node ${process.version}`);
  const dev = lab.results.filter((r) => r.deviation);
  if (dev.length) console.log(`note        not the registered run: ${dev[0].deviation}`);

  if (o.json) {
    const out = {
      ...lab,   // labVersion, model, wiring, scrambles, results (protocolJson is replaced just below)
      key, protocolSha256: key.protocolSha256, wiringSha256: key.wiringSha256, codeSha256: key.codeSha256,
      protocolSha256s, resultsSha256: rs,
      protocolJson: protocolJson(),   // all registered protocols: its SHA-256 is protocolSha256
      ran: lab.results.map((r) => r.id),
      timings: { totalMs: Math.round(total), scrambleMs: Math.round(scrambleMs), cpuMs: Math.round((cpu.user + cpu.system) / 1000), perExperimentMs: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)])), node: process.version },
    };
    fs.writeFileSync(o.json, JSON.stringify(out, null, 1));
    console.log(`json        ${o.json}`);
  }
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });

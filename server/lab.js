// The lab, run off the main thread. A worker (lab-worker.js) computes every registered experiment
// once; the results are cached in <logDir>/lab-results.json, keyed by everything they depend on
// (the protocols, the wiring file, the lab and model code, the number of scrambles), so a restart
// serves them at once and any change to those recomputes them.
//
//   const lab = startLab({ root, logDir, logger, onDone: (results) => ... });
//   lab.status()   -> { state: 'running'|'done'|'error'|'stopped', progress, key, ... }   (cheap, for /lab.json)
//   lab.results()  -> the full results (null until done)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { PROTOCOLS, LAB_VERSION, protocolJson, canonicalJson } from '../shared/lab.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHARED = path.join(ROOT, 'shared');
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

/** Every file whose code can change a lab result (the lab, the model, the stimuli, the readouts). */
export const LAB_CODE_FILES = ['lab.js', 'sim.js', 'detmath.js', 'roles.js', 'worm.js', 'text.js', 'glyphs.js', 'body.js', 'lamp.js', 'cilia.js', 'model.js', 'data.js'];

/**
 * What a set of lab results depends on, as hashes. Also used by scripts/lab.js, so the command line
 * and the server print the same identifiers.
 * @param {{root?: string, scrambles?: number}} opts
 */
export function labIdentity({ root = ROOT, scrambles } = {}) {
  const wiringRaw = fs.readFileSync(path.join(root, 'data', 'wiring.json'));
  const txRaw = fs.readFileSync(path.join(root, 'data', 'transmitters.json'));
  const code = crypto.createHash('sha256');
  for (const f of LAB_CODE_FILES) code.update(`${f}\n${sha256(fs.readFileSync(path.join(SHARED, f)))}\n`);
  const key = {
    labVersion: LAB_VERSION,
    protocolSha256: sha256(protocolJson()),
    wiringSha256: sha256(wiringRaw),
    transmittersSha256: sha256(txRaw),
    codeSha256: code.digest('hex'),
    scrambles: scrambles ?? 'registered',
  };
  const protocolSha256s = Object.fromEntries(PROTOCOLS.map((p) => [p.id, sha256(canonicalJson(p))]));
  return { key, protocolSha256s, wiringRaw, txRaw };
}

/** SHA-256 of the canonical JSON of the results array: equal on every machine that reproduces the lab. */
export const resultsSha256 = (results) => sha256(canonicalJson(results));

const handles = new Map();   // one lab per cache file (or per root when there is no cache): the worker runs at most once

/**
 * Start (or reuse) the lab.
 * @param {{root?: string, logDir?: string|null, logger?: Console, onDone?: (results: object) => void,
 *          scrambles?: number, unref?: boolean}} opts
 *   root    project folder (data/wiring.json); defaults to this repository
 *   logDir  where lab-results.json is cached; defaults to $LOG_DIR or 'var' under root; null = no cache
 *   onDone  called once with the results (also when they come from the cache)
 *   unref   let the process exit while the worker is still running (default true)
 * @returns {{status: () => object, results: () => object|null, ready: Promise<object>, stop: () => Promise<void>}}
 */
export function startLab({ root = ROOT, logDir, logger = console, onDone = () => {}, scrambles, unref = true } = {}) {
  const dir = logDir === undefined ? path.resolve(root, process.env.LOG_DIR || 'var') : logDir;
  const file = dir ? path.join(dir, 'lab-results.json') : null;
  const slot = file || `memory:${path.resolve(root)}:${scrambles ?? ''}`;
  const existing = handles.get(slot);
  if (existing) { existing.listen(onDone); return existing.handle; }

  const { key, protocolSha256s, wiringRaw, txRaw } = labIdentity({ root, scrambles });
  const listeners = [onDone];
  let state = 'running', progress = { fraction: 0 }, results = null, error = null, cached = false;
  let startedAt = new Date().toISOString(), finishedAt = null, worker = null;
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});   // failures are reported through status(); nobody has to await this

  const finish = (r) => {
    results = r; state = 'done'; progress = { fraction: 1 }; finishedAt = r.computedAt || new Date().toISOString();
    resolveReady(r);
    for (const fn of listeners.splice(0)) { try { fn(r); } catch (e) { logger.warn(`[lab] onDone failed: ${e.message}`); } }
  };
  const fail = (msg) => {
    if (state !== 'running') return;
    state = 'error'; error = msg; finishedAt = new Date().toISOString();
    logger.warn(`[lab] failed: ${msg}`);
    rejectReady(new Error(msg));
  };

  // 1. cached results with exactly the same key
  if (file) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (c && c.key && canonicalJson(c.key) === canonicalJson(key) && Array.isArray(c.results)) {
        cached = true; startedAt = c.startedAt || null;
        setImmediate(() => finish(c));   // async, so the caller has its handle before onDone runs
      }
    } catch { /* no cache yet, or unreadable: recompute */ }
  }

  // 2. otherwise compute in a worker, once
  if (!cached) {
    const t0 = Date.now();
    // execArgv: [] so flags meant for the parent (--input-type, --watch, -e ...) don't break the worker
    worker = new Worker(new URL('./lab-worker.js', import.meta.url), { workerData: { wiring: new Uint8Array(wiringRaw), transmitters: new Uint8Array(txRaw), scrambles }, execArgv: [] });
    if (unref) worker.unref();
    logger.log(`[lab] running ${PROTOCOLS.length} registered experiments in a worker (protocols ${key.protocolSha256.slice(0, 12)}…)`);
    worker.on('message', (m) => {
      if (m.type === 'progress') progress = m.progress;
      else if (m.type === 'error') fail(m.message);
      else if (m.type === 'done') {
        const r = {
          ...m.lab,   // labVersion, protocolJson, model, wiring, scrambles, results
          key, protocolSha256: key.protocolSha256, wiringSha256: key.wiringSha256, codeSha256: key.codeSha256,
          protocolSha256s, resultsSha256: resultsSha256(m.lab.results),
          startedAt, computedAt: new Date().toISOString(), workerMs: Math.round(m.ms), wallMs: Date.now() - t0,
        };
        if (file) {
          try {
            fs.mkdirSync(dir, { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(r));
            fs.renameSync(tmp, file);
          } catch (e) { logger.warn(`[lab] could not cache results: ${e.message}`); }
        }
        const v = r.results.map((x) => `${x.id} ${x.verdict}`).join(', ');
        logger.log(`[lab] done in ${(r.wallMs / 1000).toFixed(1)} s: ${v}`);
        finish(r);
      }
    });
    worker.on('error', (e) => fail(e && e.stack ? e.stack : String(e)));
    worker.on('exit', (code) => { worker = null; if (state === 'running') fail(`worker exited with code ${code}`); });
  }

  const handle = {
    status: () => ({
      state, cached, progress, error, startedAt, finishedAt,
      key, protocolSha256s,
      verdicts: results ? results.results.map((x) => ({ id: x.id, verdict: x.verdict })) : null,
    }),
    results: () => results,
    ready,
    stop: async () => {
      if (state === 'running') { state = 'stopped'; finishedAt = new Date().toISOString(); rejectReady(new Error('lab stopped')); }
      if (worker) { const w = worker; worker = null; await w.terminate(); }
    },
  };
  handles.set(slot, { handle, listen: (fn) => { if (state === 'done') setImmediate(() => fn(results)); else if (state === 'running') listeners.push(fn); } });
  return handle;
}

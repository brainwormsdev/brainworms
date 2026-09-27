// The public event log, cut into chunks (hourly by default). Each chunk starts with the worm's exact
// state (a checkpoint) so it can be replayed on its own, and ends with a hash of the state it left.
// Sealed chunks are chained: a small proof file names the chunk's SHA-256 and the previous proof's
// SHA-256, and that proof file's hash is timestamped into Bitcoin through OpenTimestamps.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encodeSnapshot } from '../shared/state.js';
import { PARAMS } from '../shared/sim.js';
import { LOG_VERSION } from '../shared/replay.js';

export { LOG_VERSION };
export const LOG_NAME = /^events-[0-9TZ-]+(-c\d{4})?\.jsonl$/;
export const PROOF_NAME = /^events-[0-9TZ-]+-c\d{4}\.txt(\.ots)?$/;
export const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Queued messages are left out of a checkpoint: they're logged, as inputs, when they start playing.
export const checkpointState = (worm) => encodeSnapshot({ ...worm.snapshot(), queue: [] });
export const stateSha = (enc) => sha256hex(JSON.stringify(enc));

export function createLedger({ dir, worm, wiringSha256, transmittersSha256 = null, chunkMs = 3600e3, ots = null, logger = console, onSealed = () => {}, onUpgraded = () => {} }) {
  const proofDir = path.join(dir, 'proof');
  fs.mkdirSync(proofDir, { recursive: true });
  const run = new Date().toISOString().replace(/[:.]/g, '-');
  const chainFile = path.join(proofDir, 'chain.jsonl');
  const chain = [];
  try { for (const l of fs.readFileSync(chainFile, 'utf8').split('\n')) if (l) chain.push(JSON.parse(l)); } catch { /* new chain */ }
  const pending = new Set();
  const otsCache = new Map();   // proof file -> {mtimeMs, summary}
  let chunk = -1, fd = null, name = null, fromStep = 0, fromTs = 0, lines = 0, nextCutAt = 0, closed = false;

  function write(o) { if (fd !== null) { fs.writeSync(fd, JSON.stringify(o) + '\n'); lines++; } }

  function open(state) {
    chunk++;
    name = `events-${run}-c${String(chunk).padStart(4, '0')}.jsonl`;
    fd = fs.openSync(path.join(dir, name), 'a');
    fromStep = worm.step; fromTs = Date.now(); lines = 0; nextCutAt = fromTs + chunkMs;
    const head = { v: LOG_VERSION, run, chunk, ts: fromTs, step: worm.step, params: PARAMS, wiringSha256, transmittersSha256 };
    write(state
      ? { k: 'checkpoint', ...head, prevLogSha256: chain.at(-1)?.logSha256 ?? null, stateSha256: stateSha(state), state }
      : { k: 'boot', ...head });
  }

  function seal() {
    const state = checkpointState(worm), endSha = stateSha(state), toTs = Date.now();
    write({ k: 'end', step: worm.step, ts: toTs, stateSha256: endSha });
    fs.closeSync(fd); fd = null;
    const logSha256 = sha256hex(fs.readFileSync(path.join(dir, name)));
    const prev = chain.at(-1)?.chainSha256 ?? 'genesis';
    const proof = name.replace(/\.jsonl$/, '.txt');
    const text = [
      'brainworm proof v1',
      `log ${name}`,
      `log-sha256 ${logSha256}`,
      `steps ${fromStep}-${worm.step}`,
      `time ${new Date(fromTs).toISOString()} ${new Date(toTs).toISOString()}`,
      `end-state-sha256 ${endSha}`,
      `prev ${prev}`,
      '',
    ].join('\n');
    const chainSha256 = sha256hex(text);
    fs.writeFileSync(path.join(proofDir, proof), text);
    const entry = { n: chain.length, run, chunk, log: name, proof, from: fromStep, to: worm.step, fromTs, toTs, events: lines, logSha256, endStateSha256: endSha, chainSha256, prev };
    chain.push(entry);
    fs.appendFileSync(chainFile, JSON.stringify(entry) + '\n');
    if (ots) track(stamp(entry));
    onSealed(entry);
    return state;
  }

  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); };

  async function stamp(entry) {
    try {
      const digest = Buffer.from(entry.chainSha256, 'hex');
      const { timestamp, calendar } = await ots.submitDigest(digest);
      fs.writeFileSync(path.join(proofDir, entry.proof + '.ots'), ots.makeOtsFile(digest, timestamp));
      logger.log(`proof ${entry.proof} timestamped via ${calendar}`);
      onUpgraded(entry);
    } catch (e) { logger.warn(`OpenTimestamps: ${e.message}`); }
  }

  // Calendars fold our digest into a Bitcoin transaction within a few hours; fetch that upgrade.
  async function upgradeAll() {
    for (const e of chain.slice(-300)) {
      const f = path.join(proofDir, e.proof + '.ots');
      let buf;
      try { buf = fs.readFileSync(f); } catch {
        if (Date.now() - e.toTs < 48 * 3600e3) await stamp(e);
        continue;
      }
      try {
        if (ots.summarizeOts(buf).bitcoin.length || Date.now() - e.toTs < 1800e3) continue;
        const u = await ots.upgradeOts(buf);
        if (u.changed) { fs.writeFileSync(f, u.buf); onUpgraded(e); }
      } catch (err) { logger.warn(`OpenTimestamps upgrade ${e.proof}: ${err.message}`); }
    }
  }
  const upgradeTimer = ots ? setInterval(() => track(upgradeAll()), 20 * 60e3) : null;
  upgradeTimer?.unref?.();

  function otsStatus(proof) {
    if (!ots) return null;
    const f = path.join(proofDir, proof + '.ots');
    let st; try { st = fs.statSync(f); } catch { return { state: 'none' }; }
    const c = otsCache.get(proof);
    if (c && c.mtimeMs === st.mtimeMs) return c.summary;
    let summary;
    try {
      const s = ots.summarizeOts(fs.readFileSync(f));
      summary = s.bitcoin.length ? { state: 'bitcoin', height: Math.min(...s.bitcoin) } : { state: 'pending', calendars: s.pending.length };
    } catch { summary = { state: 'invalid' }; }
    otsCache.set(proof, { mtimeMs: st.mtimeMs, summary });
    return summary;
  }

  open(null);

  return {
    run,
    write,
    /** Cut a new chunk if this one is old enough. Call between simulation steps. */
    maybeCut(now = Date.now()) { if (!closed && now >= nextCutAt) open(seal()); },
    cutNow() { if (!closed) open(seal()); },
    get currentName() { return name; },
    get currentPath() { return path.join(dir, name); },
    filePath: (n) => (LOG_NAME.test(n) ? path.join(dir, n) : null),
    proofPath: (n) => (PROOF_NAME.test(n) ? path.join(proofDir, n) : null),
    /** Latest proofs, newest first. */
    proofs(limit = 48) {
      return chain.slice(-limit).reverse().map((e) => ({ ...e, ots: otsStatus(e.proof) }));
    },
    get chainLength() { return chain.length; },
    /** Log files on disk, newest first. */
    files() {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => LOG_NAME.test(n)); } catch { /* no dir */ }
      return names.sort().reverse().slice(0, 500).map((n) => {
        let size = 0; try { size = fs.statSync(path.join(dir, n)).size; } catch { /* raced */ }
        return { name: n, size, current: n === name };
      });
    },
    /** Seal the open chunk (e.g. on shutdown) and wait briefly for its timestamp. */
    async close(waitMs = 5000) {
      if (closed) return;
      closed = true;
      clearInterval(upgradeTimer);
      seal();
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
    },
  };
}

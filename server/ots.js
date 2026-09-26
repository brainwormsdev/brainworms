// OpenTimestamps client: timestamp a SHA-256 digest on the public calendars (free, anchored in
// Bitcoin), read/write detached .ots proofs and upgrade pending proofs once a block confirms them.
// Binary format matches python-opentimestamps (opentimestamps/core/{serialize,op,notary,timestamp}.py).
import crypto from 'node:crypto';

export const CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
];

const HEADER_MAGIC = Buffer.concat([Buffer.from('\0OpenTimestamps\0\0Proof\0', 'latin1'), Buffer.from('bf89e2e884e89294', 'hex')]);
const HEADERS = { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'brainworm' };
const TAG = { pending: '83dfe30d2ef90c8e', bitcoin: '0588960d73d71901' };   // litecoin etc. stay 'unknown'
const MAX_MSG = 4096, MAX_PAYLOAD = 8192, MAX_URI = 1000, MAX_DEPTH = 256, MAX_RESPONSE = 10000;
const URI_OK = /^[A-Za-z0-9._/:-]*$/;   // python-opentimestamps PendingAttestation.ALLOWED_URI_CHARS

const hash = (alg) => (m) => crypto.createHash(alg).update(m).digest();
const OPS = {
  0x02: { name: 'sha1', fn: hash('sha1') },
  0x03: { name: 'ripemd160', fn: hash('ripemd160') },
  0x08: { name: 'sha256', fn: hash('sha256') },
  0xf0: { name: 'append', binary: true, fn: (m, a) => Buffer.concat([m, a]) },
  0xf1: { name: 'prepend', binary: true, fn: (m, a) => Buffer.concat([a, m]) },
  0xf2: { name: 'reverse', fn: (m) => Buffer.from(m).reverse() },
  0xf3: { name: 'hexlify', fn: (m) => Buffer.from(m.toString('hex'), 'latin1'), maxMsg: MAX_MSG / 2 },
};
const OP_TAG = Object.fromEntries(Object.entries(OPS).map(([tag, o]) => [o.name, Number(tag)]));

const fail = (msg) => { throw new Error(`ots: ${msg}`); };
const toBuf = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b));
const toDigest = (d) => (d instanceof Uint8Array && d.length === 32 ? Buffer.from(d) : fail('digest must be 32 bytes'));

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  bytes(n) {
    if (this.pos + n > this.buf.length) fail('truncated');
    return Buffer.from(this.buf.subarray(this.pos, (this.pos += n)));
  }
  byte() { return this.bytes(1)[0]; }
  // LEB128; non-minimal encodings are rejected so that parse → serialize is byte-exact
  varuint() {
    let v = 0, mul = 1;
    for (let first = true; ; first = false, mul *= 128) {
      if (mul > 2 ** 49) fail('varuint too large');
      const b = this.byte();
      v += (b & 0x7f) * mul;
      if (v > Number.MAX_SAFE_INTEGER) fail('varuint too large');
      if (!(b & 0x80)) { if (!b && !first) fail('non-minimal varuint'); return v; }
    }
  }
  varbytes(max, min = 0) {
    const n = this.varuint();
    if (n > max || n < min) fail(`varbytes length ${n} out of range`);
    return this.bytes(n);
  }
  end() { if (this.pos !== this.buf.length) fail('trailing bytes'); }
}

function varuint(n) {
  if (!Number.isSafeInteger(n) || n < 0) fail(`bad varuint ${n}`);
  const out = [];
  do { const b = n % 128; n = Math.floor(n / 128); out.push(n ? b | 0x80 : b); } while (n);
  return Buffer.from(out);
}
const varbytes = (b) => Buffer.concat([varuint(b.length), b]);

function applyOp(o, msg, arg) {
  if (msg.length > (o.maxMsg || MAX_MSG)) fail(`message too long for ${o.name}`);
  const r = o.fn(msg, arg);
  if (!r.length || r.length > MAX_MSG) fail(`bad ${o.name} result length ${r.length}`);
  return r;
}

function readAttestation(r) {
  const tag = r.bytes(8).toString('hex');
  const payload = r.varbytes(MAX_PAYLOAD);   // the attestation's own encoding is nested inside this
  if (tag !== TAG.pending && tag !== TAG.bitcoin) return { type: 'unknown', tag, payload };
  const p = new Reader(payload);
  let a;
  if (tag === TAG.bitcoin) a = { type: 'bitcoin', height: p.varuint() };
  else {
    const uri = p.varbytes(MAX_URI).toString('latin1');
    if (!URI_OK.test(uri)) fail(`invalid calendar URI ${JSON.stringify(uri)}`);
    a = { type: 'pending', uri };
  }
  p.end();
  return a;
}

// Items: attestations (0x00 + tag + varbytes payload) then ops (tag [+ varbytes arg] + child);
// every item but the last is prefixed by 0xff.
function readTimestamp(r, msg, depth = 0) {
  if (depth >= MAX_DEPTH) fail('timestamp too deep');
  const node = { msg, attestations: [], ops: [] };
  for (let more = true; more;) {
    let tag = r.byte();
    if ((more = tag === 0xff)) tag = r.byte();
    if (tag === 0x00) {
      // python-opentimestamps always writes attestations first; anything else could not round-trip
      if (node.ops.length) fail('attestation after op');
      node.attestations.push(readAttestation(r));
      continue;
    }
    const o = OPS[tag] || fail(tag === 0x67 ? 'unsupported op keccak256' : `unknown op 0x${tag.toString(16)}`);
    const arg = o.binary ? r.varbytes(MAX_MSG, 1) : undefined;
    const child = readTimestamp(r, applyOp(o, msg, arg), depth + 1);
    node.ops.push(o.binary ? { op: o.name, arg, child } : { op: o.name, child });
  }
  return node;
}

function attestationBytes(a) {
  let tag, payload;
  if (a.type === 'pending') {
    if (!URI_OK.test(a.uri) || a.uri.length > MAX_URI) fail(`invalid calendar URI ${JSON.stringify(a.uri)}`);
    [tag, payload] = [TAG.pending, varbytes(Buffer.from(a.uri, 'latin1'))];
  } else if (a.type === 'bitcoin') [tag, payload] = [TAG.bitcoin, varuint(a.height)];
  else [tag, payload] = [a.tag, toBuf(a.payload)];
  return Buffer.concat([Buffer.from([0]), Buffer.from(tag, 'hex'), varbytes(payload)]);
}

function writeTimestamp(node, out) {
  const n = node.attestations.length + node.ops.length;
  if (!n) fail('empty timestamp');
  let i = 0;
  const sep = () => { if (++i < n) out.push(Buffer.from([0xff])); };
  for (const a of node.attestations) { sep(); out.push(attestationBytes(a)); }
  for (const { op, arg, child } of node.ops) {
    sep();
    const tag = OP_TAG[op] ?? fail(`unknown op ${op}`);
    out.push(Buffer.from([tag]));
    if (OPS[tag].binary) out.push(varbytes(toBuf(arg)));
    writeTimestamp(child, out);
  }
  return out;
}

export function parseTimestamp(bytes, msg) {
  const r = new Reader(toBuf(bytes));
  const node = readTimestamp(r, Buffer.from(msg));
  r.end();
  return node;
}

export function serializeTimestamp(node) {
  return Buffer.concat(writeTimestamp(node, []));
}

export function parseOts(buf) {
  const r = new Reader(toBuf(buf));
  if (!r.bytes(HEADER_MAGIC.length).equals(HEADER_MAGIC)) fail('not an OpenTimestamps proof');
  const major = r.varuint();
  if (major !== 1) fail(`unsupported major version ${major}`);
  if (r.byte() !== 0x08) fail('only sha256 file digests are supported');
  const digest = r.bytes(32);
  const timestamp = readTimestamp(r, digest);
  r.end();
  return { digest, timestamp };
}

export function serializeOts({ digest, timestamp }) {
  return Buffer.concat([HEADER_MAGIC, varuint(1), Buffer.from([0x08]), toDigest(digest), serializeTimestamp(timestamp)]);
}

export function makeOtsFile(digest, timestampBytes) {
  digest = toDigest(digest);
  parseTimestamp(timestampBytes, digest);   // refuse to write a proof we could not read back
  return Buffer.concat([HEADER_MAGIC, varuint(1), Buffer.from([0x08]), digest, toBuf(timestampBytes)]);
}

function walk(node, fn) { fn(node); for (const o of node.ops) walk(o.child, fn); }
const hasBitcoin = (n) => n.attestations.some((a) => a.type === 'bitcoin') || n.ops.some((o) => hasBitcoin(o.child));

export function summarizeOts(buf) {
  const pending = new Set(), bitcoin = new Set();
  walk(parseOts(buf).timestamp, (n) => {
    for (const a of n.attestations) {
      if (a.type === 'pending') pending.add(a.uri);
      else if (a.type === 'bitcoin') bitcoin.add(a.height);
    }
  });
  return { pending: [...pending], bitcoin: [...bitcoin].sort((a, b) => a - b) };
}

// Canonical order (as python-opentimestamps sorts): attestations by tag then uri/height/payload,
// ops by tag then argument.
function cmpAtt(a, b) {
  const ta = TAG[a.type] || a.tag, tb = TAG[b.type] || b.tag;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.type === 'pending') return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
  if (a.type === 'bitcoin') return a.height - b.height;
  return Buffer.compare(a.payload, b.payload);
}
const cmpOp = (a, b) => OP_TAG[a.op] - OP_TAG[b.op] || (a.arg ? Buffer.compare(a.arg, b.arg) : 0);

function merge(dst, src) {
  for (const a of src.attestations) if (!dst.attestations.some((b) => !cmpAtt(a, b))) dst.attestations.push(a);
  for (const o of src.ops) {
    const mine = dst.ops.find((p) => !cmpOp(p, o));
    if (mine) merge(mine.child, o.child); else dst.ops.push(o);
  }
  dst.attestations.sort(cmpAtt);
  dst.ops.sort(cmpOp);
}

async function readBody(res) {
  const b = Buffer.from(await res.arrayBuffer());
  if (b.length > MAX_RESPONSE) fail('calendar response too large');
  return b;
}

const why = (e) => (e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message.replace(/^ots: /, ''));

export async function submitDigest(digest, { calendars = CALENDARS, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  digest = toDigest(digest);
  const errors = [];
  for (const calendar of calendars) {
    try {
      const res = await fetchImpl(`${calendar}/digest`, {
        method: 'POST', body: digest, signal: AbortSignal.timeout(timeoutMs),
        headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (res.status !== 200) { res.body?.cancel().catch(() => {}); fail(`HTTP ${res.status}`); }
      const timestamp = await readBody(res);
      parseTimestamp(timestamp, digest);
      return { calendar, timestamp };
    } catch (e) { errors.push(`${calendar}: ${why(e)}`); }
  }
  throw new Error(`ots: all calendars failed (${errors.join('; ')})`);
}

export async function upgradeOts(buf, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const input = toBuf(buf), parsed = parseOts(input), todo = [];
  walk(parsed.timestamp, (node) => { for (const a of node.attestations) if (a.type === 'pending') todo.push({ node, a }); });
  // Ask every calendar in parallel; 404 (not in a block yet), network errors and bad bodies are just "no news".
  const found = await Promise.all(todo.map(async ({ node, a }) => {
    if (!/^https?:\/\//.test(a.uri)) return null;
    try {
      const res = await fetchImpl(`${a.uri}/timestamp/${node.msg.toString('hex')}`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) { res.body?.cancel().catch(() => {}); return null; }
      return parseTimestamp(await readBody(res), node.msg);
    } catch { return null; }
  }));
  todo.forEach(({ node, a }, i) => {
    if (!found[i]) return;
    merge(node, found[i]);
    if (hasBitcoin(node)) node.attestations = node.attestations.filter((x) => x !== a);
  });
  const out = serializeOts(parsed);
  return out.equals(input) ? { changed: false, buf: input } : { changed: true, buf: out };
}

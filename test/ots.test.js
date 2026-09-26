import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  CALENDARS, submitDigest, makeOtsFile, parseOts, serializeOts, parseTimestamp, serializeTimestamp, summarizeOts, upgradeOts,
} from '../server/ots.js';

// Fixtures are written as hex by hand; `vb` is a deliberately independent varbytes for short values.
const h = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p.replace(/\s+/g, ''), 'hex') : p)));
const vb = (b) => { assert.ok(b.length < 128); return Buffer.concat([Buffer.from([b.length]), b]); };
const sha256 = (...b) => crypto.createHash('sha256').update(Buffer.concat(b)).digest();
const MAGIC = '004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294';
const BTC = '00 0588960d73d71901', PENDING = '00 83dfe30d2ef90c8e';
const BLOCK = h(BTC, '03 f7ef15');   // bitcoin attestation, height 358391
const pending = (uri) => h(PENDING, vb(vb(Buffer.from(uri))));
const otsFile = (digest, ts) => h(MAGIC, '01 08', digest, ts);
const DIGEST = sha256(Buffer.from('talk to the worm'));
// root forks: append <i+1> → sha256 → pending(uri_i)
const fork = (uris) => h(...uris.map((u, i) => h(i < uris.length - 1 ? 'ff' : '', 'f0 01', Buffer.from([i + 1]), '08', pending(u))));

test('varuint: LEB128 edge cases as bitcoin heights, both directions', () => {
  const cases = [[0, '00'], [1, '01'], [127, '7f'], [128, '8001'], [300, 'ac02'], [16383, 'ff7f'], [16384, '808001'],
    [358391, 'f7ef15'], [2 ** 32, '8080808010'], [Number.MAX_SAFE_INTEGER, 'ffffffffffffff0f']];
  for (const [height, enc] of cases) {
    const bytes = h(BTC, vb(h(enc)));
    const ts = parseTimestamp(bytes, DIGEST);
    assert.deepEqual(ts.attestations, [{ type: 'bitcoin', height }]);
    assert.deepEqual(serializeTimestamp(ts), bytes, `height ${height}`);
  }
  const bad = (enc, re) => assert.throws(() => parseTimestamp(h(BTC, vb(h(enc))), DIGEST), re);
  bad('8000', /non-minimal varuint/);
  bad('ff80', /truncated/);
  bad('8080808080808010', /varuint too large/);   // 2^53
  bad('808080808080808001', /varuint too large/);
  assert.throws(() => serializeTimestamp({ msg: DIGEST, attestations: [{ type: 'bitcoin', height: -1 }], ops: [] }), /bad varuint/);
});

test('varbytes: lengths above 127 use multi-byte prefixes, including nested pending payloads', () => {
  const arg = crypto.randomBytes(200), uri = 'https://' + 'a'.repeat(192);   // 200 chars
  const bytes = h('f0 c801', arg, PENDING, 'ca01 c801', Buffer.from(uri));
  const ts = parseTimestamp(bytes, DIGEST);
  assert.deepEqual(ts.ops[0].arg, arg);
  assert.deepEqual(ts.ops[0].child.msg, h(DIGEST, arg));
  assert.deepEqual(ts.ops[0].child.attestations, [{ type: 'pending', uri }]);
  assert.deepEqual(serializeTimestamp(ts), bytes);
});

test('append → sha256 → pending attestation: messages follow the ops', () => {
  const nonce = Buffer.alloc(16, 0xab), uri = 'https://alice.btc.calendar.opentimestamps.org';
  const bytes = h('f0 10', nonce, '08', PENDING, '2e 2d', Buffer.from(uri));   // the payload is varbytes inside varbytes
  const ts = parseTimestamp(bytes, DIGEST);
  assert.deepEqual(ts.msg, DIGEST);
  assert.equal(ts.attestations.length, 0);
  assert.equal(ts.ops.length, 1);
  const [{ op, arg, child }] = ts.ops;
  assert.equal(op, 'append');
  assert.deepEqual(arg, nonce);
  assert.deepEqual(child.msg, h(DIGEST, nonce));
  assert.equal(child.ops[0].op, 'sha256');
  assert.equal('arg' in child.ops[0], false);
  assert.deepEqual(child.ops[0].child.msg, sha256(DIGEST, nonce));
  assert.deepEqual(child.ops[0].child.attestations, [{ type: 'pending', uri }]);
  assert.deepEqual(serializeTimestamp(ts), bytes);
});

test('forks (0xff), every supported op and unknown attestations round-trip exactly', () => {
  const [uri0, uri1, uri2] = ['https://zero.example', 'https://one.example', 'http://127.0.0.1:9/two'];
  const ts = h(
    'ff', BTC, '02 e807',                                  // bitcoin 1000
    'ff', pending(uri0),
    'ff 03 f2 f3', BTC, '01 05',                           // ripemd160 → reverse → hexlify → bitcoin 5
    'ff 08 00 0102030405060708 03', Buffer.from('xyz'),    // sha256 → unknown attestation
    'ff f0 01 aa 08', pending(uri1),                       // append → sha256 → pending
    'f1 02 bbcc 02', pending(uri2),                        // prepend → sha1 → pending (last item: no 0xff)
  );
  const file = otsFile(DIGEST, ts);
  const { digest, timestamp: root } = parseOts(file);
  assert.deepEqual(digest, DIGEST);
  assert.deepEqual(root.attestations, [{ type: 'bitcoin', height: 1000 }, { type: 'pending', uri: uri0 }]);
  assert.deepEqual(root.ops.map((o) => o.op), ['ripemd160', 'sha256', 'append', 'prepend']);

  const rip = crypto.createHash('ripemd160').update(DIGEST).digest();
  const rev = Buffer.from(rip).reverse();
  const [r, s, a, p] = root.ops;
  assert.deepEqual(r.child.msg, rip);
  assert.deepEqual(r.child.ops[0].child.msg, rev);
  assert.deepEqual(r.child.ops[0].child.ops[0].child.msg, Buffer.from(rev.toString('hex')));
  assert.deepEqual(s.child.msg, sha256(DIGEST));
  assert.deepEqual(s.child.attestations, [{ type: 'unknown', tag: '0102030405060708', payload: Buffer.from('xyz') }]);
  assert.deepEqual(a.child.ops[0].child.msg, sha256(DIGEST, h('aa')));
  assert.deepEqual(p.child.msg, h('bbcc', DIGEST));
  assert.deepEqual(p.child.ops[0].child.msg, crypto.createHash('sha1').update(h('bbcc', DIGEST)).digest());

  assert.deepEqual(serializeOts(parseOts(file)), file);
  assert.deepEqual(summarizeOts(file), { pending: [uri0, uri1, uri2], bitcoin: [5, 1000] });
});

test('a real calendar response (btc.calendar.catallaxy.com) parses, round-trips and yields the commitment', () => {
  const digest = h('963cbfdfad9bdb211c4c870d5d5810cf27c47c4422e5590f96e05522ed80cd7a');
  const ts = h('f0101f6933d35e2a8e608186f528027960ed08f02065ba39287b9fe3b65ef6fe53d251c2fdf61d7d0b8ace196fa598c35747b85689'
    + '08f1046ab82ceef00853e50b1baf7f7ab90083dfe30d2ef90c8e232268747470733a2f2f6274632e63616c656e6461722e636174616c6c6178792e636f6d');
  const file = makeOtsFile(digest, ts);
  assert.deepEqual(serializeOts(parseOts(file)), file);
  assert.deepEqual(summarizeOts(file), { pending: ['https://btc.calendar.catallaxy.com'], bitcoin: [] });
  let n = parseOts(file).timestamp;
  while (n.ops.length) n = n.ops[0].child;
  const inner = sha256(sha256(digest, h('1f6933d35e2a8e608186f528027960ed')), h('65ba39287b9fe3b65ef6fe53d251c2fdf61d7d0b8ace196fa598c35747b85689'));
  assert.deepEqual(n.msg, h('6ab82cee', inner, '53e50b1baf7f7ab9'));
});

test('malformed proofs are rejected', () => {
  const good = otsFile(DIGEST, h(BTC, '01 07'));
  assert.deepEqual(parseOts(good).timestamp.attestations, [{ type: 'bitcoin', height: 7 }]);
  const flip = Buffer.from(good); flip[5] ^= 1;
  assert.throws(() => parseOts(Buffer.alloc(0)), /truncated/);
  assert.throws(() => parseOts(flip), /not an OpenTimestamps proof/);
  assert.throws(() => parseOts(h(MAGIC, '02 08', DIGEST, BTC, '01 07')), /unsupported major version 2/);
  assert.throws(() => parseOts(h(MAGIC, '01 02', DIGEST, BTC, '01 07')), /only sha256/);
  assert.throws(() => parseOts(h(good, '00')), /trailing bytes/);
  assert.throws(() => parseOts(good.subarray(0, -1)), /truncated/);

  const bad = (hex, re, msg = DIGEST) => assert.throws(() => parseTimestamp(h(...[].concat(hex)), msg), re);
  bad('', /truncated/);
  bad(['42', BTC, '01 01'], /unknown op 0x42/);
  bad(['67', BTC, '01 01'], /unsupported op keccak256/);
  bad(['ff ff 08', BTC, '01 01'], /unknown op 0xff/);
  bad(['ff 08', BTC, '01 01', BTC, '01 02'], /attestation after op/);
  bad([PENDING, vb(vb(Buffer.from('https://bad uri')))], /invalid calendar URI/);
  bad([PENDING, vb(h(vb(Buffer.from('https://x')), '00'))], /trailing bytes/);
  bad([BTC, '02 0100'], /trailing bytes/);
  bad(['f0 00', BTC, '01 01'], /varbytes length 0 out of range/);
  bad(['f0 8020', Buffer.alloc(4096), BTC, '01 01'], /bad append result length 4128/);
  bad(['f2', BTC, '01 01'], /bad reverse result length 0/, Buffer.alloc(0));
  bad(['f3', BTC, '01 01'], /message too long for hexlify/, Buffer.alloc(2049));
  assert.throws(() => serializeTimestamp({ msg: DIGEST, attestations: [], ops: [] }), /empty timestamp/);
  assert.throws(() => makeOtsFile(DIGEST.subarray(1), h(BTC, '01 07')), /digest must be 32 bytes/);
  assert.throws(() => makeOtsFile(DIGEST, h('08')), /truncated/);
});

test('recursion depth limit matches python-opentimestamps (255 nested ops)', () => {
  const chain = (n) => h('08'.repeat(n), BTC, '01 01');
  let n = parseTimestamp(chain(255), DIGEST), m = DIGEST;
  for (let i = 0; i < 255; i++) { m = sha256(m); n = n.ops[0].child; }
  assert.deepEqual(n.msg, m);
  assert.throws(() => parseTimestamp(chain(256), DIGEST), /too deep/);
});

test('makeOtsFile writes the detached-file header, version 1, sha256 tag and digest', () => {
  const ts = h(BTC, '01 07');
  const file = makeOtsFile(DIGEST, ts);
  assert.equal(file.subarray(0, 31).toString('hex'), MAGIC);
  assert.deepEqual(file, h(MAGIC, '01', '08', DIGEST, ts));
});

// ---- fake calendars ----

async function fakeCalendar(handle) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      handle(req, body, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, hits,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}
const send = (res, status, body) => { res.writeHead(status); res.end(body); };
const deadUrl = async () => { const c = await fakeCalendar(() => {}); await c.close(); return c.url; };

test('submitDigest falls back past broken calendars; upgradeOts turns pending into a bitcoin block height', async () => {
  const nonce = h('0102030405060708'), sib1 = crypto.randomBytes(32), sib2 = crypto.randomBytes(32);
  const commitment = sha256(DIGEST, nonce);
  const upgrade = h('f1 20', sib1, '08 f0 20', sib2, '08', BLOCK);
  let confirmed = false;
  const good = await fakeCalendar((req, body, res) => {
    if (req.method === 'POST' && req.url === '/digest') return send(res, 200, h('f0 08', nonce, '08', pending(good.url)));
    if (req.method === 'GET' && req.url === `/timestamp/${commitment.toString('hex')}` && confirmed) return send(res, 200, upgrade);
    send(res, 404, 'Pending confirmation in Bitcoin blockchain');
  });
  const e500 = await fakeCalendar((req, body, res) => send(res, 500, 'oops'));
  const hang = await fakeCalendar(() => {});
  const junk = await fakeCalendar((req, body, res) => send(res, 200, 'not a timestamp'));
  const dead = await deadUrl();
  try {
    const opts = { timeoutMs: 300 };
    const r = await submitDigest(DIGEST, { ...opts, calendars: [e500.url, hang.url, junk.url, dead, good.url] });
    assert.equal(r.calendar, good.url);
    assert.deepEqual(r.timestamp, h('f0 08', nonce, '08', pending(good.url)));
    const [post] = good.hits;
    assert.equal(post.method, 'POST');
    assert.deepEqual(post.body, DIGEST);
    assert.equal(post.headers.accept, 'application/vnd.opentimestamps.v1');
    assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(post.headers['user-agent'], 'brainworm');
    assert.equal(e500.hits.length + hang.hits.length + junk.hits.length, 3);

    await assert.rejects(submitDigest(DIGEST, { ...opts, calendars: [e500.url, hang.url, junk.url, dead] }), (e) => {
      assert.match(e.message, /all calendars failed/);
      assert.match(e.message, new RegExp(`${e500.url}: HTTP 500`));
      assert.match(e.message, new RegExp(`${hang.url}: timed out`));
      assert.match(e.message, new RegExp(`${junk.url}: unknown op 0x6e`));   // 'n' of 'not a timestamp'
      assert.match(e.message, new RegExp(`${dead}: ECONNREFUSED`));
      return true;
    });
    await assert.rejects(submitDigest(DIGEST.subarray(1)), /digest must be 32 bytes/);

    const file = makeOtsFile(DIGEST, r.timestamp);
    assert.deepEqual(summarizeOts(file), { pending: [good.url], bitcoin: [] });

    const before = await upgradeOts(file, opts);   // calendar says 404: still pending
    assert.equal(before.changed, false);
    assert.equal(before.buf, file);
    const get = good.hits.at(-1);
    assert.equal(get.method, 'GET');
    assert.equal(get.url, `/timestamp/${commitment.toString('hex')}`);
    assert.equal(get.headers.accept, 'application/vnd.opentimestamps.v1');

    confirmed = true;
    const after = await upgradeOts(file, opts);
    assert.equal(after.changed, true);
    assert.deepEqual(summarizeOts(after.buf), { pending: [], bitcoin: [358391] });
    // pending attestation replaced by the calendar's path to the block
    assert.deepEqual(after.buf, otsFile(DIGEST, h('f0 08', nonce, '08', upgrade)));
    let n = parseOts(after.buf).timestamp;
    while (n.ops.length) n = n.ops[0].child;
    assert.deepEqual(n.msg, sha256(sha256(sib1, commitment), sib2));
    assert.deepEqual(serializeOts(parseOts(after.buf)), after.buf);

    const hits = good.hits.length, again = await upgradeOts(after.buf, opts);
    assert.equal(again.changed, false);
    assert.equal(good.hits.length, hits);   // nothing pending, nothing fetched
  } finally {
    await Promise.all([good, e500, hang, junk].map((c) => c.close()));
  }
});

test('upgradeOts: one calendar confirms, others 404 / hang / fail / return junk', async () => {
  const yes = await fakeCalendar((req, body, res) => send(res, 200, h('08', BLOCK)));
  const no = await fakeCalendar((req, body, res) => send(res, 404, 'Pending confirmation in Bitcoin blockchain'));
  const hang = await fakeCalendar(() => {});
  const junk = await fakeCalendar((req, body, res) => send(res, 200, h('08')));
  const dead = await deadUrl();
  try {
    const others = [no.url, hang.url, junk.url, dead];
    const quiet = await upgradeOts(otsFile(DIGEST, fork(others)), { timeoutMs: 300 });
    assert.equal(quiet.changed, false);
    assert.deepEqual(quiet.buf, otsFile(DIGEST, fork(others)));

    const file = otsFile(DIGEST, fork([...others, yes.url]));
    const { changed, buf } = await upgradeOts(file, { timeoutMs: 300 });
    assert.equal(changed, true);
    assert.deepEqual(summarizeOts(buf), { pending: others, bitcoin: [358391] });
    const yesNode = parseOts(buf).timestamp.ops.at(-1).child.ops[0].child;
    assert.deepEqual(yesNode.attestations, []);
    assert.equal(yesNode.ops[0].op, 'sha256');
    assert.deepEqual(yesNode.ops[0].child.msg, sha256(sha256(DIGEST, h('05'))));
    assert.deepEqual(serializeOts(parseOts(buf)), buf);
  } finally {
    await Promise.all([yes, no, hang, junk].map((c) => c.close()));
  }
});

// ---- live: OTS_LIVE=1 node --test test/ots.test.js ----

test('live: a real calendar timestamps a random digest', { skip: process.env.OTS_LIVE !== '1' && 'set OTS_LIVE=1 to use the public calendars', timeout: 120000 }, async (t) => {
  const digest = crypto.randomBytes(32);
  const { calendar, timestamp } = await submitDigest(digest);
  assert.ok(CALENDARS.includes(calendar));
  const file = makeOtsFile(digest, timestamp);
  const parsed = parseOts(file);
  assert.deepEqual(parsed.digest, digest);
  assert.deepEqual(serializeOts(parsed), file);
  const summary = summarizeOts(file);
  assert.ok(summary.pending.length >= 1);
  assert.ok(summary.pending.every((u) => u.startsWith('https://')));
  assert.deepEqual(summary.bitcoin, []);
  const up = await upgradeOts(file);   // brand new: calendar answers 404 "Pending confirmation"
  assert.equal(up.changed, false);
  assert.equal(up.buf, file);
  t.diagnostic(`calendar ${calendar}; timestamp ${timestamp.length} B; .ots ${file.length} B; ${JSON.stringify(summary)}`);
});

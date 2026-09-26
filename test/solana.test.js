import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  b58encode, b58decode, isAddress, generateKeypair, verifySignature, findProgramAddress, pumpSwapPool, parseTransaction, signPartial,
  verifyTransactionSignatures, pumpCreateTx, prepareLaunch, uploadPumpMetadata, uploadPinataMetadata, normalizeTrade, tradesFromLogs,
  createTradeStream, createRpcTradeStream, rpc, confirmLaunch,
  PUMP_PROGRAM, PUMP_AMM_PROGRAM, WSOL_MINT, TRADE_LOCAL_URL, DATA_WS_URL, RPC_WS_URL,
} from '../server/solana.js';

const quiet = { log() {}, warn() {} };
const FIXTURES = new URL('./fixtures/', import.meta.url);
const fixture = (name) => fs.readFileSync(new URL(name, FIXTURES));
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const PUMPPORTAL_ROUTER = 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe';   // wraps the dev buy (PumpPortal's 0.5% fee)
// PumpPortal's answer to subscribeTokenTrade without a funded API key (seen live, 2026-09-26)
const NO_KEY = "'subscribeTokenTrade' and 'subscribeAccountTrade' methods are only available when connecting with an API key funded with at least 0.02 SOL.";

const hex = (...parts) => new Uint8Array(Buffer.from(parts.join('').replace(/\s+/g, ''), 'hex'));
const rnd = () => b58encode(crypto.randomBytes(32));
const BLOCKHASH = rnd();

// An independent little transaction writer, so the parser is checked against bytes it didn't produce.
const sv = (n) => { const out = []; do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>= 7; } while (n); return Buffer.from(out); };
const key = (k) => Buffer.from(typeof k === 'string' ? b58decode(k) : k.publicKey);
function message({ v0 = false, header, keys, blockhash = BLOCKHASH, ixs = [], lookups = [] }) {
  const parts = [v0 ? [0x80] : [], header, sv(keys.length), ...keys.map(key), key(blockhash), sv(ixs.length)];
  for (const [program, accounts, data] of ixs) parts.push([program], sv(accounts.length), accounts, sv(data.length), data);
  if (v0) {
    parts.push(sv(lookups.length));
    for (const [table, writable, readonly] of lookups) parts.push(key(table), sv(writable.length), writable, sv(readonly.length), readonly);
  }
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}
const wire = (msg, sigs) => new Uint8Array(Buffer.concat([sv(sigs.length), ...sigs, msg]));
const blank = (n) => Array.from({ length: n }, () => new Uint8Array(64));

async function until(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---- base58 and keys ----

test('base58: Bitcoin Core vectors, leading zeros, round trips, bad input', () => {
  const vectors = [
    ['', ''], ['61', '2g'], ['626262', 'a3gV'], ['636363', 'aPEr'],
    ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
    ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
    ['516b6fcd0f', 'ABnLTmg'], ['bf4f89001e670274dd', '3SEo3LWLoPntC'], ['572e4794', '3EFU7m'],
    ['ecac89cad93923c02321', 'EJDM8drfXA6uyA'], ['10c8511e', 'Rt5zm'], ['00000000000000000000', '1111111111'],
    ['000111d38e5fc9071ffcd20b4a763cc9ae4f252bb4e48fd66a835e252ada93ff480d6dd43dc62a641155a5', '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'],
    ['00'.repeat(32), SYSTEM],
  ];
  for (const [h, s] of vectors) {
    assert.equal(b58encode(hex(h)), s, h);
    assert.deepEqual(b58decode(s), hex(h), s);
  }
  assert.equal(b58encode(Buffer.from('00ff', 'hex')), '15Q');   // Buffers and ArrayBuffers are fine too
  assert.equal(b58encode(hex('00ff').buffer), '15Q');
  for (let i = 0; i < 300; i++) {
    const b = new Uint8Array(Buffer.concat([Buffer.alloc(i % 4), crypto.randomBytes(i % 70)]));
    const s = b58encode(b);
    assert.match(s, i % 70 ? /^1*[1-9A-HJ-NP-Za-km-z]+$/ : /^1*$/);
    assert.equal(s.match(/^1*/)[0].length, b.findIndex((x) => x) < 0 ? b.length : b.findIndex((x) => x));
    assert.deepEqual(b58decode(s), b);
  }
  for (const bad of ['0', 'O', 'I', 'l', '1 1', '+', 'abc/']) assert.throws(() => b58decode(bad), /invalid base58 character/);
  assert.throws(() => b58decode(null), /must be a string/);
  assert.throws(() => b58encode('abc'), /expected bytes/);

  for (const ok of [SYSTEM, PUMP_PROGRAM, COMPUTE_BUDGET, 'So11111111111111111111111111111111111111112']) assert.ok(isAddress(ok), ok);
  for (const bad of [SYSTEM.slice(1), SYSTEM + '1', b58encode(crypto.randomBytes(33)), 'x'.repeat(44), '', null, 42]) assert.equal(isAddress(bad), false, String(bad));
});

test('generateKeypair: Ed25519 via node:crypto; only the public half is visible', () => {
  const kp = generateKeypair(), other = generateKeypair();
  assert.deepEqual(Object.keys(kp), ['address', 'publicKey', 'sign']);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(kp))), ['address', 'publicKey']);   // nothing secret serialises
  assert.equal(kp.publicKey.constructor, Uint8Array);
  assert.equal(kp.publicKey.length, 32);
  assert.equal(kp.address, b58encode(kp.publicKey));
  assert.ok(isAddress(kp.address));
  assert.notEqual(kp.address, other.address);

  const msg = crypto.randomBytes(100), sig = kp.sign(msg);
  assert.equal(sig.constructor, Uint8Array);
  assert.equal(sig.length, 64);
  assert.deepEqual(kp.sign(msg), sig, 'Ed25519 is deterministic');
  // checked independently: node:crypto with a JWK made from the published key
  const jwk = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(kp.publicKey).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify(null, msg, jwk, sig));
  assert.ok(verifySignature(kp.publicKey, msg, sig));
  assert.ok(verifySignature(kp.address, msg, sig));
  const flipped = Uint8Array.from(sig); flipped[10] ^= 1;
  assert.equal(verifySignature(kp.address, msg, flipped), false);
  assert.equal(verifySignature(other.address, msg, sig), false);
  assert.equal(verifySignature(kp.address, crypto.randomBytes(100), sig), false);
  assert.equal(verifySignature(kp.address, msg, sig.subarray(1)), false);
  assert.equal(verifySignature(kp.publicKey.subarray(1), msg, sig), false);
  assert.equal(verifySignature('not an address', msg, sig), false);
});

test('findProgramAddress: pump.fun PDAs equal the accounts PumpPortal put in the recorded create transaction', () => {
  const { mint } = JSON.parse(fixture('pumpportal-create.json')).fixtures['pumpportal-create.bin'];
  const tx = parseTransaction(fixture('pumpportal-create.bin'));
  const create = tx.instructions.find((ix) => tx.accountKeys[ix.programIdIndex] === PUMP_PROGRAM);
  const account = (i) => tx.accountKeys[create.accounts[i]];
  const [bondingCurve, bump] = findProgramAddress(['bonding-curve', mint], PUMP_PROGRAM);
  assert.equal(bondingCurve, account(2));
  assert.ok(Number.isInteger(bump) && bump >= 0 && bump <= 255);
  assert.equal(findProgramAddress([bondingCurve, TOKEN_2022, mint], ATA_PROGRAM)[0], account(3), 'its Token-2022 associated account');
  assert.equal(findProgramAddress(['mint-authority'], PUMP_PROGRAM)[0], account(1));
  assert.equal(findProgramAddress([Buffer.from('mint-authority')], PUMP_PROGRAM)[0], account(1));
  assert.equal(findProgramAddress(['global'], PUMP_PROGRAM)[0], '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(findProgramAddress(['__event_authority'], PUMP_PROGRAM)[0], 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  assert.throws(() => findProgramAddress(['x'.repeat(33)], PUMP_PROGRAM), /at most 15 seeds of up to 32 bytes/);
  assert.throws(() => findProgramAddress(Array(16).fill('a'), PUMP_PROGRAM), /at most 15 seeds/);
  // the canonical PumpSwap pool is checked against real pool accounts in pump-tradeevent.json and the live test
  assert.ok(isAddress(pumpSwapPool(mint)));
  assert.notEqual(pumpSwapPool(mint), pumpSwapPool(rnd()));
});

// ---- transaction wire format ----

test('legacy transaction: parse, sign each signer in place, verify', () => {
  const payer = generateKeypair(), cosigner = generateKeypair(), dest = rnd();
  const transfer = hex('02000000 40420f0000000000'), big = new Uint8Array(crypto.randomBytes(200));   // 200 → compact-u16 c8 01
  const msg = message({ header: [2, 0, 1], keys: [payer, cosigner, dest, SYSTEM], ixs: [[3, [0, 2], transfer], [3, [1, 2, 0], big]] });
  const raw = wire(msg, blank(2));
  const tx = parseTransaction(raw);
  assert.equal(tx.version, 'legacy');
  assert.deepEqual(tx.header, { numRequiredSignatures: 2, numReadonlySigned: 0, numReadonlyUnsigned: 1 });
  assert.deepEqual(tx.accountKeys, [payer.address, cosigner.address, dest, SYSTEM]);
  assert.equal(tx.recentBlockhash, BLOCKHASH);
  assert.deepEqual(tx.instructions, [{ programIdIndex: 3, accounts: [0, 2], data: transfer }, { programIdIndex: 3, accounts: [1, 2, 0], data: big }]);
  assert.equal('addressTableLookups' in tx, false);
  assert.deepEqual(tx.messageBytes, msg);
  assert.deepEqual(tx.signatures, blank(2));
  assert.deepEqual(verifyTransactionSignatures(raw), [
    { address: payer.address, present: false, valid: false }, { address: cosigner.address, present: false, valid: false },
  ]);

  const one = signPartial(raw, cosigner);
  assert.deepEqual(raw, wire(msg, blank(2)), 'input untouched');
  assert.deepEqual(one.subarray(0, 65), raw.subarray(0, 65), 'payer slot untouched');
  assert.deepEqual(one.subarray(129), msg, 'message untouched');
  assert.deepEqual(verifyTransactionSignatures(one).map((s) => [s.present, s.valid]), [[false, false], [true, true]]);
  const both = signPartial(Buffer.from(one), payer);
  assert.equal(both.constructor, Uint8Array);
  assert.deepEqual(both, wire(msg, [payer.sign(msg), cosigner.sign(msg)]));
  assert.deepEqual(verifyTransactionSignatures(both).map((s) => s.valid), [true, true]);
  const tampered = Uint8Array.from(both); tampered[tampered.length - 1] ^= 1;
  assert.deepEqual(verifyTransactionSignatures(tampered).map((s) => [s.present, s.valid]), [[true, false], [true, false]]);

  assert.throws(() => signPartial(raw, generateKeypair()), /is not a required signer/);
  assert.throws(() => signPartial(raw, { address: dest, sign: () => new Uint8Array(64) }), new RegExp(`${dest} is not a required signer`));
  assert.throws(() => signPartial(raw, { address: payer.address, sign: () => new Uint8Array(63) }), /bad signature/);
});

test('v0 transaction with an address-table lookup: parse, sign, verify', () => {
  const payer = generateKeypair(), readonlySigner = generateKeypair(), [writable, program, table] = [rnd(), rnd(), rnd()];
  const msg = message({
    v0: true, header: [2, 1, 1], keys: [payer, readonlySigner, writable, program],
    ixs: [[3, [0, 1, 2, 4, 5, 6], hex('01')]], lookups: [[table, [7, 3], [0]]],   // loads accounts 4, 5 (writable) and 6
  });
  const raw = wire(msg, blank(2));
  const tx = parseTransaction(raw);
  assert.equal(tx.version, 0);
  assert.equal(tx.messageBytes[0], 0x80);
  assert.deepEqual(tx.header, { numRequiredSignatures: 2, numReadonlySigned: 1, numReadonlyUnsigned: 1 });
  assert.deepEqual(tx.accountKeys, [payer.address, readonlySigner.address, writable, program]);
  assert.deepEqual(tx.addressTableLookups, [{ accountKey: table, writableIndexes: [7, 3], readonlyIndexes: [0] }]);
  assert.deepEqual(tx.instructions, [{ programIdIndex: 3, accounts: [0, 1, 2, 4, 5, 6], data: hex('01') }]);

  const signed = signPartial(signPartial(raw, readonlySigner), payer);
  assert.deepEqual(signed, wire(msg, [payer.sign(msg), readonlySigner.sign(msg)]));
  assert.deepEqual(verifyTransactionSignatures(signed), [
    { address: payer.address, present: true, valid: true }, { address: readonlySigner.address, present: true, valid: true },
  ]);
  // the version prefix is part of what is signed
  assert.equal(verifySignature(payer.address, msg.subarray(1), signed.subarray(1, 65)), false);
  assert.throws(() => signPartial(raw, { address: table, sign: payer.sign }), /is not a required signer/);
});

test('compact-u16 and the runtime sanitize rules', () => {
  assert.deepEqual([sv(127), sv(128), sv(16383), sv(16384), sv(65535)].map((b) => b.toString('hex')), ['7f', '8001', 'ff7f', '808001', 'ffff03']);
  const kp = generateKeypair(), program = rnd();
  const base = { header: [1, 0, 1], keys: [kp, program] };
  for (const n of [0, 127, 128, 16383, 16384, 65535]) {
    const tx = parseTransaction(wire(message({ ...base, ixs: [[1, [0], new Uint8Array(n)]] }), blank(1)));
    assert.equal(tx.instructions[0].data.length, n);
  }
  const bad = (bytes, re) => assert.throws(() => parseTransaction(bytes), re);
  bad(hex('80 00'), /non-canonical compact-u16/);
  bad(hex('81 00'), /non-canonical compact-u16/);
  bad(hex('ff ff 04'), /compact-u16 overflow/);
  bad(hex('80 80 80 01'), /longer than 3 bytes/);
  bad(new Uint8Array(0), /truncated/);

  const good = wire(message({ ...base, ixs: [[1, [0], [9]]] }), blank(1));
  assert.equal(parseTransaction(good).instructions.length, 1);
  bad(good.subarray(0, -1), /truncated/);
  bad(new Uint8Array([...good, 0]), /trailing bytes/);
  bad(hex('01', '00'.repeat(64), '81'), /unsupported transaction version 1/);
  bad(wire(message({ ...base, ixs: [[1, [0], [9]]] }), blank(2)), /2 signatures for 1 required signers/);
  bad(wire(message({ ...base, header: [1, 1, 1] }), blank(1)), /no writable fee payer/);
  bad(wire(message({ ...base, header: [0, 0, 1] }), []), /no writable fee payer/);
  bad(wire(message({ ...base, header: [1, 0, 2] }), blank(1)), /more accounts than the message has/);
  bad(wire(message({ ...base, keys: [kp, kp] }), blank(1)), /duplicate account key/);
  bad(wire(message({ ...base, ixs: [[0, [], []]] }), blank(1)), /bad program id index 0/);   // the payer can't be a program
  bad(wire(message({ ...base, ixs: [[2, [], []]] }), blank(1)), /bad program id index 2/);
  bad(wire(message({ ...base, ixs: [[1, [2], []]] }), blank(1)), /account index out of range/);

  const v0 = (ixs, lookups) => wire(message({ ...base, v0: true, ixs, lookups }), blank(1));
  assert.deepEqual(parseTransaction(v0([[1, [2, 3], []]], [[rnd(), [0], [1]]])).instructions[0].accounts, [2, 3]);
  bad(v0([[1, [4], []]], [[rnd(), [0], [1]]]), /account index out of range/);
  bad(v0([[2, [], []]], [[rnd(), [0], []]]), /bad program id index 2/);   // programs can't come from lookup tables
  bad(v0([], [[rnd(), [], []]]), /loads nothing/);
  bad(v0([], [[rnd(), Array.from({ length: 255 }, (_, i) => i), []]]), /more than 256 accounts/);
});

// ---- PumpPortal create transactions (recorded live, see the SOLANA_LIVE tests below) ----

test('recorded PumpPortal create transactions: v0, creator pays, mint is signer #2, create_v2 carries our metadata', () => {
  const { fixtures } = JSON.parse(fixture('pumpportal-create.json'));
  assert.deepEqual(Object.keys(fixtures), ['pumpportal-create.bin', 'pumpportal-create-devbuy.bin']);
  for (const [file, { request, creator, mint }] of Object.entries(fixtures)) {
    const raw = fixture(file), tx = parseTransaction(raw);
    assert.ok(raw.length <= 1232, `${file}: ${raw.length} bytes`);
    assert.equal(tx.version, 0);
    assert.deepEqual([tx.header.numRequiredSignatures, tx.header.numReadonlySigned], [2, 0]);
    assert.deepEqual(tx.accountKeys.slice(0, 2), [creator, mint]);
    assert.deepEqual([request.publicKey, request.mint], [creator, mint]);
    assert.deepEqual(verifyTransactionSignatures(raw).map((s) => s.present), [false, false]);
    assert.equal(tx.addressTableLookups.length, 1);
    const programs = tx.instructions.map((ix) => tx.accountKeys[ix.programIdIndex]);
    assert.deepEqual([...new Set(programs)], request.amount > 0 ? [COMPUTE_BUDGET, PUMP_PROGRAM, ATA_PROGRAM, PUMPPORTAL_ROUTER] : [COMPUTE_BUDGET, PUMP_PROGRAM]);

    // SetComputeUnitLimit (2, u32) × SetComputeUnitPrice (3, µlamports u64) is exactly the requested priority fee
    const budget = Object.fromEntries(tx.instructions.filter((ix, i) => programs[i] === COMPUTE_BUDGET).map((ix) => [ix.data[0], Buffer.from(ix.data)]));
    assert.equal(BigInt(budget[2].readUInt32LE(1)) * budget[3].readBigUInt64LE(1) / 1_000_000n, BigInt(Math.round(request.priorityFee * 1e9)));

    // pump create_v2(name, symbol, uri, creator, is_mayhem_mode), the mint as its first account
    const create = tx.instructions[programs.indexOf(PUMP_PROGRAM)], d = Buffer.from(create.data);
    assert.equal(tx.accountKeys[create.accounts[0]], mint);
    assert.deepEqual(d.subarray(0, 8), crypto.createHash('sha256').update('global:create_v2').digest().subarray(0, 8));
    let at = 8;
    const str = () => d.subarray(at + 4, (at += 4 + d.readUInt32LE(at))).toString();
    assert.deepEqual([str(), str(), str()], [request.tokenMetadata.name, request.tokenMetadata.symbol, request.tokenMetadata.uri]);
    assert.equal(b58encode(d.subarray(at, at + 32)), creator);
    assert.deepEqual([...d.subarray(at + 32)], [0], 'not Mayhem mode');
  }
});

test('pumpCreateTx: the documented trade-local request, and its failures', async () => {
  const calls = [], bin = fixture('pumpportal-create.bin');
  const ok = async (url, init) => { calls.push({ url, init }); return new Response(bin, { status: 200, headers: { 'content-type': 'application/octet-stream' } }); };
  const req = { publicKey: rnd(), mint: rnd(), name: 'BRAINWORM', symbol: 'BRAINWORM', uri: 'https://example.com/brainworm.json' };
  const bytes = await pumpCreateTx({ ...req, fetchImpl: ok });
  assert.equal(bytes.constructor, Uint8Array);
  assert.deepEqual(bytes, new Uint8Array(bin));
  const [{ url, init }] = calls;
  assert.equal(url, 'https://pumpportal.fun/api/trade-local');
  assert.equal(url, TRADE_LOCAL_URL);
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  assert.ok(init.signal instanceof AbortSignal);
  const body = {
    publicKey: req.publicKey, action: 'create', tokenMetadata: { name: 'BRAINWORM', symbol: 'BRAINWORM', uri: req.uri }, mint: req.mint,
    denominatedInSol: 'true', amount: 0, slippage: 10, priorityFee: 0.0005, pool: 'pump',
  };
  assert.deepEqual(JSON.parse(init.body), body);
  await pumpCreateTx({ ...req, amountSol: 1.5, slippage: 25, priorityFee: 0.001, fetchImpl: ok });
  assert.deepEqual(JSON.parse(calls[1].init.body), { ...body, amount: 1.5, slippage: 25, priorityFee: 0.001 });

  const reply = (status, text) => async () => new Response(text, { status });
  await assert.rejects(pumpCreateTx({ ...req, fetchImpl: reply(400, 'Bad Request: invalid mint') }), /PumpPortal HTTP 400: Bad Request: invalid mint/);
  await assert.rejects(pumpCreateTx({ ...req, fetchImpl: reply(502, '') }), /PumpPortal HTTP 502/);
  await assert.rejects(pumpCreateTx({ ...req, fetchImpl: reply(200, '{"error":"insufficient balance"}') }), /did not return a transaction .*insufficient balance/);
  for (const [bad, re] of [
    [{ publicKey: 'nope' }, /publicKey is not a Solana address/], [{ mint: SYSTEM + '1' }, /mint is not a Solana address/],
    [{ name: 'x'.repeat(33) }, /name must be 1-32 bytes/], [{ symbol: 'BRAINWORMXX' }, /symbol must be 1-10 bytes/], [{ uri: ' ' }, /uri must be/],
    [{ amountSol: -1 }, /bad amountSol/], [{ slippage: NaN }, /bad slippage/], [{ priorityFee: '0.1' }, /bad priorityFee/],
  ]) await assert.rejects(pumpCreateTx({ ...req, ...bad, fetchImpl: ok }), re);
  assert.equal(calls.length, 2, 'bad input never reaches PumpPortal');
});

// PumpPortal builds the transaction for the keys it is sent: replay a recorded one with the requested keys swapped in.
function replayCreate(file, calls = [], swap = { creator: true, mint: true }) {
  const meta = JSON.parse(fixture('pumpportal-create.json')).fixtures[file];
  return async (url, init) => {
    const body = JSON.parse(init.body), out = Buffer.from(fixture(file));
    calls.push({ url, body });
    for (const [from, to] of [swap.creator && [meta.creator, body.publicKey], swap.mint && [meta.mint, body.mint]].filter(Boolean)) {
      const f = Buffer.from(b58decode(from)), t = Buffer.from(b58decode(to));
      for (let i = out.indexOf(f); i >= 0; i = out.indexOf(f, i + 32)) t.copy(out, i);
    }
    return new Response(out, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
}

test('prepareLaunch on the recorded transactions: the fresh mint signs, the creator slot is left for the wallet', async () => {
  for (const [file, amountSol, programIds] of [
    ['pumpportal-create.bin', 0, [COMPUTE_BUDGET, PUMP_PROGRAM]],
    ['pumpportal-create-devbuy.bin', 0.01, [COMPUTE_BUDGET, PUMP_PROGRAM, ATA_PROGRAM, PUMPPORTAL_ROUTER]],
  ]) {
    const creator = generateKeypair(), calls = [];
    const launch = await prepareLaunch({ creator: creator.address, name: 'BRAINWORM', symbol: 'BRAINWORM', uri: 'https://example.com/brainworm.json', amountSol, fetchImpl: replayCreate(file, calls) });
    assert.deepEqual(Object.keys(launch), ['mint', 'tx', 'summary']);
    assert.ok(isAddress(launch.mint));
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].url, calls[0].body.publicKey, calls[0].body.mint, calls[0].body.amount], [TRADE_LOCAL_URL, creator.address, launch.mint, amountSol]);

    const bytes = new Uint8Array(Buffer.from(launch.tx, 'base64'));
    assert.equal(Buffer.from(bytes).toString('base64'), launch.tx);
    assert.ok(bytes.length <= 1232);
    assert.deepEqual(launch.summary, {
      feePayer: creator.address, signers: [creator.address, launch.mint], programIds, recentBlockhash: parseTransaction(fixture(file)).recentBlockhash,
    });
    assert.deepEqual(verifyTransactionSignatures(bytes), [
      { address: creator.address, present: false, valid: false }, { address: launch.mint, present: true, valid: true },
    ]);
    // compared with what "PumpPortal" sent, only the mint's signature slot changed
    const sent = new Uint8Array(await (await replayCreate(file)(TRADE_LOCAL_URL, { body: JSON.stringify(calls[0].body) })).arrayBuffer());
    assert.deepEqual(bytes.subarray(0, 65), sent.subarray(0, 65));
    assert.deepEqual(bytes.subarray(129), sent.subarray(129));
    // what the creator's wallet then adds (it also sends; this test only signs)
    assert.deepEqual(verifyTransactionSignatures(signPartial(bytes, creator)).map((s) => s.valid), [true, true]);
  }
});

test('prepareLaunch refuses transactions it should not sign', async () => {
  const args = { creator: generateKeypair().address, name: 'BRAINWORM', symbol: 'BRAINWORM', uri: 'https://example.com/brainworm.json' };
  const { creator: recorded } = JSON.parse(fixture('pumpportal-create.json')).fixtures['pumpportal-create.bin'];
  await assert.rejects(prepareLaunch({ ...args, fetchImpl: replayCreate('pumpportal-create.bin', [], { mint: true }) }), new RegExp(`fee payer is ${recorded}, not the creator`));
  await assert.rejects(prepareLaunch({ ...args, fetchImpl: replayCreate('pumpportal-create.bin', [], { creator: true }) }), /the mint is not a required signer/);
  const extra = rnd();
  const threeSigners = async (url, init) => {
    const { publicKey, mint } = JSON.parse(init.body);
    return new Response(wire(message({ header: [3, 0, 1], keys: [publicKey, mint, extra, SYSTEM], ixs: [[3, [0, 1, 2], [2]]] }), blank(3)));
  };
  await assert.rejects(prepareLaunch({ ...args, fetchImpl: threeSigners }), new RegExp(`unexpected required signer ${extra}`));
  await assert.rejects(prepareLaunch({ ...args, fetchImpl: async () => new Response('Internal Server Error', { status: 500 }) }), /PumpPortal HTTP 500: Internal Server Error/);
  await assert.rejects(prepareLaunch({ ...args, creator: 'me' }), /creator is not a Solana address/);
});

// ---- metadata uploads: local mocks only (the real endpoints publish to IPFS) ----

async function httpMock(handle) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      handle(req, res, hits.length);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, hits,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}
const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

// A deliberately plain multipart/form-data reader: checks the framing, returns the parts in order.
function formParts(hit) {
  const m = /^multipart\/form-data; boundary=(\S+)$/.exec(hit.headers['content-type']);
  assert.ok(m, `content-type: ${hit.headers['content-type']}`);
  const sep = `--${m[1]}`, body = hit.body.toString('latin1');
  assert.ok(body.startsWith(`${sep}\r\n`), 'opens with the boundary');
  assert.ok(body.endsWith(`\r\n${sep}--\r\n`), 'closes with the boundary');
  return body.slice(sep.length + 2, -(sep.length + 6)).split(`\r\n${sep}\r\n`).map((part) => {
    const i = part.indexOf('\r\n\r\n'), head = part.slice(0, i);
    return {
      name: /; name="([^"]*)"/.exec(head)[1],
      filename: /; filename="([^"]*)"/.exec(head)?.[1] ?? null,
      type: /\r\nContent-Type: (.*)$/im.exec(head)?.[1] ?? null,
      value: Buffer.from(part.slice(i + 4), 'latin1'),
    };
  });
}

const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(300), Buffer.from('\r\n--\r\n\r\n')]);
const META = { name: 'BRAINWORM', symbol: 'BRAINWORM', description: 'A live worm larva connectome 🪱' };

test('uploadPumpMetadata: the multipart form pump.fun expects, and its JSON reply', async () => {
  const answer = { metadata: { ...META, image: 'https://ipfs.io/ipfs/QmImage', showName: true, createdOn: 'https://pump.fun' }, metadataUri: 'https://ipfs.io/ipfs/QmMeta' };
  const replies = [[200, answer], [403, 'Forbidden'], [200, '<html>challenge</html>'], [200, { metadata: {} }]];
  const srv = await httpMock((req, res, n) => reply(res, ...replies[n - 1]));
  const args = { ...META, image: IMAGE, filename: 'worm.png', twitter: 'https://x.com/brainworm', website: 'https://brainworm.example', url: `${srv.url}/api/ipfs` };
  try {
    assert.deepEqual(await uploadPumpMetadata(args), { metadataUri: answer.metadataUri, metadata: answer.metadata });
    const [hit] = srv.hits;
    assert.equal(hit.method, 'POST');
    assert.equal(hit.url, '/api/ipfs');
    const parts = formParts(hit);
    assert.deepEqual(parts.map((p) => p.name), ['file', 'name', 'symbol', 'description', 'twitter', 'telegram', 'website', 'showName']);
    assert.deepEqual(parts[0], { name: 'file', filename: 'worm.png', type: 'image/png', value: IMAGE });
    assert.ok(parts.slice(1).every((p) => p.filename === null && p.type === null));
    assert.deepEqual(Object.fromEntries(parts.slice(1).map((p) => [p.name, p.value.toString()])), {
      ...META, twitter: 'https://x.com/brainworm', telegram: '', website: 'https://brainworm.example', showName: 'true',
    });

    await assert.rejects(uploadPumpMetadata(args), /pump.fun ipfs HTTP 403: Forbidden/);
    await assert.rejects(uploadPumpMetadata(args), /pump.fun ipfs returned non-JSON: <html>challenge<\/html>/);
    await assert.rejects(uploadPumpMetadata(args), /no metadataUri/);
    await assert.rejects(uploadPumpMetadata({ ...args, image: undefined }), /image must be a non-empty Buffer/);
    await assert.rejects(uploadPumpMetadata({ ...args, symbol: 'TOO_LONG_TICKER' }), /symbol must be 1-10 bytes/);
    assert.equal(srv.hits.length, 4);
  } finally {
    await srv.close();
  }
});

test('uploadPinataMetadata: image, then pump.fun-style metadata JSON, with Bearer auth on the public network', async () => {
  const cids = ['bafkreiimage0000000000000000', 'bafkreimetadata000000000000'];
  const replies = [[200, { data: { id: '1', cid: cids[0] } }], [200, { data: { id: '2', cid: cids[1] } }], [401, 'Unauthorized'], [200, { data: { cid: 'bad cid!' } }]];
  const srv = await httpMock((req, res, n) => reply(res, ...replies[n - 1]));
  const args = { ...META, image: IMAGE, filename: 'worm.webp', twitter: 'https://x.com/brainworm', jwt: 'test.jwt', url: `${srv.url}/v3/files` };
  try {
    const metadata = { ...META, image: `https://ipfs.io/ipfs/${cids[0]}`, showName: true, createdOn: 'https://pump.fun', twitter: 'https://x.com/brainworm' };
    assert.deepEqual(await uploadPinataMetadata(args), { metadataUri: `https://ipfs.io/ipfs/${cids[1]}`, metadata });
    assert.equal(srv.hits.length, 2);
    for (const hit of srv.hits) assert.deepEqual([hit.method, hit.url, hit.headers.authorization], ['POST', '/v3/files', 'Bearer test.jwt']);
    const [img, meta] = srv.hits.map(formParts);
    assert.deepEqual(img.map((p) => [p.name, p.filename, p.type]), [['network', null, null], ['file', 'worm.webp', 'image/webp']]);
    assert.deepEqual([img[0].value.toString(), img[1].value], ['public', IMAGE]);
    assert.deepEqual(meta.map((p) => [p.name, p.filename, p.type]), [['network', null, null], ['file', 'metadata.json', 'application/json']]);
    assert.deepEqual(JSON.parse(meta[1].value), metadata);

    await assert.rejects(uploadPinataMetadata(args), /Pinata HTTP 401: Unauthorized/);
    await assert.rejects(uploadPinataMetadata(args), /Pinata reply has no cid/);
    await assert.rejects(uploadPinataMetadata({ ...args, jwt: '' }), /Pinata JWT is required/);
    assert.equal(srv.hits.length, 4);
  } finally {
    await srv.close();
  }
});

// ---- trade stream ----

const MINT = generateKeypair().address;
const tradeMsg = (txType, over = {}) => ({
  signature: b58encode(crypto.randomBytes(64)), mint: MINT, traderPublicKey: generateKeypair().address, txType,
  tokenAmount: 357902.562315, solAmount: 0.01, newTokenBalance: 357902.562315, bondingCurveKey: rnd(),
  vTokensInBondingCurve: 1072642097.437685, vSolInBondingCurve: 30.01, marketCapSol: 27.97, pool: 'pump', ...over,
});

test('normalizeTrade: PumpPortal buy/sell fields → the site trade shape; everything else is null', () => {
  const buy = tradeMsg('buy');
  assert.deepEqual(normalizeTrade(buy, MINT, 7), {
    signature: buy.signature, side: 'buy', sol: 0.01, tokens: 357902.562315, trader: buy.traderPublicKey, marketCapSol: 27.97, pool: 'pump', ts: 7,
  });
  // numeric strings are accepted; a bad trader, missing market cap or odd pool degrade to empty values
  const odd = tradeMsg('sell', { solAmount: '0.5', tokenAmount: 0, marketCapSol: undefined, traderPublicKey: '<b>x</b>', pool: 7 });
  assert.deepEqual(normalizeTrade(odd, MINT, 1), { signature: odd.signature, side: 'sell', sol: 0.5, tokens: 0, trader: '', marketCapSol: null, pool: '', ts: 1 });
  assert.ok(normalizeTrade(buy));   // no mint filter
  for (const m of [null, 'buy', [], {}, tradeMsg('create'), tradeMsg('buy', { mint: rnd() }), tradeMsg('buy', { solAmount: -1 }),
    tradeMsg('buy', { tokenAmount: '' }), tradeMsg('buy', { solAmount: null }), tradeMsg('buy', { signature: 'short' }), tradeMsg('buy', { signature: undefined })]) {
    assert.equal(normalizeTrade(m, MINT), null, JSON.stringify(m));
  }
});

test('recorded PumpPortal stream messages: a create is not a trade; a recorded trade normalises', () => {
  const rec = JSON.parse(fixture('pumpportal-trade.json'));
  const nt = rec.newToken;
  assert.equal(nt.txType, 'create');
  for (const k of ['signature', 'mint', 'traderPublicKey', 'solAmount', 'marketCapSol', 'pool', 'name', 'symbol', 'uri']) assert.ok(k in nt, k);
  assert.equal(normalizeTrade(nt, nt.mint), null);
  // buy/sell messages share this shape, with tokenAmount (and newTokenBalance) in place of initialBuy
  assert.deepEqual(normalizeTrade({ ...nt, txType: 'buy', tokenAmount: nt.initialBuy }, nt.mint, 5), {
    signature: nt.signature, side: 'buy', sol: nt.solAmount, tokens: nt.initialBuy, trader: nt.traderPublicKey, marketCapSol: nt.marketCapSol, pool: nt.pool, ts: 5,
  });
  if (rec.trade) assert.ok(normalizeTrade(rec.trade, nt.mint));
  else assert.match(rec.tradeReply, /API key/);
});

// A tiny stand-in for wss://pumpportal.fun/api/data: records what each client sends.
async function mockPortal(opts = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, ...opts });
  await once(wss, 'listening');
  const srv = { conns: [], onConn: null, url: `ws://127.0.0.1:${wss.address().port}/api/data` };
  wss.on('connection', (ws, req) => {
    const c = { ws, path: req.url, msgs: [], pings: 0, t: Date.now(), closeCode: null };
    c.send = (...ms) => { for (const m of ms) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
    ws.on('message', (d) => { const m = JSON.parse(String(d)); c.msgs.push(m); srv.reply?.(c, m); });
    ws.on('ping', () => c.pings++);
    ws.on('close', (code) => { c.closeCode = code; });
    srv.conns.push(c);
    srv.onConn?.(c);
  });
  srv.close = () => new Promise((r) => { for (const c of srv.conns) c.ws.terminate(); wss.close(r); });
  return srv;
}
const subscribedOn = (srv, i) => until(() => srv.conns[i]?.msgs.length > 0);

test('createTradeStream: subscribes on open, reports trades, ignores acks and noise', async () => {
  assert.throws(() => createTradeStream({ mint: 'nope' }), /mint is not a Solana address/);
  const srv = await mockPortal();
  const trades = [];
  let clock = 1000;
  const stream = createTradeStream({ mint: MINT, url: srv.url, logger: quiet, now: () => clock++, onTrade: (t) => trades.push(t) });
  try {
    assert.deepEqual(stream.status(), { enabled: true, mint: MINT, connected: false, subscribed: false, trades: 0, lastTradeAt: null, reconnects: 0, lastNotice: null });
    stream.start();
    stream.start();   // idempotent
    await subscribedOn(srv, 0);
    const c = srv.conns[0];
    assert.equal(c.path, '/api/data');
    assert.deepEqual(c.msgs, [{ method: 'subscribeTokenTrade', keys: [MINT] }]);
    assert.equal(stream.status().connected, true);
    assert.equal(stream.status().subscribed, false);

    c.send({ message: 'Successfully subscribed to keys.' });
    await until(() => stream.status().subscribed);
    const buy = tradeMsg('buy'), sell = tradeMsg('sell', { solAmount: 0.25, tokenAmount: 9e6, marketCapSol: 31.5, pool: 'pump-amm' });
    c.send('not json', 'null', '[1,2]', { ...tradeMsg('create'), initialBuy: 1e6 }, tradeMsg('buy', { mint: rnd() }), tradeMsg('buy', { solAmount: 'lots' }), buy, sell);
    await until(() => trades.length === 2);
    assert.deepEqual(trades, [
      { signature: buy.signature, side: 'buy', sol: 0.01, tokens: 357902.562315, trader: buy.traderPublicKey, marketCapSol: 27.97, pool: 'pump', ts: 1000 },
      { signature: sell.signature, side: 'sell', sol: 0.25, tokens: 9e6, trader: sell.traderPublicKey, marketCapSol: 31.5, pool: 'pump-amm', ts: 1001 },
    ]);
    assert.deepEqual(stream.status(), {
      enabled: true, mint: MINT, connected: true, subscribed: true, trades: 2, lastTradeAt: 1001, reconnects: 0, lastNotice: 'Successfully subscribed to keys.',
    });
    assert.equal(srv.conns.length, 1);
    assert.equal(c.msgs.length, 1);
  } finally {
    await stream.stop(); await srv.close();
  }
});

test('createTradeStream: API key goes in the URL but never in logs; refusals are logged; throwing handlers are contained', async () => {
  const srv = await mockPortal();
  const logs = [], logger = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) };
  let n = 0;
  const stream = createTradeStream({
    mint: MINT, url: srv.url, apiKey: 'sk/test key+1', logger, backoffMs: 10,
    onTrade: () => { n++; if (n === 1) throw new Error('boom'); if (n === 2) return Promise.reject(new Error('later')); },
  });
  try {
    stream.start();
    await subscribedOn(srv, 0);
    assert.equal(srv.conns[0].path, '/api/data?api-key=sk%2Ftest%20key%2B1');
    srv.conns[0].send({ message: NO_KEY }, tradeMsg('buy'), tradeMsg('sell'), tradeMsg('buy'));
    await until(() => stream.status().trades === 3);
    await new Promise((r) => setTimeout(r, 20));   // let the rejection settle
    assert.equal(n, 3);
    assert.equal(stream.status().lastNotice, NO_KEY);
    assert.ok(logs.includes(`[pumpportal] ${NO_KEY}`));
    assert.ok(logs.includes('[pumpportal] handler failed: boom'));
    assert.ok(logs.includes('[pumpportal] handler failed: later'));
    srv.conns[0].ws.terminate();
    await subscribedOn(srv, 1);
    assert.equal(srv.conns[1].path, '/api/data?api-key=sk%2Ftest%20key%2B1');
    assert.ok(logs.some((l) => /reconnecting in/.test(l)));
    assert.ok(logs.every((l) => !/sk.test|api-key/.test(l)), 'the API key is never logged');
  } finally {
    await stream.stop(); await srv.close();
  }
});

test('createTradeStream: resubscribes after drops with exponential backoff; a stable link resets it', async () => {
  const srv = await mockPortal();
  const stream = createTradeStream({ mint: MINT, url: srv.url, logger: quiet, backoffMs: 20, stableMs: 250 });
  try {
    stream.start();
    await subscribedOn(srv, 0);
    srv.onConn = (c) => c.ws.terminate();   // every new connection dropped at once: 20, 40, 80, 160 ms between tries
    srv.conns[0].ws.terminate();
    await until(() => srv.conns.length >= 5);
    srv.onConn = null;
    const gap = (i) => srv.conns[i + 1].t - srv.conns[i].t;
    assert.ok(gap(1) >= 35, `second retry waited ${gap(1)} ms`);
    assert.ok(gap(2) >= 75, `third retry waited ${gap(2)} ms`);
    assert.ok(gap(3) > gap(2));

    // the next one is let through; after being up for stableMs, a drop reconnects after 20 ms again (not 640)
    const n = srv.conns.length;
    await subscribedOn(srv, n);
    await new Promise((r) => setTimeout(r, 300));
    const dropped = Date.now();
    srv.conns[n].ws.terminate();
    await subscribedOn(srv, n + 1);
    assert.ok(srv.conns[n + 1].t - dropped < 400, `backoff was reset (${srv.conns[n + 1].t - dropped} ms)`);
    for (const c of [srv.conns[0], srv.conns[n], srv.conns[n + 1]]) assert.deepEqual(c.msgs, [{ method: 'subscribeTokenTrade', keys: [MINT] }]);
    assert.equal(stream.status().reconnects, n + 1);
    assert.equal(stream.status().connected, true);
  } finally {
    await stream.stop(); await srv.close();
  }
});

test('createTradeStream: pings keep a quiet link; a link that stops answering is replaced', async () => {
  const opts = { mint: MINT, logger: quiet, backoffMs: 10, pingIntervalMs: 30, pingTimeoutMs: 60 };
  const live = await mockPortal();
  const a = createTradeStream({ ...opts, url: live.url });
  try {
    a.start();
    await until(() => live.conns[0]?.pings >= 4);
    assert.equal(live.conns.length, 1, 'answered pings keep the connection');
  } finally {
    await a.stop(); await live.close();
  }
  const mute = await mockPortal({ autoPong: false });
  const b = createTradeStream({ ...opts, url: mute.url });
  try {
    b.start();
    await subscribedOn(mute, 1);
    assert.ok(mute.conns[0].pings >= 1);
    assert.equal(b.status().reconnects, 1);
  } finally {
    await b.stop(); await mute.close();
  }
});

test('createTradeStream: stop() closes cleanly and leaves no timers behind', async () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timeouts();
  const srv = await mockPortal();
  const stream = createTradeStream({ mint: MINT, url: srv.url, logger: quiet, backoffMs: 60_000 });

  // while connected (ping interval running): a normal close handshake
  stream.start();
  await subscribedOn(srv, 0);
  await stream.stop();
  await until(() => srv.conns[0].closeCode !== null);
  assert.equal(srv.conns[0].closeCode, 1000);
  assert.equal(stream.status().connected, false);

  // while waiting to retry
  stream.start();
  await subscribedOn(srv, 1);
  srv.conns[1].ws.terminate();
  await until(() => !stream.status().connected);
  await stream.stop();

  // while still connecting
  stream.start();
  await stream.stop();

  await srv.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(timeouts() <= before, `timers left: ${timeouts() - before}`);
});

// ---- trades from Solana RPC logs ----

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const eventDisc = (name) => crypto.createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
// Written in the IDL's field order; the random tails stand in for the fields later upgrades appended.
const tradeEvent = ({ mint = MINT, lamports, raw, isBuy, user, vSol, vTokens }) => Buffer.concat([
  eventDisc('TradeEvent'), key(mint), u64(lamports), u64(raw), Buffer.from([isBuy ? 1 : 0]), key(user), u64(1790000000), u64(vSol), u64(vTokens), crypto.randomBytes(262),
]);
const swapEvent = (name, { base, quote, poolBase, poolQuote, pool, user }) => Buffer.concat([
  eventDisc(name), u64(1790000000), u64(base), u64(0), u64(0), u64(0), u64(poolBase), u64(poolQuote), u64(quote), Buffer.alloc(48), key(pool), key(user), crypto.randomBytes(249),
]);
const frame = (program, inner = [], depth = 1) => [`Program ${program} invoke [${depth}]`, ...inner, `Program ${program} consumed 5000 of 200000 compute units`, `Program ${program} success`];
const dataLine = (bytes) => `Program data: ${bytes.toString('base64')}`;
const mcap = (lamports, raw) => ((lamports / 1e9) / (raw / 1e6)) * 1e9;   // price × a 1e9-token supply
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.abs(b);

test('tradesFromLogs: our pump.fun TradeEvents and PumpSwap Buy/SellEvents, attributed to the program that logged them', () => {
  const alice = generateKeypair().address, bob = generateKeypair().address, pool = pumpSwapPool(MINT), SIG = b58encode(crypto.randomBytes(64));
  const buy = tradeEvent({ lamports: 250_000_000, raw: 8_123_456_789_012, isBuy: true, user: alice, vSol: 32e9, vTokens: 1_005_937_500_000_000 });
  const sell = tradeEvent({ lamports: 100_000_000, raw: 3_000_000_000_000, isBuy: false, user: bob, vSol: 31.9e9, vTokens: 1_008_937_500_000_000 });
  const reserves = { poolBase: 206_000_000_000_000, poolQuote: 161_000_000_000, pool };
  const swapBuy = swapEvent('BuyEvent', { base: 18_819_214_183, quote: 17_060_988, user: alice, ...reserves });
  const swapSell = swapEvent('SellEvent', { base: 1_718_295_881_633, quote: 674_844_183, user: bob, ...reserves });
  const logs = [
    ...frame(COMPUTE_BUDGET),
    ...frame(PUMP_PROGRAM, ['Program log: Instruction: Buy', ...frame(TOKEN_2022, ['Program log: Instruction: TransferChecked'], 2), dataLine(buy), ...frame(PUMP_PROGRAM, [], 2)]),
    ...frame(rnd(), [dataLine(buy)]),   // the same bytes logged by some other program
    `Program log: ${dataLine(buy)}`,   // or merely printed
    ...frame(PUMP_PROGRAM, [dataLine(tradeEvent({ mint: rnd(), lamports: 1, raw: 1, isBuy: true, user: bob, vSol: 1, vTokens: 1 }))]),   // another coin
    ...frame(PUMP_AMM_PROGRAM, [dataLine(swapBuy)]),
    ...frame(PUMP_AMM_PROGRAM, [dataLine(swapEvent('SellEvent', { base: 1, quote: 1, poolBase: 1, poolQuote: 1, pool: rnd(), user: bob }))]),   // another pool
    ...frame(PUMP_PROGRAM, [dataLine(buy.subarray(0, 112))]),   // too short
    ...frame(PUMP_PROGRAM, [dataLine(Buffer.concat([buy.subarray(0, 56), Buffer.from([2]), buy.subarray(57)]))]),   // is_buy not a bool
    ...frame(PUMP_AMM_PROGRAM, [dataLine(swapSell), `Program return: ${PUMP_AMM_PROGRAM} AAAA`]),
    ...frame(PUMP_PROGRAM, [dataLine(sell)]),
    'Log truncated',
  ];
  const expected = [
    { side: 'buy', sol: 0.25, tokens: 8123456.789012, trader: alice, marketCapSol: mcap(32e9, 1_005_937_500_000_000), pool: 'pump' },
    { side: 'buy', sol: 0.017060988, tokens: 18819.214183, trader: alice, marketCapSol: mcap(161e9, 206e12), pool: 'pump-amm' },
    { side: 'sell', sol: 0.674844183, tokens: 1718295.881633, trader: bob, marketCapSol: mcap(161e9, 206e12), pool: 'pump-amm' },
    { side: 'sell', sol: 0.1, tokens: 3000000, trader: bob, marketCapSol: mcap(31.9e9, 1_008_937_500_000_000), pool: 'pump' },
  ];
  const trades = tradesFromLogs(logs, { mint: MINT, signature: SIG });
  assert.equal(trades.length, expected.length);
  trades.forEach((t, i) => {
    assert.deepEqual({ ...t, marketCapSol: 0, ts: 0 }, { signature: SIG, ...expected[i], marketCapSol: 0, ts: 0 });
    assert.ok(near(t.marketCapSol, expected[i].marketCapSol), `${t.marketCapSol} vs ${expected[i].marketCapSol}`);
    assert.ok(Number.isFinite(t.ts));
  });
  assert.deepEqual(tradesFromLogs(null, { mint: MINT }), []);
  assert.deepEqual(tradesFromLogs([42, null, ...frame(PUMP_PROGRAM, [dataLine(buy)])], { mint: MINT }).map((t) => [t.signature, t.side]), [['', 'buy']]);
  assert.deepEqual(tradesFromLogs(logs, { mint: rnd() }), []);
});

// The three events' fields, in order, from pump-fun/pump-public-docs idl/pump.json and idl/pump_amm.json (2026-09-12).
const LAYOUT = {
  TradeEvent: 'mint:pubkey sol_amount:u64 token_amount:u64 is_buy:bool user:pubkey timestamp:i64 virtual_sol_reserves:u64 virtual_token_reserves:u64 '
    + 'real_sol_reserves:u64 real_token_reserves:u64 fee_recipient:pubkey fee_basis_points:u64 fee:u64 creator:pubkey creator_fee_basis_points:u64 '
    + 'creator_fee:u64 track_volume:bool total_unclaimed_tokens:u64 total_claimed_tokens:u64 current_sol_volume:u64 last_update_timestamp:i64 '
    + 'ix_name:string mayhem_mode:bool cashback_fee_basis_points:u64 cashback:u64 buyback_fee_basis_points:u64 buyback_fee:u64 shareholders:vec<Shareholder> '
    + 'quote_mint:pubkey quote_amount:u64 virtual_quote_reserves:u64 real_quote_reserves:u64 holder_rewards_bps:u64 holder_rewards:u64',
  BuyEvent: 'timestamp:i64 base_amount_out:u64 max_quote_amount_in:u64 user_base_token_reserves:u64 user_quote_token_reserves:u64 pool_base_token_reserves:u64 '
    + 'pool_quote_token_reserves:u64 quote_amount_in:u64 lp_fee_basis_points:u64 lp_fee:u64 protocol_fee_basis_points:u64 protocol_fee:u64 '
    + 'quote_amount_in_with_lp_fee:u64 user_quote_amount_in:u64 pool:pubkey user:pubkey user_base_token_account:pubkey user_quote_token_account:pubkey '
    + 'protocol_fee_recipient:pubkey protocol_fee_recipient_token_account:pubkey coin_creator:pubkey coin_creator_fee_basis_points:u64 coin_creator_fee:u64 '
    + 'track_volume:bool total_unclaimed_tokens:u64 total_claimed_tokens:u64 current_sol_volume:u64 last_update_timestamp:i64 min_base_amount_out:u64 '
    + 'ix_name:string cashback_fee_basis_points:u64 cashback:u64 buyback_fee_basis_points:u64 buyback_fee:u64 virtual_quote_reserves:i128 can_boost:bool '
    + 'base_supply:u64 holder_rewards_bps:u64 holder_rewards:u64',
  SellEvent: 'timestamp:i64 base_amount_in:u64 min_quote_amount_out:u64 user_base_token_reserves:u64 user_quote_token_reserves:u64 pool_base_token_reserves:u64 '
    + 'pool_quote_token_reserves:u64 quote_amount_out:u64 lp_fee_basis_points:u64 lp_fee:u64 protocol_fee_basis_points:u64 protocol_fee:u64 '
    + 'quote_amount_out_without_lp_fee:u64 user_quote_amount_out:u64 pool:pubkey user:pubkey user_base_token_account:pubkey user_quote_token_account:pubkey '
    + 'protocol_fee_recipient:pubkey protocol_fee_recipient_token_account:pubkey coin_creator:pubkey coin_creator_fee_basis_points:u64 coin_creator_fee:u64 '
    + 'cashback_fee_basis_points:u64 cashback:u64 buyback_fee_basis_points:u64 buyback_fee:u64 virtual_quote_reserves:i128 can_boost:bool base_supply:u64 '
    + 'holder_rewards_bps:u64 holder_rewards:u64',
};
const SIZE = { pubkey: 32, u64: 8, i64: 8, bool: 1, i128: 16 };
function borsh(layout, d) {   // → the raw bytes of each field, and where the last one ended
  const fields = {};
  let at = 8;
  for (const [name, type] of layout.split(' ').map((f) => f.split(':'))) {
    const n = type === 'string' ? 4 + d.readUInt32LE(at) : type === 'vec<Shareholder>' ? 4 + 34 * d.readUInt32LE(at) : SIZE[type];
    fields[name] = d.subarray(at, (at += n));
  }
  return { fields, end: at };
}

test('recorded mainnet logs (pump-tradeevent.json): the events fill the IDL layouts byte for byte and decode to the recorded trades', () => {
  const rec = JSON.parse(fixture('pump-tradeevent.json'));
  assert.equal(pumpSwapPool(rec.pumpSwap.mint), rec.pumpSwap.pool, 'the canonical PumpSwap pool of the coin');
  for (const s of [rec.pump, rec.pumpSwap]) {
    const pool = pumpSwapPool(s.mint), byIdl = [];
    for (const line of s.logs.filter((l) => l.startsWith('Program data: '))) {
      const d = Buffer.from(line.slice(14), 'base64'), name = Object.keys(LAYOUT).find((n) => eventDisc(n).equals(d.subarray(0, 8)));
      if (!name) continue;
      const { fields: f, end } = borsh(LAYOUT[name], d);
      assert.equal(end, d.length, `${name}: the IDL layout covers all ${d.length} bytes`);
      const n = (b) => Number(b.readBigUInt64LE());
      if (name === 'TradeEvent' && b58encode(f.mint) === s.mint) {
        assert.equal(b58encode(f.quote_mint), SYSTEM, 'a SOL-paired coin');
        byIdl.push({ side: f.is_buy[0] ? 'buy' : 'sell', sol: n(f.sol_amount) / 1e9, tokens: n(f.token_amount) / 1e6, trader: b58encode(f.user) });
      } else if (name !== 'TradeEvent' && b58encode(f.pool) === pool) {
        const buy = name === 'BuyEvent';
        byIdl.push({ side: buy ? 'buy' : 'sell', sol: n(buy ? f.quote_amount_in : f.quote_amount_out) / 1e9, tokens: n(buy ? f.base_amount_out : f.base_amount_in) / 1e6, trader: b58encode(f.user) });
      }
    }
    const trades = tradesFromLogs(s.logs, { mint: s.mint, signature: s.signature });
    assert.ok(trades.length >= 1);
    assert.deepEqual(trades.map(({ side, sol, tokens, trader }) => ({ side, sol, tokens, trader })), byIdl);
    assert.deepEqual(trades.map(({ ts, ...t }) => t), s.trades);
  }
});

const notify = (c, value) => c.send({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { context: { slot: 1 }, value }, subscription: 7 } });

test('createRpcTradeStream: logsSubscribe for the mint, trades decoded from notifications, failed transactions skipped', async () => {
  assert.throws(() => createRpcTradeStream({ mint: 'nope' }), /mint is not a Solana address/);
  const srv = await mockPortal();
  srv.reply = (c, m) => { if (m.method === 'logsSubscribe') c.send({ jsonrpc: '2.0', result: 7, id: m.id }); };
  const trades = [], user = generateKeypair().address, sig = () => b58encode(crypto.randomBytes(64));
  let clock = 5000;
  const stream = createRpcTradeStream({ mint: MINT, url: srv.url, logger: quiet, now: () => clock++, onTrade: (t) => trades.push(t) });
  const buyLogs = frame(PUMP_PROGRAM, [dataLine(tradeEvent({ lamports: 5e8, raw: 1e12, isBuy: true, user, vSol: 33e9, vTokens: 975e12 }))]);
  const sellLogs = frame(PUMP_AMM_PROGRAM, [dataLine(swapEvent('SellEvent', { base: 2e12, quote: 7e8, poolBase: 2e14, poolQuote: 8e10, pool: pumpSwapPool(MINT), user }))]);
  try {
    stream.start();
    await subscribedOn(srv, 0);
    assert.deepEqual(srv.conns[0].msgs, [{ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [MINT] }, { commitment: 'confirmed' }] }]);
    await until(() => stream.status().subscribed);
    const c = srv.conns[0], [s1, s2, s3] = [sig(), sig(), sig()];
    c.send('not json', { jsonrpc: '2.0', method: 'slotNotification', params: {} });
    notify(c, { signature: s1, err: null, logs: buyLogs });
    notify(c, { signature: s2, err: { InstructionError: [3, { Custom: 6003 }] }, logs: buyLogs });   // failed: nothing traded
    notify(c, { signature: sig(), err: null, logs: frame(PUMP_PROGRAM, [dataLine(tradeEvent({ mint: rnd(), lamports: 1, raw: 1, isBuy: true, user, vSol: 1, vTokens: 1 }))]) });
    notify(c, { signature: s3, err: null, logs: sellLogs });
    await until(() => trades.length === 2);
    assert.deepEqual(trades.map((t) => [t.signature, t.side, t.sol, t.tokens, t.trader, t.pool, t.ts]), [[s1, 'buy', 0.5, 1e6, user, 'pump', 5000], [s3, 'sell', 0.7, 2e6, user, 'pump-amm', 5001]]);
    assert.ok(near(trades[0].marketCapSol, mcap(33e9, 975e12)) && near(trades[1].marketCapSol, mcap(8e10, 2e14)));
    assert.deepEqual(stream.status(), { enabled: true, mint: MINT, connected: true, subscribed: true, trades: 2, lastTradeAt: 5001, reconnects: 0, lastNotice: null });
  } finally {
    await stream.stop(); await srv.close();
  }
});

test('createRpcTradeStream: a refused subscription is logged, the RPC URL never is; a reconnect resubscribes', async () => {
  const srv = await mockPortal();
  srv.reply = (c, m) => c.send(srv.conns.length === 1 ? { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: m.id } : { jsonrpc: '2.0', result: 9, id: m.id });
  const logs = [], logger = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) };
  const stream = createRpcTradeStream({ mint: MINT, url: `${srv.url}?api-key=rpc-secret`, logger, backoffMs: 10 });
  try {
    stream.start();
    await until(() => stream.status().lastNotice);
    assert.equal(stream.status().lastNotice, 'logsSubscribe failed: Method not found');
    assert.equal(stream.status().subscribed, false);
    assert.ok(logs.includes('[solana-rpc] logsSubscribe failed: Method not found'));
    assert.equal(srv.conns[0].path, '/api/data?api-key=rpc-secret');
    srv.conns[0].ws.terminate();
    await until(() => stream.status().subscribed);
    assert.equal(srv.conns.length, 2);
    assert.equal(srv.conns[1].msgs[0].method, 'logsSubscribe');
    assert.equal(stream.status().reconnects, 1);
    assert.ok(logs.some((l) => l.startsWith('[solana-rpc] disconnected, reconnecting in')));
  } finally {
    await stream.stop(); await srv.close();
  }
  // a URL ws refuses outright: its error message quotes the URL, the log line must not
  const bad = createRpcTradeStream({ mint: MINT, url: 'rpc.example/?api-key=rpc-secret', logger, backoffMs: 60_000 });
  bad.start();
  await bad.stop();
  assert.ok(logs.some((l) => /^\[solana-rpc\] cannot connect: .*<url>/.test(l)), logs.join('\n'));
  assert.ok(logs.every((l) => !l.includes('rpc-secret')), 'the RPC URL is never logged');
});

// ---- RPC ----

test('rpc and confirmLaunch: JSON-RPC requests, and how statuses and the mint account are read', async () => {
  const SIG = b58encode(crypto.randomBytes(64));
  const mintAccount = (program, type) => ({ value: { owner: 'x', executable: false, lamports: 1461600, data: { program, space: 82, parsed: { type, info: { decimals: 6, supply: '1000000000000000', isInitialized: true, mintAuthority: null, freezeAuthority: null } } } } });
  const status = (confirmationStatus, err = null) => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: null, err, status: err ? { Err: err } : { Ok: null }, confirmationStatus }] });
  const calls = [];
  let answers;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const a = answers[body.method];
    return typeof a === 'string' ? new Response(a, { status: 429 }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...a }), { status: 200 });
  };
  const check = async (sigStatus, account, expected) => {
    answers = { getSignatureStatuses: { result: sigStatus }, getAccountInfo: { result: account } };
    assert.deepEqual(await confirmLaunch({ signature: SIG, mint: MINT, fetchImpl }), expected);
  };

  await check(status('finalized'), mintAccount('spl-token-2022', 'mint'), { confirmed: true, status: 'finalized', err: null, mintExists: true, decimals: 6, supply: '1000000000000000' });
  assert.deepEqual(calls.map((c) => [c.url, c.body, c.headers]), [
    ['https://api.mainnet-beta.solana.com', { jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[SIG], { searchTransactionHistory: true }] }, { 'Content-Type': 'application/json' }],
    ['https://api.mainnet-beta.solana.com', { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [MINT, { encoding: 'jsonParsed', commitment: 'confirmed' }] }, { 'Content-Type': 'application/json' }],
  ]);
  await check(status('confirmed'), mintAccount('spl-token', 'mint'), { confirmed: true, status: 'confirmed', err: null, mintExists: true, decimals: 6, supply: '1000000000000000' });
  await check(status('processed'), { value: null }, { confirmed: false, status: 'processed', err: null, mintExists: false, decimals: null, supply: null });
  const err = { InstructionError: [2, { Custom: 6002 }] };
  await check(status('finalized', err), { value: null }, { confirmed: false, status: 'finalized', err, mintExists: false, decimals: null, supply: null });
  await check({ context: { slot: 1 }, value: [null] }, { value: null }, { confirmed: false, status: null, err: null, mintExists: false, decimals: null, supply: null });
  await check(status('finalized'), mintAccount('spl-token', 'account'), { confirmed: true, status: 'finalized', err: null, mintExists: false, decimals: null, supply: null });
  await check(status('finalized'), { value: { owner: SYSTEM, data: ['', 'base64'] } }, { confirmed: true, status: 'finalized', err: null, mintExists: false, decimals: null, supply: null });

  answers = { getSignatureStatuses: { error: { code: -32602, message: 'Invalid param: WrongSize' } }, getAccountInfo: { result: { value: null } } };
  await assert.rejects(confirmLaunch({ signature: SIG, mint: MINT, fetchImpl }), /RPC getSignatureStatuses error -32602: Invalid param: WrongSize/);
  answers = { getSlot: 'Too many requests for a specific RPC call' };
  await assert.rejects(rpc('getSlot', [], { url: 'https://rpc.example', fetchImpl }), /RPC getSlot HTTP 429: Too many requests/);
  answers = { getSlot: { result: 123 } };
  assert.equal(await rpc('getSlot', [], { url: 'https://rpc.example', fetchImpl }), 123);
  assert.equal(calls.at(-1).url, 'https://rpc.example');

  const n = calls.length;
  await assert.rejects(confirmLaunch({ signature: 'abc', mint: MINT, fetchImpl }), /signature must be a base58 transaction signature/);
  await assert.rejects(confirmLaunch({ signature: 'z'.repeat(100_000), mint: MINT, fetchImpl }), /signature must be a base58 transaction signature/);
  await assert.rejects(confirmLaunch({ signature: SIG, mint: 'abc', fetchImpl }), /mint is not a Solana address/);
  assert.equal(calls.length, n);
});

// ---- live, read-only: SOLANA_LIVE=1 node --test test/solana.test.js ----
// Nothing is sent to the chain, nothing is uploaded, and no key is funded or saved.

const live = { skip: process.env.SOLANA_LIVE !== '1' && 'set SOLANA_LIVE=1 for the read-only PumpPortal / Solana RPC checks', timeout: 120_000 };

test('live: PumpPortal builds unsigned create transactions (re-records pumpportal-create.*)', live, async (t) => {
  const out = {
    note: 'Unsigned create transactions PumpPortal trade-local built for throwaway random keys. Never signed or sent. Re-record with SOLANA_LIVE=1.',
    fetchedAt: new Date().toISOString(), fixtures: {},
  };
  fs.mkdirSync(FIXTURES, { recursive: true });
  for (const [file, amountSol] of [['pumpportal-create.bin', 0], ['pumpportal-create-devbuy.bin', 0.01]]) {
    const creator = generateKeypair().address, mint = generateKeypair().address;   // only the addresses are kept
    let request, response;
    const fetchImpl = async (url, init) => {
      request = JSON.parse(init.body);
      const res = await fetch(url, init);
      response = { url, status: res.status, contentType: res.headers.get('content-type') };
      return res;
    };
    const bytes = await pumpCreateTx({ publicKey: creator, mint, name: 'BRAINWORM', symbol: 'BRAINWORM', uri: 'https://example.com/brainworm.json', amountSol, fetchImpl });
    const tx = parseTransaction(bytes);
    assert.deepEqual(tx.accountKeys.slice(0, tx.header.numRequiredSignatures), [creator, mint]);
    assert.ok(verifyTransactionSignatures(bytes).every((s) => !s.present));
    fs.writeFileSync(new URL(file, FIXTURES), bytes);
    out.fixtures[file] = { request, response: { ...response, bytes: bytes.length }, creator, mint };
    t.diagnostic(`${file}: ${bytes.length} B, v${tx.version}, programs ${[...new Set(tx.instructions.map((ix) => tx.accountKeys[ix.programIdIndex]))].join(' ')}`);
  }
  fs.writeFileSync(new URL('pumpportal-create.json', FIXTURES), JSON.stringify(out, null, 2) + '\n');

  // the whole server-side step once for real: the throwaway mint signs, the result is thrown away
  const launch = await prepareLaunch({ creator: generateKeypair().address, name: 'BRAINWORM', symbol: 'BRAINWORM', uri: 'https://example.com/brainworm.json', amountSol: 0.01 });
  assert.deepEqual(verifyTransactionSignatures(Buffer.from(launch.tx, 'base64')).map((s) => [s.present, s.valid]), [[false, false], [true, true]]);
  t.diagnostic(`prepareLaunch: ${JSON.stringify(launch.summary)}`);
});

test('live: PumpPortal data websocket, a new token then its trades (re-records pumpportal-trade.json)', live, async (t) => {
  const apiKey = process.env.PUMPPORTAL_API_KEY || '';   // trades need a funded key; never logged or recorded
  const rec = {
    note: 'Recorded read-only from PumpPortal\'s data websocket (SOLANA_LIVE=1). Trade messages need a funded PumpPortal API key (PUMPPORTAL_API_KEY); without one, tradeReply is the refusal and trade is null.',
    recordedAt: new Date().toISOString(), url: DATA_WS_URL, withApiKey: !!apiKey, notices: [], newToken: null, tradeReply: null, trade: null,
  };
  const ws = new WebSocket(apiKey ? `${DATA_WS_URL}?api-key=${encodeURIComponent(apiKey)}` : DATA_WS_URL, { handshakeTimeout: 10_000 });
  const closed = once(ws, 'close');
  const phase = (ms, pick) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); ws.off('message', onMessage); resolve(); };
    const onMessage = (d) => {
      let m;
      try { m = JSON.parse(String(d)); } catch { return; }
      if (typeof m.message === 'string') rec.notices.push(m.message);
      if (pick(m)) done();
    };
    const timer = setTimeout(done, ms);
    ws.on('message', onMessage);
  });
  let mint;
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    await phase(30_000, (m) => m.txType === 'create' && isAddress(m.mint) && (rec.newToken = m));
    assert.ok(rec.newToken, 'no new token within 30 s');
    mint = rec.newToken.mint;
    ws.send(JSON.stringify({ method: 'unsubscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    await phase(30_000, (m) => {
      if (typeof m.message === 'string' && !/^unsubscribed/i.test(m.message)) rec.tradeReply ??= m.message;
      if ((m.txType === 'buy' || m.txType === 'sell') && m.mint === mint) rec.trade = m;
      return !!rec.trade || /only available|api key/i.test(rec.tradeReply ?? '');
    });
  } finally {
    ws.close(1000);
    await closed;
  }
  fs.writeFileSync(new URL('pumpportal-trade.json', FIXTURES), JSON.stringify(rec, null, 2) + '\n');
  t.diagnostic(`new token ${mint}; trade reply: ${rec.tradeReply}; trade: ${rec.trade ? JSON.stringify(normalizeTrade(rec.trade, mint)) : 'none'}`);
  if (rec.trade) assert.ok(normalizeTrade(rec.trade, mint));
  if (!apiKey) assert.match(rec.tradeReply, /API key/);

  // our client against the real server, briefly (a second, sequential connection)
  const stream = createTradeStream({ mint, apiKey, logger: quiet });
  stream.start();
  try {
    await until(() => stream.status().subscribed || stream.status().lastNotice, 15_000);
  } finally {
    await stream.stop();
  }
  const st = stream.status();
  t.diagnostic(`createTradeStream: ${JSON.stringify({ ...st, mint: undefined })}`);
  assert.equal(st.reconnects, 0);
  if (!apiKey) assert.equal(st.lastNotice, NO_KEY);
});

test('live: Solana RPC logs, a real pump.fun TradeEvent and PumpSwap trade decode (re-records pump-tradeevent.json)', live, async (t) => {
  const rec = {
    note: 'Real mainnet transactions seen read-only through logsSubscribe (SOLANA_LIVE=1). Logs are kept to program frames, '
      + 'instruction names and event data. pumpSwap.pool was read back from the pool account and equals pumpSwapPool(mint).',
    recordedAt: new Date().toISOString(), rpc: RPC_WS_URL, pump: null, pumpSwap: null,
  };
  const keep = (logs) => logs.filter((l) => /^Program (\w+ (invoke \[\d+\]|success|failed)|data: |log: Instruction: )/.test(l));
  const events = (logs, ...names) => logs.filter((l) => l.startsWith('Program data: ')).map((l) => Buffer.from(l.slice(14), 'base64'))
    .filter((d) => names.some((n) => eventDisc(n).equals(d.subarray(0, 8))));
  const ws = new WebSocket(RPC_WS_URL, { handshakeTimeout: 10_000 });
  const closed = once(ws, 'close');
  try {
    await once(ws, 'open');
    for (const [id, program] of [[1, PUMP_PROGRAM], [2, PUMP_AMM_PROGRAM]]) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [program] }, { commitment: 'confirmed' }] }));
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      let busy = false, lookups = 0;
      ws.on('message', async (raw) => {
        const m = JSON.parse(String(raw)), v = m.params?.result?.value;
        if (!v || v.err) return;
        const sample = (mint, extra = {}) => {
          const logs = keep(v.logs), trades = tradesFromLogs(logs, { mint, signature: v.signature }).map(({ ts, ...tr }) => tr);
          return trades.length ? { signature: v.signature, slot: m.params.result.context.slot, mint, ...extra, logs, trades } : null;
        };
        for (const d of rec.pump ? [] : events(v.logs, 'TradeEvent')) rec.pump ??= sample(b58encode(d.subarray(8, 40)));
        const swap = !rec.pumpSwap && !busy && lookups < 8 && events(v.logs, 'BuyEvent', 'SellEvent')[0];
        if (swap) {
          busy = true; lookups++;
          try {   // read-only: which coin is this pool for, and is it that coin's canonical pool?
            const pool = b58encode(swap.subarray(120, 152));
            const acc = await rpc('getAccountInfo', [pool, { encoding: 'base64' }]);
            const data = Buffer.from(acc?.value?.data?.[0] ?? '', 'base64');
            const mint = data.length >= 107 ? b58encode(data.subarray(43, 75)) : null;
            if (mint && b58encode(data.subarray(75, 107)) === WSOL_MINT && pumpSwapPool(mint) === pool) rec.pumpSwap = sample(mint, { pool });
          } catch (err) { t.diagnostic(`pool lookup failed: ${err.message}`); }
          busy = false;
        }
        if (rec.pump && rec.pumpSwap) { clearTimeout(timer); resolve(); }
      });
    });
  } finally {
    ws.close(1000);
    await closed;
  }
  assert.ok(rec.pump, 'no pump.fun TradeEvent decoded within 30 s');
  assert.ok(rec.pumpSwap, 'no trade in a canonical PumpSwap pool decoded within 30 s');
  fs.writeFileSync(new URL('pump-tradeevent.json', FIXTURES), JSON.stringify(rec, null, 2) + '\n');
  for (const s of [rec.pump, rec.pumpSwap]) {
    for (const tr of s.trades) assert.ok(tr.sol > 0 && tr.tokens > 0 && isAddress(tr.trader) && tr.marketCapSol > 0, JSON.stringify(tr));
    t.diagnostic(`${s.signature}: ${JSON.stringify(s.trades)}`);
  }

  // our stream on that coin for a moment: it has to subscribe; a trade may or may not come along
  const seen = [];
  const stream = createRpcTradeStream({ mint: rec.pump.mint, logger: quiet, onTrade: (tr) => seen.push(tr) });
  let st;
  stream.start();
  try {
    await until(() => stream.status().subscribed || stream.status().lastNotice, 15_000);
    await until(() => seen.length > 0, 15_000).catch(() => {});
    st = stream.status();
  } finally {
    await stream.stop();
  }
  t.diagnostic(`createRpcTradeStream on ${rec.pump.mint}: ${JSON.stringify({ ...st, mint: undefined })}; first trade ${JSON.stringify(seen[0] ?? null)}`);
  assert.equal(st.subscribed || st.trades > 0, true);
  assert.equal(st.reconnects, 0);
});

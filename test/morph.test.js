import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

// data/morph.bin is made by scripts/build-data/build_morph.py; the byte layout is documented there.
const BIN = fs.readFileSync(new URL('../data/morph.bin', import.meta.url));
const WIRING = fs.readFileSync(new URL('../data/wiring.json', import.meta.url));
const D = JSON.parse(WIRING);

const TYPES = {
  int8: [Int8Array, 1, 'getInt8'], int16: [Int16Array, 2, 'getInt16'],
  uint16: [Uint16Array, 2, 'getUint16'], uint32: [Uint32Array, 4, 'getUint32'],
};

/** Reference loader: reads morph.bin with a DataView only (little-endian regardless of platform). */
function parseMorph(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  const headerLength = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)));
  const s = {};
  for (const [name, sec] of Object.entries(header.sections)) {
    const [Arr, size, get] = TYPES[sec.type];
    const a = new Arr(sec.count * sec.components);
    for (let k = 0; k < a.length; k++) a[k] = dv[get](sec.offset + k * size, true);
    s[name] = a;
  }
  const { offset, step } = header.quant;
  const deq = (q) => { const v = new Float32Array(q.length); for (let k = 0; k < q.length; k++) v[k] = offset[k % 3] + q[k] * step[k % 3]; return v; };
  const unit = (q) => Float32Array.from(q, (x) => x / 127);
  return {
    magic, headerLength, header, s,
    points: deq(s.points), soma: deq(s.cellSoma),
    outline: { positions: deq(s.outlinePositions), normals: unit(s.outlineNormals), indices: s.outlineIndices },
    yolk: { positions: deq(s.yolkPositions), normals: unit(s.yolkNormals), indices: s.yolkIndices },
  };
}

/** What public/gl.js setMorph() takes: per-vertex cell (-1 = not a wiring node) and a GL_LINES index buffer. */
function toGL(m) {
  const { stripStart, stripLength, stripCell } = m.s;
  const cells = new Float32Array(m.points.length / 3);
  let segs = 0;
  for (let k = 0; k < stripStart.length; k++) segs += stripLength[k] - 1;
  const indices = new Uint32Array(segs * 2);
  let o = 0;
  for (let k = 0; k < stripStart.length; k++) {
    const c = stripCell[k] === m.header.noCell ? -1 : stripCell[k];
    for (let j = 0; j < stripLength[k]; j++) cells[stripStart[k] + j] = c;
    for (let j = 0; j + 1 < stripLength[k]; j++) { indices[o++] = stripStart[k] + j; indices[o++] = stripStart[k] + j + 1; }
  }
  return { points: m.points, cells, indices, outline: m.outline };
}

const M = parseMorph(BIN);
const H = M.header;
const positioned = D.n.map((n, i) => (n[5] && n[7] === 0 ? i : -1)).filter((i) => i >= 0);

test('morph.bin: magic, JSON header and aligned sections that tile the file', () => {
  assert.equal(M.magic, 'BWMORPH1');
  assert.equal(H.format, 'BWMORPH1');
  assert.equal(H.littleEndian, true);
  assert.equal((12 + M.headerLength) % 8, 0);
  const secs = Object.entries(H.sections).sort((a, b) => a[1].offset - b[1].offset);
  let at = 12 + M.headerLength;
  for (const [name, sec] of secs) {
    assert.equal(sec.offset, at, `${name} offset`);
    assert.equal(sec.offset % 8, 0, `${name} alignment`);
    assert.equal(sec.byteLength, sec.count * sec.components * TYPES[sec.type][1], `${name} length`);
    for (let k = sec.offset + sec.byteLength; k < Math.ceil((sec.offset + sec.byteLength) / 8) * 8; k++) assert.equal(BIN[k], 0);
    at = Math.ceil((sec.offset + sec.byteLength) / 8) * 8;
  }
  assert.equal(at, BIN.length);
  const c = H.counts, S = H.sections;
  assert.equal(S.points.count, c.points);
  for (const n of ['stripStart', 'stripLength', 'stripCell']) assert.equal(S[n].count, c.strips, n);
  for (const n of ['cellNode', 'cellType', 'cellFirstStrip', 'cellStripCount', 'cellSomaRadius', 'cellSoma', 'cellSkid']) assert.equal(S[n].count, c.cells, n);
  assert.equal(S.nodeSkid.count, D.n.length);
  assert.equal(S.outlinePositions.count, c.outlineVertices); assert.equal(S.outlineNormals.count, c.outlineVertices);
  assert.equal(S.outlineIndices.count, c.outlineTriangles);
  assert.equal(S.yolkPositions.count, c.yolkVertices); assert.equal(S.yolkIndices.count, c.yolkTriangles);
  assert.ok(BIN.length <= 3 * 1024 * 1024, `${BIN.length} bytes`);
});

test('morph.bin was built from this wiring.json', () => {
  assert.equal(H.wiring.sha1, crypto.createHash('sha1').update(WIRING).digest('hex'),
    'data/wiring.json changed: rebuild data/morph.bin with scripts/build-data/build_morph.py');
  assert.equal(H.wiring.nodes, D.n.length);
});

test('strips are contiguous, cover every point and belong to their cells', () => {
  const { stripStart, stripLength, stripCell, cellNode, cellType, cellFirstStrip, cellStripCount } = M.s;
  let at = 0;
  for (let k = 0; k < stripStart.length; k++) {
    assert.equal(stripStart[k], at);
    assert.ok(stripLength[k] >= 2);
    at += stripLength[k];
  }
  assert.equal(at, H.counts.points);
  let s = 0;
  for (let c = 0; c < cellNode.length; c++) {
    assert.equal(cellFirstStrip[c], s);
    assert.ok(cellStripCount[c] >= 1);
    assert.ok(cellType[c] < H.types.length);
    for (let k = s; k < s + cellStripCount[c]; k++) assert.equal(stripCell[k], cellNode[c]);
    s += cellStripCount[c];
  }
  assert.equal(s, H.counts.strips);
});

test('every cell index is a wiring node; every positioned node has one skeleton', () => {
  const seen = new Set();
  for (const i of M.s.cellNode) {
    if (i === H.noCell) continue;
    assert.ok(i < D.n.length, `cell index ${i}`);
    assert.ok(!seen.has(i), `node ${i} has two skeletons`);
    seen.add(i);
  }
  for (const i of M.s.stripCell) assert.ok(i === H.noCell || i < D.n.length);
  assert.deepEqual([...seen].sort((a, b) => a - b), positioned);
  assert.equal(seen.size, 1199);
  assert.equal(H.counts.matchedCells, 1199);
});

test('matched skeletons start at their node\'s soma', () => {
  const eps = 2e-4;                     // wiring positions are rounded to 4 decimals; int16 quantisation adds < 2e-5
  const { cellNode, cellFirstStrip, stripStart } = M.s;
  let n = 0;
  for (let c = 0; c < cellNode.length; c++) {
    const i = cellNode[c];
    if (i === H.noCell) continue;
    const p = D.n[i][5], k = stripStart[cellFirstStrip[c]];
    for (let a = 0; a < 3; a++) {
      assert.ok(Math.abs(M.points[3 * k + a] - p[a]) < eps, `node ${i} skeleton root axis ${a}`);
      assert.ok(Math.abs(M.soma[3 * c + a] - p[a]) < eps, `node ${i} soma axis ${a}`);
    }
    n++;
  }
  assert.equal(n, 1199);
});

// A viewer page lists its somata in ascending CATMAID skeleton id; where the page's soma count equals its type's id
// count, cellSkid is known. Every wiring node there must sit on its own soma, not on a sibling's.
const own = [];
for (let c = 0; c < M.s.cellNode.length; c++) if (M.s.cellNode[c] !== H.noCell && M.s.cellSkid[c]) own.push(c);

test('matched skeletons are the node\'s own cell wherever the page identifies its cells', () => {
  for (const c of own) assert.equal(M.s.cellSkid[c], M.s.nodeSkid[M.s.cellNode[c]], `node ${M.s.cellNode[c]}`);
  assert.equal(own.length, H.wiring.ownSoma);
  assert.ok(own.length >= 1084, `${own.length} nodes on their own soma`);
});

test('nodes on their own soma sit where the connectome says: side and segment', () => {
  const nodes = own.map((c) => D.n[M.s.cellNode[c]]);
  const sided = nodes.filter((n) => n[2] < 2);
  const wrong = sided.filter((n) => (n[2] === 0) !== (n[5][0] < 0));
  assert.ok(wrong.length / sided.length < 0.1, `${wrong.length}/${sided.length} on the other side`);
  for (const n of wrong) assert.ok(Math.abs(n[5][0]) < 0.2, `${n[0]} is far across the midline`);
  for (const n of nodes) {
    if (n[3] === 4 || n[3] === 5) assert.ok(n[5][1] < -0.2, `${n[0]} (segment 3 / pygidium) at y ${n[5][1]}`);
    if (n[3] === 0) assert.ok(n[5][1] > 0.1, `${n[0]} (head) at y ${n[5][1]}`);
  }
});

test('the outline is closed and its bounds enclose the drawn cells', () => {
  const { positions: V, normals: N, indices: I } = M.outline;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < V.length; k++) { lo[k % 3] = Math.min(lo[k % 3], V[k]); hi[k % 3] = Math.max(hi[k % 3], V[k]); }
  const drawn = D.n.filter((n) => n[5]);
  const inside = drawn.filter((n) => n[5].every((x, a) => x >= lo[a] && x <= hi[a])).length;
  assert.ok(inside / drawn.length >= 0.95, `${inside}/${drawn.length} drawn cells inside the outline bounds`);
  const nv = V.length / 3, edges = new Map();
  for (let t = 0; t < I.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + (e + 1) % 3];
      assert.ok(a < nv && b < nv);
      const key = Math.min(a, b) * nv + Math.max(a, b);
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  for (const c of edges.values()) assert.equal(c, 2);
  for (let k = 0; k < N.length; k += 3) assert.ok(Math.abs(Math.hypot(N[k], N[k + 1], N[k + 2]) - 1) < 0.02);
  const yv = M.yolk.positions.length / 3;
  for (const i of M.yolk.indices) assert.ok(i < yv);
});

test('converts to the arrays gl.js setMorph() takes', () => {
  const g = toGL(M);
  assert.equal(g.points.length, H.counts.points * 3);
  assert.equal(g.cells.length, H.counts.points);
  assert.equal(g.indices.length, 2 * (H.counts.points - H.counts.strips));
  for (const i of g.indices) assert.ok(i < H.counts.points);
  const lit = new Set(g.cells);
  assert.ok(lit.has(-1));
  assert.equal(lit.size - 1, 1199);
});

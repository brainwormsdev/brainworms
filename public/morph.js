// Loads data/morph.bin: the traced shape of every cell in the lab's 3D reconstruction (neurons,
// muscles, ciliated, gland, epidermal and pigment cells...), the published yolk mesh, and a body
// outline we derived around the traced cells. Format: scripts/build-data/build_morph.py.

export async function loadMorph(url = '/data/morph.bin') {
  const buf = await (await fetch(url)).arrayBuffer();
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (new TextDecoder().decode(u8.subarray(0, 8)) !== 'BWMORPH1') throw new Error('not a morph file');
  const H = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + H)));
  const TYPES = { int16: Int16Array, uint16: Uint16Array, uint32: Uint32Array, int8: Int8Array, uint8: Uint8Array, float32: Float32Array };
  const sec = (name) => {
    const s = header.sections[name]; if (!s) return null;
    const T = TYPES[s.type];
    return new T(buf, s.offset, s.byteLength / T.BYTES_PER_ELEMENT);
  };
  const { offset, step } = header.quant;
  const deq = (q) => { const out = new Float32Array(q.length); for (let i = 0; i < q.length; i += 3) for (let a = 0; a < 3; a++) out[i + a] = offset[a] + q[i + a] * step[a]; return out; };
  const noCell = header.noCell ?? 65535;

  const points = deq(sec('points'));
  const start = sec('stripStart'), len = sec('stripLength'), stripCell = sec('stripCell');
  const nPts = points.length / 3, cells = new Float32Array(nPts).fill(-1);
  let nSeg = 0;
  for (let k = 0; k < start.length; k++) nSeg += len[k] - 1;
  const indices = new Uint32Array(nSeg * 2);
  let o = 0;
  for (let k = 0; k < start.length; k++) {
    const s = start[k], n = len[k], c = stripCell[k] === noCell ? -1 : stripCell[k];
    for (let j = 0; j < n; j++) cells[s + j] = c;
    for (let j = 0; j < n - 1; j++) { indices[o++] = s + j; indices[o++] = s + j + 1; }
  }
  const mesh = (p) => {
    const pos = sec(p + 'Positions'); if (!pos) return null;
    const nq = sec(p + 'Normals'), normals = new Float32Array(nq.length);
    for (let i = 0; i < nq.length; i++) normals[i] = nq[i] / 127;
    const idx = sec(p + 'Indices');
    return { positions: deq(pos), normals, indices: idx instanceof Uint32Array ? idx : new Uint16Array(idx) };
  };
  return { header, points, cells, indices, outline: mesh('outline'), yolk: mesh('yolk'), umPerUnit: header.frame.umPerUnit, counts: header.counts };
}

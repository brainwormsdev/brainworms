// Binary activity frames streamed on /live. The server encodes each frame once for every viewer.
//   dense  (type 1): [1][step u32 LE][one byte per cell]
//   sparse (type 2): [2][step u32 LE][count u16 LE][cell u16 LE, value u8] x count   (cells not listed are 0)
//   types 3 and 4 are 1 and 2 with the body's pose inserted after the step (18 bytes): position xyz as
//   int16 in thousandths of a unit, quaternion wxyz as int16 / 32767, distance swum as float32 units
// Values are activity x 255. Anything under MIN_LEVEL is sent as 0: it's invisible and far below
// the 0.05 threshold used for "cells firing", so readouts computed from frames are unchanged.
export const FRAME_DENSE = 1, FRAME_SPARSE = 2, POSE_BYTES = 18;
const i16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));
export const MIN_LEVEL = 2;

/** Encode activity r (0..1) into a new Uint8Array, choosing the smaller layout; pose = [x,y,z, qw,qx,qy,qz, dist] or null. */
export function encodeFrame(r, step, pose = null) {
  const N = r.length, q = new Uint8Array(N), P = pose ? POSE_BYTES : 0;
  let count = 0;
  for (let i = 0; i < N; i++) {
    const v = r[i] * 255, b = v >= 255 ? 255 : v <= 0 ? 0 : Math.round(v);
    if (b >= MIN_LEVEL) { q[i] = b; count++; }
  }
  const sparse = 7 + 3 * count < 5 + N;
  const out = new Uint8Array((sparse ? 7 + 3 * count : 5 + N) + P), dv = new DataView(out.buffer);
  out[0] = (sparse ? FRAME_SPARSE : FRAME_DENSE) + (pose ? 2 : 0);
  dv.setUint32(1, step >>> 0, true);
  if (pose) {
    for (let k = 0; k < 3; k++) dv.setInt16(5 + k * 2, i16(pose[k] * 1000), true);
    for (let k = 3; k < 7; k++) dv.setInt16(5 + k * 2, i16(pose[k] * 32767), true);
    dv.setFloat32(19, pose[7], true);
  }
  if (sparse) {
    dv.setUint16(5 + P, count, true);
    let o = 7 + P;
    for (let i = 0; i < N; i++) if (q[i]) { dv.setUint16(o, i, true); out[o + 2] = q[i]; o += 3; }
  } else out.set(q, 5 + P);
  return out;
}

/** Decode a frame into `out` (one byte per cell) and, if present, the pose into `poseOut` (8 numbers). Returns the step, or -1. */
export function decodeFrame(buf, out, poseOut = null) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const raw = u8[0], step = dv.getUint32(1, true);
  if (raw < 1 || raw > 4) return -1;
  const P = raw > 2 ? POSE_BYTES : 0, type = raw > 2 ? raw - 2 : raw;
  if (P && poseOut) {
    for (let k = 0; k < 3; k++) poseOut[k] = dv.getInt16(5 + k * 2, true) / 1000;
    for (let k = 3; k < 7; k++) poseOut[k] = dv.getInt16(5 + k * 2, true) / 32767;
    poseOut[7] = dv.getFloat32(19, true);
  }
  if (type === FRAME_DENSE) { out.set(u8.subarray(5 + P, 5 + P + out.length)); return step; }
  out.fill(0);
  const count = dv.getUint16(5 + P, true);
  for (let k = 0, o = 7 + P; k < count; k++, o += 3) { const i = dv.getUint16(o, true); if (i < out.length) out[i] = u8[o + 2]; }
  return step;
}

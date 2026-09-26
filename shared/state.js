// JSON form of a WormCore snapshot, used for the hourly checkpoints in the event log.
// Float32 arrays are stored as little-endian base64 so the numbers survive exactly.

function f32ToB64(a) {
  const bytes = new Uint8Array(a.length * 4), dv = new DataView(bytes.buffer);
  for (let i = 0; i < a.length; i++) dv.setFloat32(i * 4, a[i], true);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToF32(b64) {
  const s = atob(b64), dv = new DataView(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) dv.setUint8(i, s.charCodeAt(i));
  const out = new Float32Array(s.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export const encodeSnapshot = (s) => ({ ...s, r: f32ToB64(s.r), fatigue: f32ToB64(s.fatigue) });
export const decodeSnapshot = (o) => ({ ...o, r: b64ToF32(o.r), fatigue: b64ToF32(o.fatigue) });

// The lamp: a point of light in the worm's tank. How much light each side's eyes get depends on
// where the lamp is and which way the body faces, so while it's lit the worm's own swimming changes
// what its eyes see: a closed loop from light, through the wiring, to the cilia and muscles and back.
//
// All of this is chosen by us (the real eyes' fields of view aren't in the data), and was written
// down, with the lab protocol that tests it, before any lamp was ever lit:
//  - each side's eyes look out sideways, a little forward and a little up (body frame: x right,
//    y head, z dorsal); the left eyes mirror the right ones
//  - a pigment cup: an eye sees light from its own side only, as the cosine of the angle off its axis
//  - brightness falls with distance d as 1 / (1 + (d / falloff)²), a softened inverse square
//  - the light each side sees drives that side's 13 photoreceptors the way a message's lit strip
//    does: min(1, EYE_GAIN × light)
//  - the non-directional light sensors don't respond: a point of light never fills the view
// Deterministic: only + − × ÷ and sqrt, like the body.
import { rotate } from './body.js';
import { EYE_GAIN } from './text.js';

export const LAMP = Object.freeze({
  steps: 900,                    // how long it stays lit (30 s)
  distance: 10,                  // units from the worm where it's lit (1 unit = 108 µm, so ~1.1 mm)
  falloff: 10,                   // units: at this distance it's half as bright as up close
  eye: Object.freeze([0.8, 0.5, 0.33]),   // the right eyes' direction in the body frame (x flips for the left)
  inside: 0.85,                  // a lamp stays within this fraction of the tank's radius
});

const unit = (v) => { const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A direction as a unit vector, or null if it isn't three finite numbers with some length. */
export function lampDir(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

/** Where a lamp lit `dir` of a worm at `p` goes: `distance` away, pulled in to stay inside the tank. */
export function placeLamp(p, dir, tank, P = LAMP) {
  let x = p[0] + dir[0] * P.distance, y = p[1] + dir[1] * P.distance, z = p[2] + dir[2] * P.distance;
  const d = Math.sqrt(x * x + y * y + z * z), max = tank * P.inside;
  if (d > max) { x *= max / d; y *= max / d; z *= max / d; }
  return [x, y, z];
}

/** The light each side's eyes get from a lamp at `pos`, for a body state {p, q}: {L, R, d}. */
export function lampLight(s, pos, P = LAMP) {
  const dx = pos[0] - s.p[0], dy = pos[1] - s.p[1], dz = pos[2] - s.p[2];
  const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
  const bright = 1 / (1 + d2 / (P.falloff * P.falloff));
  if (d < 1e-9) return { L: bright, R: bright, d };
  const u = [dx / d, dy / d, dz / d];
  const cL = dot(rotate(s.q, unit([-P.eye[0], P.eye[1], P.eye[2]])), u), cR = dot(rotate(s.q, unit(P.eye)), u);
  return { L: cL > 0 ? cL * bright : 0, R: cR > 0 ? cR * bright : 0, d };
}

/** Add a lamp's light to the photoreceptors' input. */
export function applyLamp(ext, roles, light) {
  const l = Math.min(1, EYE_GAIN * light.L), r = Math.min(1, EYE_GAIN * light.R);
  for (const i of roles.eyeL) ext[i] += l;
  for (const i of roles.eyeR) ext[i] += r;
}

// Cell roles, as encoded in data/wiring.json (field 6 is a bitmask).
// Node layout: [name, class, side, segment, typeLabel, position|null, roles, approxPosition]
//   class: 0 sensory, 1 interneuron, 2 motor neuron, 3 effector, 4 other, 5 fragment
//   side:  0 left, 1 right, 2 midline/unknown

export const ROLE = Object.freeze({ EYE: 1, CPRC: 2, TOUCH: 4, MUSL: 8, MUSR: 16, STARTLE: 32, CILIA: 64 });

export function indexRoles(D) {
  const N = D.n.length;
  const pick = (f) => { const a = []; for (let i = 0; i < N; i++) if (f(D.n[i])) a.push(i); return a; };
  const byName = (a, b) => (D.n[a][0] < D.n[b][0] ? -1 : D.n[a][0] > D.n[b][0] ? 1 : 0);
  const has = (bit) => (x) => (x[6] & bit) !== 0;
  const roles = {
    eyeL: pick((x) => has(ROLE.EYE)(x) && x[2] === 0).sort(byName),
    eyeR: pick((x) => has(ROLE.EYE)(x) && x[2] === 1).sort(byName),
    cprc: pick(has(ROLE.CPRC)),
    touch: pick((x) => has(ROLE.TOUCH)(x) && !!x[5]),
    musL: pick(has(ROLE.MUSL)),
    musR: pick(has(ROLE.MUSR)),
    startle: pick(has(ROLE.STARTLE)),
    cilL: pick((x) => has(ROLE.CILIA)(x) && x[2] === 0),
    cilR: pick((x) => has(ROLE.CILIA)(x) && x[2] === 1),
    drawn: pick((x) => !!x[5]),
  };
  roles.touchSet = new Set(roles.touch);
  return roles;
}

const mean = (r, ix) => { let s = 0; for (const i of ix) s += r[i]; return ix.length ? s / ix.length : 0; };

/** Summary readouts from activity r (Float32Array or Uint8Array scaled by `scale`). */
export function readouts(r, roles, scale = 1) {
  let nAct = 0;
  const th = 0.05 * scale;
  for (let i = 0; i < r.length; i++) if (r[i] > th) nAct++;
  return {
    nAct,
    bend: (mean(r, roles.musL) - mean(r, roles.musR)) / scale,   // + = left body-wall muscles more active
    cil: (mean(r, roles.cilL) - mean(r, roles.cilR)) / scale,    // + = left ciliary band more active
    st: mean(r, roles.startle) / scale,                           // chaetal + parapodial muscles
  };
}

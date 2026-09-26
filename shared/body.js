// The body: a swimming larva in a virtual tank, driven every step by the worm's own activity.
//
// What moves it (all chosen by us, in the spirit of what the lab describes for Platynereis larvae):
//  - the ciliary bands push it forward, head first, and spin it about its long axis (larvae swim in a helix)
//  - input to a ciliated cell arrests it: arrests on one side turn the body towards that side, arrests
//    everywhere stop the push and let it sink
//  - body-wall muscles: more activity on one side steers it to that side
//  - startle (chaetal and parapodial) muscles spread the bristles and brake it
//  - the tank is ours: when it bumps the wall it turns away, towards whichever side its spinning body
//    had turned to the wall at that moment
// Tiny animals live at low Reynolds number: no inertia, velocity is proportional to force.
// The body doesn't feed back into the brain. Deterministic: only + − × ÷ and sqrt (IEEE-exact in every engine).
export const BODY = Object.freeze({
  speed: 4.5,        // body-frame units/s at full beat (1 unit = 108 µm → ~0.5 mm/s)
  spin: 2.4,         // rad/s about the long axis at full beat
  bias: 0.9,         // rad/s constant yaw, which with the spin makes a helical path
  ciliaTurn: 2.2,    // rad/s per unit of left-right beat difference
  muscleTurn: 16,    // rad/s per unit of left-minus-right muscle activity
  arrestGain: 2.5,   // ciliated-cell activity → fraction of the band arrested
  sink: 0.7,         // units/s of sinking when fully arrested
  startleDrag: 5,    // how much the startle muscles brake it
  tank: 22,          // tank radius in units (~2.4 mm)
  wall: 6,           // rad/s it turns away after bumping the wall
  glance: 0.8,       // how far off straight-back-to-the-middle it turns away
});
export const UM_PER_UNIT = 107.995;   // the scale of data/wiring.json positions (data/morph.bin header)
const DT = 1 / 30;

const mean = (r, ix) => { let s = 0; for (const i of ix) s += r[i]; return ix.length ? s / ix.length : 0; };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rotate v by unit quaternion q = [w, x, y, z]. */
export function rotate(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const mulq = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const norm = (q) => { const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]); return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Body state in the drawing frame (x = right, y = head, z = dorsal; right-handed), in a world where
 * +y is up. It starts at the tank's centre, head up. `turn` is the steering the brain did (radians,
 * + = left), `dist` how far it has swum (units), `target` the direction it's turning to after a bump.
 */
export function createBody(P = BODY) {
  const s = { p: [0, 0, 0], q: [1, 0, 0, 0], turn: 0, dist: 0, beat: 1, speed: 0, target: null };
  return {
    P,
    get state() { return s; },
    /** One step. r = activity, roles from indexRoles, ro = readouts of this step. */
    step(r, roles, ro) {
      const arrestL = clamp01(mean(r, roles.cilL) * P.arrestGain), arrestR = clamp01(mean(r, roles.cilR) * P.arrestGain);
      const beatL = 1 - arrestL, beatR = 1 - arrestR, beat = (beatL + beatR) / 2;
      // steering in the body frame: +z turns the head towards the left side
      const steer = P.ciliaTurn * (beatR - beatL) + P.muscleTurn * ro.bend;
      const w = [0, P.spin * beat, P.bias + steer];
      s.q = norm(mulq(s.q, [1, 0.5 * w[0] * DT, 0.5 * w[1] * DT, 0.5 * w[2] * DT]));
      s.turn += steer * DT;
      let f = rotate(s.q, [0, 1, 0]);
      // turning away from the wall after a bump (a turn in the tank's frame)
      if (s.target) {
        if (dot(f, s.target) > 0.94) s.target = null;
        else {
          const t = s.target;
          let ax = f[1] * t[2] - f[2] * t[1], ay = f[2] * t[0] - f[0] * t[2], az = f[0] * t[1] - f[1] * t[0];
          let l = Math.sqrt(ax * ax + ay * ay + az * az);
          if (l < 1e-9) { [ax, ay, az] = rotate(s.q, [1, 0, 0]); l = 1; }
          const k = P.wall / l;
          s.q = norm(mulq([1, 0.5 * ax * k * DT, 0.5 * ay * k * DT, 0.5 * az * k * DT], s.q));
          f = rotate(s.q, [0, 1, 0]);
        }
      }
      // swim forward (head first), brake with the startle muscles, sink when the cilia stop
      const v = P.speed * beat / (1 + P.startleDrag * ro.st);
      const vy = -P.sink * (1 - beat);
      let nx = s.p[0] + f[0] * v * DT, ny = s.p[1] + (f[1] * v + vy) * DT, nz = s.p[2] + f[2] * v * DT;
      const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (d > P.tank) {
        nx *= P.tank / d; ny *= P.tank / d; nz *= P.tank / d;
        const o = [nx / P.tank, ny / P.tank, nz / P.tank];
        if (!s.target && dot(f, o) > 0) {
          // bumped: turn back in, off to whichever side its body faced the wall with
          const lat = rotate(s.q, [1, 0, 0]), lo = dot(lat, o);
          const t = [-o[0] + P.glance * (lat[0] - lo * o[0]), -o[1] + P.glance * (lat[1] - lo * o[1]), -o[2] + P.glance * (lat[2] - lo * o[2])];
          const tl = Math.sqrt(dot(t, t));
          s.target = [t[0] / tl, t[1] / tl, t[2] / tl];
        }
      }
      const dx = nx - s.p[0], dy = ny - s.p[1], dz = nz - s.p[2];
      const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
      s.dist += step; s.speed = step / DT; s.beat = beat;
      s.p = [nx, ny, nz];
    },
    snapshot() { return { p: [...s.p], q: [...s.q], turn: s.turn, dist: s.dist, beat: s.beat, speed: s.speed, target: s.target && [...s.target] }; },
    restore(o) {
      s.p = [...o.p]; s.q = [...o.q]; s.turn = o.turn; s.dist = o.dist; s.beat = o.beat; s.speed = o.speed;
      s.target = o.target ? [...o.target] : null;
    },
  };
}

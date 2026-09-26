// The swim, drawn: the worm's path through its virtual tank, seen from a little above and slowly
// circling. Positions are the body's (shared/body.js), in body units, with +y up.
import { rotate } from '/shared/body.js';

const CYAN = '86,230,210', AMBER = '255,184,77', CORAL = '255,107,94';

export function createTank(canvas, { tank, umPerUnit, still = false }) {
  const g = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  // the glass: five latitude rings and six meridians
  const ring = (n, f) => Array.from({ length: n + 1 }, (_, k) => f((k / n) * Math.PI * 2));
  const wires = [];
  for (const lat of [-60, -30, 0, 30, 60]) {
    const a = (lat * Math.PI) / 180, y = tank * Math.sin(a), r = tank * Math.cos(a);
    wires.push({ pts: ring(72, (t) => [r * Math.cos(t), y, r * Math.sin(t)]), eq: lat === 0 });
  }
  for (let k = 0; k < 6; k++) {
    const b = (k * Math.PI) / 6;
    wires.push({ pts: ring(72, (t) => [tank * Math.cos(t) * Math.cos(b), tank * Math.sin(t), tank * Math.cos(t) * Math.sin(b)]) });
  }

  function fit() {
    const w = canvas.clientWidth, h = canvas.clientHeight, d = Math.min(2, window.devicePixelRatio || 1);
    if (w !== W || h !== H || d !== DPR) { W = w; H = h; DPR = d; canvas.width = Math.round(w * d); canvas.height = Math.round(h * d); }
    return W > 0 && H > 0;
  }

  /** pose: {p, q}; trail: flat [x,y,z, ...] oldest first; beat 0..1; st 0..1; time in seconds; lamp: [x,y,z] or null. */
  function draw({ p, q, trail, beat, st, time, lamp = null }) {
    if (!fit()) return;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    const R = Math.min(W, H) * 0.43, s = R / tank, cx = W / 2, cy = H / 2 + 2;
    const yaw = still ? 0.7 : 0.7 + time * ((Math.PI * 2) / 120), pitch = 0.38;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // [screen x, screen y, depth (+ = towards the viewer)]
    const P = (x, y, z) => { const rx = x * cyw - z * syw, rz = x * syw + z * cyw; return [cx + rx * s, cy - (y * cp - rz * sp) * s, y * sp + rz * cp]; };

    // water and glass
    const fill = g.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
    fill.addColorStop(0, `rgba(${CYAN},0.075)`); fill.addColorStop(1, `rgba(${CYAN},0.012)`);
    g.fillStyle = fill; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    const back = new Path2D(), front = new Path2D(), eqBack = new Path2D(), eqFront = new Path2D();
    for (const w of wires) {
      let prev = P(...w.pts[0]);
      for (let k = 1; k < w.pts.length; k++) {
        const cur = P(...w.pts[k]), path = (prev[2] + cur[2] > 0) ? (w.eq ? eqFront : front) : (w.eq ? eqBack : back);
        path.moveTo(prev[0], prev[1]); path.lineTo(cur[0], cur[1]);
        prev = cur;
      }
    }
    g.lineWidth = 1;
    g.strokeStyle = `rgba(${CYAN},0.05)`; g.stroke(back);
    g.strokeStyle = `rgba(${CYAN},0.09)`; g.stroke(eqBack);
    g.strokeStyle = `rgba(${CYAN},0.11)`; g.stroke(front);
    g.strokeStyle = `rgba(${CYAN},0.2)`; g.stroke(eqFront);
    g.strokeStyle = 'rgba(170,225,235,0.26)'; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(220,245,250,0.28)'; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, R - 3, Math.PI * 1.08, Math.PI * 1.36); g.stroke();

    // the path: older is fainter, the far side dimmer
    const n = trail.length / 3;
    if (n > 1) {
      const B = 12, paths = Array.from({ length: B * 2 }, () => new Path2D());
      let prev = P(trail[0], trail[1], trail[2]);
      for (let k = 1; k <= n; k++) {
        const cur = k < n ? P(trail[k * 3], trail[k * 3 + 1], trail[k * 3 + 2]) : P(p[0], p[1], p[2]);
        const b = Math.min(B - 1, Math.floor((k / n) * B)), side = prev[2] + cur[2] > 0 ? 1 : 0;
        const path = paths[b * 2 + side]; path.moveTo(prev[0], prev[1]); path.lineTo(cur[0], cur[1]);
        prev = cur;
      }
      g.lineWidth = 1.4; g.lineCap = 'round';
      for (let b = 0; b < B; b++) for (let side = 0; side < 2; side++) {
        const a = (0.05 + 0.75 * Math.pow((b + 1) / B, 1.6)) * (side ? 1 : 0.55);
        g.strokeStyle = `rgba(${CYAN},${a.toFixed(3)})`; g.stroke(paths[b * 2 + side]);
      }
    }

    // the lamp, and a faint line from the worm to it
    if (lamp) {
      const l = P(lamp[0], lamp[1], lamp[2]), w0 = P(p[0], p[1], p[2]);
      g.setLineDash([1, 4]); g.strokeStyle = 'rgba(255,226,176,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(w0[0], w0[1]); g.lineTo(l[0], l[1]); g.stroke(); g.setLineDash([]);
      const pulse = 1 + 0.08 * Math.sin(time * 5), rr = 26 * pulse;
      const halo = g.createRadialGradient(l[0], l[1], 0, l[0], l[1], rr);
      halo.addColorStop(0, 'rgba(255,248,230,0.95)'); halo.addColorStop(0.12, 'rgba(255,226,176,0.7)'); halo.addColorStop(0.45, 'rgba(255,184,77,0.18)'); halo.addColorStop(1, 'rgba(255,184,77,0)');
      g.fillStyle = halo; g.beginPath(); g.arc(l[0], l[1], rr, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,248,230,0.8)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(l[0] - 7, l[1]); g.lineTo(l[0] + 7, l[1]); g.moveTo(l[0], l[1] - 7); g.lineTo(l[0], l[1] + 7); g.stroke();
    }

    // where it is: a drop line to the floor, then the larva (drawn larger than life so it can be seen)
    const c = P(p[0], p[1], p[2]);
    const floorY = -Math.sqrt(Math.max(0, tank * tank - p[0] * p[0] - p[2] * p[2]));
    const fl = P(p[0], floorY, p[2]);
    g.setLineDash([2, 3]); g.strokeStyle = `rgba(${AMBER},0.28)`; g.lineWidth = 1;
    g.beginPath(); g.moveTo(c[0], c[1]); g.lineTo(fl[0], fl[1]); g.stroke(); g.setLineDash([]);
    g.strokeStyle = `rgba(${AMBER},0.35)`; g.beginPath(); g.ellipse(fl[0], fl[1], 4, 4 * sp, 0, 0, Math.PI * 2); g.stroke();

    const f = rotate(q, [0, 1, 0]), L = 1.9;
    const head = P(p[0] + f[0] * L, p[1] + f[1] * L, p[2] + f[2] * L), tail = P(p[0] - f[0] * L, p[1] - f[1] * L, p[2] - f[2] * L);
    if (beat < 0.7) {
      const k = (0.7 - beat) / 0.7;
      g.strokeStyle = `rgba(${CORAL},${(0.25 + 0.6 * k).toFixed(3)})`; g.lineWidth = 1.2;
      g.beginPath(); g.arc(c[0], c[1], 7 + 5 * k + 2 * Math.sin(time * 9), 0, Math.PI * 2); g.stroke();
    }
    if (st > 0.3) { g.strokeStyle = `rgba(255,255,255,${Math.min(0.8, st).toFixed(3)})`; g.lineWidth = 1; g.beginPath(); g.arc(c[0], c[1], 11 + 8 * st, 0, Math.PI * 2); g.stroke(); }
    const glow = g.createRadialGradient(c[0], c[1], 0, c[0], c[1], 16);
    glow.addColorStop(0, `rgba(${AMBER},0.32)`); glow.addColorStop(1, `rgba(${AMBER},0)`);
    g.fillStyle = glow; g.beginPath(); g.arc(c[0], c[1], 16, 0, Math.PI * 2); g.fill();
    const body = g.createLinearGradient(tail[0], tail[1], head[0], head[1]);
    body.addColorStop(0, 'rgba(255,214,170,0.5)'); body.addColorStop(1, 'rgba(255,196,110,1)');
    g.strokeStyle = body; g.lineCap = 'round'; g.lineWidth = Math.max(3.2, 0.9 * s);
    g.beginPath(); g.moveTo(tail[0], tail[1]); g.lineTo(head[0], head[1]); g.stroke();
    g.fillStyle = '#FFF1D6'; g.beginPath(); g.arc(head[0], head[1], 1.6, 0, Math.PI * 2); g.fill();

    // scale and orientation
    const mm = (1000 / umPerUnit) * s;
    g.fillStyle = 'rgba(160,185,195,0.55)'; g.font = '500 9px "Geist Mono", ui-monospace, monospace'; g.textBaseline = 'alphabetic';
    g.fillRect(6, H - 9, mm, 1); g.fillRect(6, H - 12, 1, 4); g.fillRect(6 + mm - 1, H - 12, 1, 4);
    g.fillText('1 mm', 6, H - 14);
    g.fillText('↑ UP', 6, 12);
  }

  return { draw };
}

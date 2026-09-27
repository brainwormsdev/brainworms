// The cilia rule of model v2 (shared/model.js): a ciliated cell stops beating in proportion to the
// activity of its cholinergic inputs, and serotonergic input keeps it beating:
//   arrest = A × (1 − S), A and S = the synapse-weighted mean activity of its cholinergic and
//   serotonergic inputs (0 if it has none). A side beats at 1 − the mean arrest of its ciliated cells.
// Transmitters come from data/transmitters.json (D.tx, by node index). Everything here is read from the
// wiring it's given, so a scrambled wiring gets its own ciliary inputs. Plain arithmetic only.
import { ROLE } from './roles.js';

const has = (D, i, t) => { const v = D.tx && D.tx[i]; return !!v && v.includes(t); };

/** Which cells are ciliated (by side and band), and their cholinergic and serotonergic inputs. */
export function ciliaInputs(D) {
  if (!D.tx) throw new Error('model v2 needs the transmitters (data/transmitters.json as D.tx)');
  const N = D.n.length, E = D.e;
  const isCil = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (D.n[i][6] & ROLE.CILIA) isCil[i] = 1;
  const achPre = new Map(), serPre = new Map();   // ciliated cell -> [[pre, synapses], ...]
  for (let k = 0; k < E.length; k += 3) {
    const a = E[k], b = E[k + 1], s = E[k + 2];
    if (!isCil[b]) continue;
    if (has(D, a, 'cholinergic')) { if (!achPre.has(b)) achPre.set(b, []); achPre.get(b).push(a, s); }
    if (has(D, a, 'serotonergic')) { if (!serPre.has(b)) serPre.set(b, []); serPre.get(b).push(a, s); }
  }
  const cells = [];
  for (let c = 0; c < N; c++) {
    if (!isCil[c]) continue;
    const ach = achPre.get(c) || [], ser = serPre.get(c) || [];
    let achTot = 0, serTot = 0;
    for (let k = 1; k < ach.length; k += 2) achTot += ach[k];
    for (let k = 1; k < ser.length; k += 2) serTot += ser[k];
    const name = D.n[c][0] || '';
    cells.push({ i: c, side: D.n[c][2], band: (name.match(/^(prototroch|paratroch|akrotroch|metatroch)/) || [, 'other'])[1], ach, achTot, ser, serTot });
  }
  return { cells, L: cells.filter((x) => x.side === 0), R: cells.filter((x) => x.side === 1) };
}

/** Arrest of one ciliated cell (0 = beating, 1 = stopped) given activity r (scaled by `scale`, e.g. 255 for bytes). */
export function arrestOf(x, r, scale = 1) {
  if (!x.achTot) return 0;
  let a = 0;
  for (let k = 0; k < x.ach.length; k += 2) a += x.ach[k + 1] * r[x.ach[k]];
  a = a / x.achTot / scale;
  let s = 0;
  if (x.serTot) { for (let k = 0; k < x.ser.length; k += 2) s += x.ser[k + 1] * r[x.ser[k]]; s = s / x.serTot / scale; }
  const v = a * (1 - s);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const meanArrest = (list, r, scale) => { let t = 0; for (const x of list) t += arrestOf(x, r, scale); return list.length ? t / list.length : 0; };

/** Each side's beat (1 = all beating) and mean arrest. */
export function beats(ci, r, scale = 1) {
  const aL = meanArrest(ci.L, r, scale), aR = meanArrest(ci.R, r, scale);
  return { L: 1 - aL, R: 1 - aR, arrestL: aL, arrestR: aR };
}

/** Mean arrest of every ciliated cell (both sides and the midline). */
export const meanArrestAll = (ci, r, scale = 1) => meanArrest(ci.cells, r, scale);

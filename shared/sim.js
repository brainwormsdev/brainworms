// Model v2 (registered in shared/model.js): firing-rate cells on the published Platynereis whole-body
// connectome.
//
// What is fixed by the data: which cell connects to which, and how many synapses.
// A connection's strength is its synapse count times one number, PARAMS.strength, set by the registered
// no-amplification rule (1 / the largest eigenvalue of the synapse-count matrix), so no loop in the
// wiring can grow on its own. Synapses from serotonergic cells onto the cholinergic cells that drive the
// cilia are inhibitory (the lab found serotonin inhibits that rhythm); every other synapse is excitatory,
// because the transmitter is unknown for 97% of cells. Slow per-cell fatigue. Nothing is trained.
// tanh comes from detmath.js (plain arithmetic), so every JavaScript engine computes identical activity.
import { tanh } from './detmath.js';
import { MODEL_V2 } from './model.js';
import { ROLE } from './roles.js';

export const PARAMS = Object.freeze({
  strength: MODEL_V2.params.strength,   // per synapse (registered: 1 / 30.998)
  tau: MODEL_V2.params.tau,             // rate time constant, in steps
  tauA: MODEL_V2.params.tauA,           // fatigue time constant, in steps
  adapt: MODEL_V2.params.adapt,         // fatigue strength
  theta: MODEL_V2.params.theta,         // firing threshold
});

export const STEPS_PER_SECOND = 30;

/** Model v2's inhibitory synapses: from a serotonergic cell onto a cholinergic cell that synapses on a ciliated cell. Returns a Uint8Array flag per connection. */
export function inhibitorySynapses(D) {
  if (!D.tx) throw new Error('model v2 needs the transmitters (data/transmitters.json as D.tx)');
  const N = D.n.length, E = D.e, M = E.length / 3;
  const tx = (i, t) => { const v = D.tx[i]; return !!v && v.includes(t); };
  const ciliomotor = new Uint8Array(N);
  for (let k = 0; k < E.length; k += 3) if (tx(E[k], 'cholinergic') && (D.n[E[k + 1]][6] & ROLE.CILIA)) ciliomotor[E[k]] = 1;
  const inh = new Uint8Array(M);
  for (let m = 0; m < M; m++) if (tx(E[3 * m], 'serotonergic') && ciliomotor[E[3 * m + 1]]) inh[m] = 1;
  return inh;
}

/**
 * @param {{n: any[], e: number[], tx: object}} D  wiring data (data/wiring.json) with its transmitters
 * @param {typeof PARAMS} P
 */
export function makeSim(D, P = PARAMS) {
  const N = D.n.length, E = D.e, M = E.length / 3;
  const inh = inhibitorySynapses(D);

  // incoming synapses grouped by post-synaptic cell (CSR)
  const rowStart = new Int32Array(N + 1);
  for (let k = 0; k < E.length; k += 3) rowStart[E[k + 1] + 1]++;
  for (let i = 0; i < N; i++) rowStart[i + 1] += rowStart[i];
  const pre = new Int32Array(M), w = new Float64Array(M), fill = rowStart.slice(0, N), posIn = new Float64Array(N);
  for (let m = 0; m < M; m++) {
    const b = E[3 * m + 1], j = fill[b]++;
    pre[j] = E[3 * m];
    w[j] = (inh[m] ? -1 : 1) * E[3 * m + 2] * P.strength;
    if (w[j] > 0) posIn[b] += w[j];
  }
  let maxIn = 0;
  for (let i = 0; i < N; i++) if (posIn[i] > maxIn) maxIn = posIn[i];

  const r = new Float32Array(N), fatigue = new Float32Array(N), ext = new Float32Array(N), next = new Float32Array(N);

  function step() {
    for (let i = 0; i < N; i++) {
      let s = ext[i];
      for (let j = rowStart[i], end = rowStart[i + 1]; j < end; j++) s += w[j] * r[pre[j]];
      s -= P.adapt * fatigue[i];
      const f = s > P.theta ? tanh(s - P.theta) : 0;
      next[i] = r[i] + (f - r[i]) / P.tau;
    }
    for (let i = 0; i < N; i++) {
      r[i] = next[i];
      fatigue[i] += (r[i] - fatigue[i]) / P.tauA;
    }
  }

  function reset() { r.fill(0); fatigue.fill(0); ext.fill(0); }

  // maxIn: the largest total excitatory input weight any cell has (used to prove when activity can only decay)
  return { N, r, fatigue, ext, step, reset, P, maxIn, inhibitory: inh };
}

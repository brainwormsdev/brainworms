// Firing-rate model on the published Platynereis whole-body connectome.
//
// What is fixed by the data: which cell connects to which, and how many synapses.
// What is simplified (and stated on the site): every synapse is excitatory, because
// transmitter identity is unknown for most cells; one global gain; slow per-cell fatigue.
// Nothing is trained. Do not add per-synapse weights beyond the published counts.

export const PARAMS = Object.freeze({
  gain: 2.2,   // global gain on normalised synaptic input
  tau: 3,      // rate time constant, in steps
  tauA: 40,    // fatigue time constant, in steps
  adapt: 1.5,  // fatigue strength
  theta: 0.05, // firing threshold
});

export const STEPS_PER_SECOND = 30;

/**
 * @param {{n: any[], e: number[]}} D  wiring data (data/wiring.json)
 * @param {typeof PARAMS} P
 */
export function makeSim(D, P = PARAMS) {
  const N = D.n.length, E = D.e;
  const inTot = new Float32Array(N);
  for (let k = 0; k < E.length; k += 3) inTot[E[k + 1]] += E[k + 2];

  // incoming synapses grouped by post-synaptic cell (CSR)
  const rowStart = new Int32Array(N + 1);
  for (let k = 0; k < E.length; k += 3) rowStart[E[k + 1] + 1]++;
  for (let i = 0; i < N; i++) rowStart[i + 1] += rowStart[i];
  const M = E.length / 3, pre = new Int32Array(M), w = new Float32Array(M), fill = rowStart.slice(0, N);
  for (let k = 0; k < E.length; k += 3) {
    const j = fill[E[k + 1]]++;
    pre[j] = E[k];
    w[j] = E[k + 2] / inTot[E[k + 1]];
  }

  const r = new Float32Array(N), fatigue = new Float32Array(N), ext = new Float32Array(N), next = new Float32Array(N);

  function step() {
    for (let i = 0; i < N; i++) {
      let s = ext[i];
      for (let j = rowStart[i], end = rowStart[i + 1]; j < end; j++) s += P.gain * w[j] * r[pre[j]];
      s -= P.adapt * fatigue[i];
      const f = s > P.theta ? Math.tanh(s - P.theta) : 0;
      next[i] = r[i] + (f - r[i]) / P.tau;
    }
    for (let i = 0; i < N; i++) {
      r[i] = next[i];
      fatigue[i] += (r[i] - fatigue[i]) / P.tauA;
    }
  }

  function reset() { r.fill(0); fatigue.fill(0); ext.fill(0); }

  return { N, r, ext, step, reset, P };
}

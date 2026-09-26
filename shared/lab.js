// The lab: pre-registered, deterministic, controlled experiments on the worm's real wiring.
//
// Every experiment below was written down (question, stimulus, measure, control, pass rule, every
// chosen number, seed) before it was ever run, and its result is published whether it passes or
// fails. A rule is never edited after its result is known: if one turns out to be ill-posed, it
// stays here with its result and a new, separately versioned protocol is added next to it.
//
// The main control is the wiring itself: each experiment is repeated on degree-preserving scrambles
// (Maslov–Sneppen swaps), worms with exactly the same cells, the same number of inputs and outputs
// per cell and the same synapse counts, but with who-connects-to-whom shuffled. If the real wiring
// does no better than those, that is the result.
//
// Pure and deterministic like the rest of shared/: no Math.random, Date, timers or I/O; only + - * /
// and exactly rounded Math functions (floor, abs, min, max, sqrt, imul); a seeded integer PRNG.
// Anyone can re-run it: `node scripts/lab.js`.
import { makeSim, PARAMS, STEPS_PER_SECOND } from './sim.js';
import { indexRoles, readouts, ROLE } from './roles.js';
import { WormCore } from './worm.js';
import { GLYPHS } from './glyphs.js';
import { LAMP, placeLamp, lampDir } from './lamp.js';
import { BODY, UM_PER_UNIT } from './body.js';

export const LAB_VERSION = 1;

const SEED = 20260926;   // chosen: the date these protocols were written, before any result existed

const SCRAMBLES = 'the same test on 50 degree-preserving scrambles of the wiring. A scramble picks two connections a→b and c→d at random and rewires them to a→d and c→b, unless that would connect a cell to itself or duplicate an existing connection; each connection keeps its synapse count and its sending cell. Every cell keeps its number of inputs and outputs, and every sensor and muscle stays where it is; only who connects to whom is shuffled. 10 × (number of connections) successful swaps per scramble; scramble k (k = 0…49) is seeded from the protocol seed and k.';
const P95 = 'p95 = the 95th percentile of the 50 scramble values, by linear interpolation between the sorted values (the numpy and R default). Also reported, not used for the verdict: the percentile (share of scrambles below the real value, ties count half) and the Monte Carlo p-value (1 + scrambles at or above the real value) / (1 + scrambles)';

const scrambleChoices = [
  { name: 'scrambles', value: 50, why: 'enough for a 95th percentile; the whole lab stays a few seconds of CPU' },
  { name: 'swaps per scramble', value: '10 × connections', why: 'the usual amount for Maslov–Sneppen shuffling' },
  { name: 'seed', value: SEED, why: 'fixed in advance: the date the protocols were written' },
];

const PROTOCOLS_V1 = [
  {
    id: 'eyes-sides',
    version: 1,
    kind: 'eyes-sides',
    registered: '2026-09-26',
    title: 'Light on one side',
    question: 'Does light on one side reach one side?',
    stimulus: 'A fresh worm at rest gets a constant drive of 1.0 into its 13 left photoreceptors only, for 30 steps (1 s), then darkness. A second fresh worm gets exactly the same into its 13 right photoreceptors only.',
    measure: 'Over the 90 steps (3 s) from light onset: the mean of cil (mean activity of the left ciliary-band cells minus the right ones: prototroch, paratrochs, akrotroch, metatroch) and the mean of bend (left longitudinal body-wall muscles minus right). L_cil = cil with left light − cil with right light; L_bend likewise. Subtracting the right-light run cancels any fixed left/right imbalance of the body and keeps only the part that follows the side of the light. Positive = the lit side is more active (same side), negative = the opposite side is. Lateralization = |L_cil| + |L_bend|.',
    control: `Wiring control: ${SCRAMBLES}`,
    rule: `Passes if the real wiring's lateralization is greater than p95 of the scrambles' lateralizations; otherwise fails. ${P95}. The sign and the two parts are reported but do not decide the verdict.`,
    chosen: [
      { name: 'drive', value: 1, why: 'the most a message can give one photoreceptor on the site' },
      { name: 'light on', value: '30 steps (1 s)', why: 'long enough for activity to cross several synapses (rate time constant 3 steps)' },
      { name: 'window', value: '90 steps (3 s)', why: 'the light plus 2 s for activity to settle' },
      { name: 'statistic', value: 'mean over the window; |L_cil| + |L_bend|', why: 'one number covering both kinds of mover; each part is also reported' },
      ...scrambleChoices,
      { name: 'pass threshold', value: '95th percentile of the scrambles', why: 'the conventional 5% level' },
    ],
    caveats: [
      'Every synapse is modelled as excitatory (transmitters are unknown for most cells), so a crossed inhibitory circuit cannot show up here.',
      'The size of a left/right difference also grows with how strongly light reaches the movers at all; the mean activity of the movers is reported next to it.',
    ],
    seed: SEED,
    params: { drive: 1, onSteps: 30, windowSteps: 90, scrambles: 50, swapsPerEdge: 10, percentile: 95 },
  },
  {
    id: 'touch-startle',
    version: 1,
    kind: 'touch-startle',
    registered: '2026-09-26',
    title: 'Touch and startle',
    question: 'Does touch reach the startle muscles?',
    stimulus: 'A fresh worm at rest gets a drive of 0.5 into all 53 touch sensors for 10 steps (1/3 s). Touch sensors = the cells with the touch role (collar receptors and chaetal mechanosensors) minus 4 eyespot photoreceptors (eyespot-PRCR1/3) that carry the touch role only because the naming rule matches the "CR" in "PRCR". For comparison, fresh worms get exactly the same drive into 53 other sensory neurons: sensory cells that are not photoreceptors, not non-directional light sensors and not touch sensors, and have at least one outgoing synapse, drawn at random by seed; 10 separate draws.',
    measure: 'The peak, over the 90 steps (3 s) from onset, of st: the mean activity of the 192 startle muscles (chaetal, acicular and oblique muscles). Touch response = that peak for the touch sensors. Other-sensory response = the mean of the 10 draws\' peaks.',
    control: `Within the real wiring: the 10 other-sensory draws. Wiring control, with the touch stimulus: ${SCRAMBLES}`,
    rule: `Passes if the real touch response is at least 2× the other-sensory response AND greater than p95 of the scrambles' touch responses; otherwise fails. ${P95}.`,
    chosen: [
      { name: 'drive', value: 0.5, why: 'modest: half the strongest eye drive and below a poke (1.2), so the whole body is not simply saturated' },
      { name: 'drive time', value: '10 steps (1/3 s)', why: 'a brief touch, about as much total drive as one poke' },
      { name: 'window', value: '90 steps (3 s)', why: 'the touch plus time for activity to cross several synapses and settle' },
      { name: 'touch cells', value: 'touch role minus the 4 eyespot photoreceptors (53 cells)', why: 'those 4 are photoreceptors mislabelled by a name rule, not touch sensors' },
      { name: 'comparison cells', value: '53 other sensory neurons with at least one outgoing synapse, 10 seeded draws', why: 'same number of cells as the touch sensors; cells with no outgoing synapse could not pass anything on; 10 draws so one lucky draw cannot decide it' },
      { name: 'specificity factor', value: 2, why: 'touch should beat other senses clearly, not marginally' },
      ...scrambleChoices,
      { name: 'pass threshold', value: '95th percentile of the scrambles', why: 'the conventional 5% level' },
    ],
    caveats: [
      'Every synapse is modelled as excitatory, so all sensory input tends to spread; the other-sensory comparison is there to show whether touch is special.',
    ],
    seed: SEED,
    params: { drive: 0.5, onSteps: 10, windowSteps: 90, otherDraws: 10, ratio: 2, touchExcludesEyes: true, scrambles: 50, swapsPerEdge: 10, percentile: 95 },
  },
  {
    id: 'light-latency',
    version: 1,
    kind: 'light-latency',
    registered: '2026-09-26',
    title: 'Light to muscle',
    question: 'How long does light take to reach a muscle?',
    stimulus: 'A fresh worm at rest gets a constant drive of 1.0 into all 26 photoreceptors (both sides), held until a muscle responds or for at most 150 steps (5 s).',
    measure: 'Latency: the number of steps from light onset until any body-wall or startle muscle (275 cells) first has activity above 0.05, the site\'s firing threshold; also in milliseconds at 30 steps per second. No muscle above 0.05 within 150 steps = no response.',
    control: `Wiring control: ${SCRAMBLES}`,
    rule: 'No pass rule: measured and published whatever it is. Percentile = the share of scrambles with a shorter latency (ties count half); a scramble with no response counts as slower than any response. Mean, sd and p95 of the scrambles are over the ones that responded.',
    chosen: [
      { name: 'drive', value: 1, why: 'the most a message can give one photoreceptor on the site' },
      { name: 'longest wait', value: '150 steps (5 s)', why: 'far longer than a message takes to excite the body' },
      { name: 'response threshold', value: 0.05, why: 'the same threshold the site uses for "firing"' },
      ...scrambleChoices,
    ],
    caveats: [
      'A step is the model\'s time unit (1/30 s on the site); the milliseconds are model time, not measured larval physiology.',
    ],
    seed: SEED,
    params: { drive: 1, maxSteps: 150, threshold: 0.05, scrambles: 50, swapsPerEdge: 10 },
  },
  {
    id: 'alphabet',
    version: 1,
    kind: 'alphabet',
    registered: '2026-09-26',
    title: 'The alphabet',
    question: 'Which glyph\'s light pattern fires the most cells?',
    stimulus: 'Every glyph in shared/glyphs.js (printable ASCII plus the solid block, 96 in all), each shown as a 3-character message ("AAA") to its own fresh worm, exactly as the site shows a message.',
    measure: 'Peak cells firing (activity above 0.05) during the message and its aftermath: the same peak the site reports for every message. Also each glyph\'s lit pixels (ink) and the Spearman rank correlation between ink and peak.',
    control: 'None. The ink correlation shows how much of the ranking is simply the amount of light.',
    rule: 'No pass rule: measured. Published as a ranking (top 10, bottom 10 and every value), ties in glyph order. The only claim is which glyph\'s light pattern fires the most cells in this model; the worm does not read letters.',
    chosen: [
      { name: 'repeats', value: 3, why: 'a short message, like a typical word, the same for every glyph' },
    ],
    caveats: [
      'How a glyph is turned into light (strips of the view per photoreceptor) is a modelling choice shown on the site; real receptive fields are not in the data.',
    ],
    seed: SEED,
    params: { repeat: 3 },
  },
  {
    id: 'fatigue',
    version: 1,
    kind: 'fatigue',
    registered: '2026-09-26',
    title: 'Ten pokes',
    question: 'Does the response shrink when the same spot is poked again and again?',
    stimulus: 'One fresh worm. 10 identical pokes of the same 6 touch sensors (drawn by seed from the 53 touch sensors defined in touch-startle), one every 30 steps (1 s). Each poke is a drive of 1.2 for 5 steps, the site\'s poke.',
    measure: 'For each poke, within the 30 steps from its onset: the peak number of cells firing (activity above 0.05) and the peak startle-muscle activity. Ratio = the last poke\'s peak ÷ the first poke\'s peak.',
    control: 'The same 10 pokes on a worm with the model\'s fatigue switched off (adapt = 0), to show how much of any change comes from fatigue.',
    rule: 'No pass rule: measured. Any decline is the model\'s built-in fatigue (tauA = 40 steps, adapt = 1.5, both chosen by us), not learning or memory.',
    chosen: [
      { name: 'cells', value: '6 touch sensors, drawn by seed', why: 'the most one poke on the site can touch' },
      { name: 'poke', value: 'drive 1.2 for 5 steps', why: 'the site\'s poke' },
      { name: 'pokes', value: 10, why: 'enough to see a trend' },
      { name: 'interval', value: '30 steps (1 s)', why: 'a quick but ordinary poking rhythm' },
      { name: 'seed', value: SEED, why: 'fixed in advance' },
    ],
    caveats: [
      'The fatigue time constant and strength are chosen model parameters, shown on the site; nothing here is trained.',
    ],
    seed: SEED,
    params: { drive: 1.2, pokeSteps: 5, cells: 6, pokes: 10, interval: 30, touchExcludesEyes: true },
  },
];

// Added after the v1 results were known. v1 protocols above are untouched and keep their results.
const PROTOCOLS_V2 = [
  {
    id: 'touch-startle-v2',
    version: 2,
    kind: 'touch-startle-single',
    follows: 'touch-startle',
    registered: '2026-09-26',
    registeredAfter: 'the touch-startle v1 result was known',
    why: 'touch-startle v1 drove every condition to the same ceiling: touch 0.867, all 10 other-sensory draws 0.869 to 0.876, all 50 scrambles 0.860 to 0.897. Driving 53 sensors at once ignites a whole-body cascade in this all-excitatory model, so v1 could not tell touch from anything else. Its verdict (fails) stands and is published. v2 asks the same question with the smallest touch the site allows: one sensor at a time. Nothing else changes: same measure, same rule, same scrambles.',
    title: 'Touch and startle, one sensor at a time',
    question: 'Does touch reach the startle muscles?',
    stimulus: 'For each of the 53 touch sensors (the same set as v1) in turn, a fresh worm at rest gets the site\'s poke, a drive of 1.2 for 5 steps, into that one sensor only. For comparison, the same single-cell poke into each of the 368 other sensory neurons (same definition as v1: not photoreceptors, not non-directional light sensors, not touch sensors, at least one outgoing synapse), every one of them, no sampling.',
    measure: 'For each poke, the peak over 60 steps (2 s) from onset of st, the mean activity of the 192 startle muscles. Touch response = the mean of the 53 touch pokes\' peaks. Other-sensory response = the mean of the 368 other pokes\' peaks. Also reported, not used for the verdict: how many pokes of each kind take st above 0.05, and how many light up more than half of all cells.',
    control: `Within the real wiring: the 368 other sensory neurons. Wiring control, with the 53 single touch pokes: ${SCRAMBLES}`,
    rule: `Passes if the real touch response is at least 2× the other-sensory response AND greater than p95 of the scrambles' touch responses; otherwise fails. ${P95}.`,
    chosen: [
      { name: 'poke', value: 'drive 1.2 for 5 steps into one cell', why: 'the site\'s poke on the smallest possible target, to stay below the whole-body cascade that decided v1' },
      { name: 'window', value: '60 steps (2 s)', why: 'a 5-step poke needs less time than v1\'s 10-step drive (v1\'s touch response peaked at step 28); keeps the lab a few seconds of CPU' },
      { name: 'touch cells', value: 'touch role minus the 4 eyespot photoreceptors (53 cells)', why: 'unchanged from v1' },
      { name: 'comparison cells', value: 'all 368 other sensory neurons with at least one outgoing synapse', why: 'no sampling is needed when each cell is poked alone' },
      { name: 'specificity factor', value: 2, why: 'unchanged from v1' },
      ...scrambleChoices,
      { name: 'pass threshold', value: '95th percentile of the scrambles', why: 'unchanged from v1' },
    ],
    caveats: [
      'Registered after the v1 result was known, to remove v1\'s ceiling; weigh it accordingly. The v1 verdict is the one registered in advance.',
      'Every synapse is modelled as excitatory, so all sensory input tends to spread; the other-sensory comparison is there to show whether touch is special.',
    ],
    seed: SEED,
    params: { drive: 1.2, pokeSteps: 5, windowSteps: 60, ratio: 2, touchExcludesEyes: true, reachThreshold: 0.05, scrambles: 50, swapsPerEdge: 10, percentile: 95 },
  },
];

// Added with the lamp (shared/lamp.js), registered before any lamp was lit, in the lab or on the site.
const CUBE = [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]];
const PROTOCOLS_V3 = [
  {
    id: 'follow-the-light',
    version: 1,
    kind: 'phototaxis',
    registered: '2026-09-26',
    registeredBefore: 'any lamp was lit, in the lab or on the site',
    title: 'Follow the light',
    question: 'Does it swim toward a light?',
    stimulus: 'A fresh worm at rest at the centre of its tank, head up. A lamp is lit 10 units (1.08 mm) away from it in one of 8 directions, the corners of a cube around the worm, and stays lit for 900 steps (30 s). The light each side of the body gets (shared/lamp.js) drives that side\'s 13 photoreceptors the way a message\'s lit strip does, min(1, 1.6 × light): each side\'s eyes look out sideways, a little forward and a little up, direction (±0.8, 0.5, 0.33) in the body frame; a pigment cup lets an eye see light from its own side only, as the cosine of the angle off its axis; brightness is 1 / (1 + (d / 10 units)²) at distance d. The body swims as on the site (shared/body.js), so where the worm goes changes what its eyes see: a closed loop. Each direction is also run with the lamp dark.',
    measure: 'For each trial, the mean distance from the worm to the lamp, sampled after each of the 900 steps. Attraction = the mean over the 8 directions of (mean distance with the lamp dark − mean distance with it lit), in units; positive = the worm stayed closer to the lamp when it was lit. Also reported, not used for the verdict: the closest approach in each lit trial, and in how many of the 8 directions the worm ended the trial closer to the lit lamp than to the dark one.',
    control: `Within the real wiring: the same 8 trials with the lamp dark, which is the path the worm swims anyway. With no light and no other input every cell stays at 0 in any wiring, so the dark trials are the same for every wiring. Wiring control, with the 8 lit trials: ${SCRAMBLES}`,
    rule: `Passes if the real wiring's attraction is greater than 0 AND greater than p95 of the scrambles' attractions; otherwise fails. ${P95}.`,
    chosen: [
      { name: 'lamp distance', value: '10 units (1.08 mm)', why: 'about five body lengths: far enough that getting there takes swimming, near enough to be seen' },
      { name: 'falloff', value: '10 units', why: 'at its starting distance the lamp is half as bright as up close, so a side facing it gets 0.8, a little under a fully lit message strip (1.0)' },
      { name: 'eye direction', value: '(±0.8, 0.5, 0.33) in the body frame', why: 'the larva\'s eyes sit on the sides of the head, looking out, slightly forward and up; the real visual fields are not in the data' },
      { name: 'pigment cup', value: 'cosine of the angle off the eye\'s axis, own side only', why: 'the simplest directional eye' },
      { name: 'trial', value: '900 steps (30 s)', why: 'how long a lamp stays lit on the site' },
      { name: 'directions', value: 'the 8 corners of a cube', why: 'evenly spread around the worm: as many above as below, left as right, ahead as behind' },
      { name: 'measure', value: 'mean distance over the trial, lit minus dark', why: 'rewards getting there and staying near; the distance at the last step alone depends on where a helical swimmer happens to be; the dark twin removes the path it swims anyway' },
      ...scrambleChoices,
      { name: 'pass threshold', value: 'above 0 and above the 95th percentile of the scrambles', why: 'the conventional 5% level, and it has to actually get closer' },
    ],
    caveats: [
      'The eyes\' directions, the pigment cup and the falloff are ours; the real visual fields are not in the data.',
      'Every synapse is modelled as excitatory (transmitters are unknown for most cells).',
      'The body\'s physics and the tank are ours (shared/body.js); the tank\'s wall turns the worm back, which limits how far it can drift from any lamp in 30 s.',
      'Real Platynereis larvae swim toward light with their eyespots and the ciliary band beside them (Jékely et al. 2008). This tests whether this model of the wiring does, not whether the animal does.',
    ],
    seed: SEED,
    params: { directions: 'cube', distance: 10, steps: 900, falloff: 10, eye: [0.8, 0.5, 0.33], scrambles: 50, swapsPerEdge: 10, percentile: 95 },
  },
];

function deepFreeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deepFreeze(x[k]); }
  return x;
}

/** Every registered protocol, in order. Never edit one after its first run: add a new version. */
export const PROTOCOLS = deepFreeze([...PROTOCOLS_V1, ...PROTOCOLS_V2, ...PROTOCOLS_V3]);

/** JSON with object keys sorted at every level, no whitespace: the same bytes in every engine. */
export function canonicalJson(x) {
  if (x === null || typeof x !== 'object') {
    if (x === undefined || typeof x === 'function') throw new TypeError('canonicalJson: undefined or function value');
    if (typeof x === 'number' && !Number.isFinite(x)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(x);
  }
  if (ArrayBuffer.isView(x)) return canonicalJson(Array.from(x));
  if (Array.isArray(x)) return '[' + x.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(x[k])).join(',') + '}';
}

/** The string whose SHA-256 identifies the registered protocols. */
export const protocolJson = (protocols = PROTOCOLS) => canonicalJson(protocols);

/* ------------------------------------------------------------------------------------------------
 * Seeded randomness: 32-bit integer arithmetic only, identical in every engine.
 * --------------------------------------------------------------------------------------------- */

/** mulberry32: a small seeded PRNG built on Math.imul. Returns a function giving uint32s. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Uniform integer in [0, n) from a uint32 (exact for n < 2^21: the product stays below 2^53). */
const randInt = (next, n) => Math.floor((next() * n) / 4294967296);

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function fmix32(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A seed for the k-th use of `label` under a protocol seed (e.g. deriveSeed(seed, 'scramble', 7)). */
export function deriveSeed(seed, label, k = 0) {
  return fmix32(((fmix32(seed >>> 0) ^ fnv1a(label)) + Math.imul(k + 1, 0x9e3779b9)) >>> 0);
}

/** k distinct items of `pool`, drawn by seed (partial Fisher–Yates), returned in ascending order. */
export function drawCells(pool, k, seed) {
  if (k > pool.length) throw new RangeError(`cannot draw ${k} of ${pool.length}`);
  const a = pool.slice(), next = mulberry32(seed);
  for (let i = 0; i < k; i++) {
    const j = i + randInt(next, a.length - i);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a.slice(0, k).sort((x, y) => x - y);
}

/* ------------------------------------------------------------------------------------------------
 * The wiring control: degree-preserving scrambles.
 * --------------------------------------------------------------------------------------------- */

/**
 * Maslov–Sneppen scramble. Picks two connections a→b and c→d at random and rewires them to a→d and
 * c→b, unless that would make a self-connection or duplicate an existing connection. Each connection
 * keeps its synapse count and its presynaptic cell (only targets are exchanged), so every cell keeps
 * its in-degree, out-degree and total outgoing synapses, and the total synapse count is unchanged.
 * Deterministic for a seed.
 * @param {{n: any[], e: number[]}} D wiring (data/wiring.json)
 * @param {number} seed uint32
 * @param {{swapsPerEdge?: number}} opts successful swaps = swapsPerEdge × connections
 * @returns {{n: any[], e: number[], scramble: {seed: number, swaps: number, attempts: number}}}
 */
export function scrambleWiring(D, seed, { swapsPerEdge = 10 } = {}) {
  const N = D.n.length, E = D.e, M = E.length / 3;
  if (N * N > 2 ** 31) throw new RangeError('too many cells for the edge bitmap');
  const pre = new Int32Array(M), post = new Int32Array(M);
  const bits = new Int32Array((N * N >>> 5) + 1);   // one bit per possible connection a→b (key a·N + b)
  for (let m = 0; m < M; m++) {
    const a = E[3 * m], b = E[3 * m + 1], key = a * N + b;
    if (a === b) throw new Error(`wiring has a self-connection at cell ${a}`);
    if (bits[key >>> 5] & (1 << (key & 31))) throw new Error(`wiring lists ${a}→${b} twice`);
    bits[key >>> 5] |= 1 << (key & 31);
    pre[m] = a; post[m] = b;
  }
  const next = mulberry32(seed);
  const target = swapsPerEdge * M, maxAttempts = 100 * target + 1e6;
  let swaps = 0, attempts = 0;
  while (swaps < target) {
    if (++attempts > maxAttempts) throw new Error(`scramble stalled after ${swaps} of ${target} swaps`);
    const i = randInt(next, M), j = randInt(next, M);
    const a = pre[i], b = post[i], c = pre[j], d = post[j];
    if (a === c || b === d || a === d || c === b) continue;          // same cell twice, or a self-connection
    const ad = a * N + d, cb = c * N + b;
    if ((bits[ad >>> 5] & (1 << (ad & 31))) || (bits[cb >>> 5] & (1 << (cb & 31)))) continue;   // duplicate
    const ab = a * N + b, cd = c * N + d;
    bits[ab >>> 5] &= ~(1 << (ab & 31)); bits[cd >>> 5] &= ~(1 << (cd & 31));
    bits[ad >>> 5] |= 1 << (ad & 31); bits[cb >>> 5] |= 1 << (cb & 31);
    post[i] = d; post[j] = b;
    swaps++;
  }
  const e = new Array(E.length);
  for (let m = 0; m < M; m++) { e[3 * m] = pre[m]; e[3 * m + 1] = post[m]; e[3 * m + 2] = E[3 * m + 2]; }
  return { ...D, e, scramble: { seed, swaps, attempts } };
}

/** Memoised scrambles, shared by every experiment with the same seed (scramble k is the same wiring everywhere). */
export function createEnsemble(D) {
  const cache = new Map();
  return {
    get(seed, k, swapsPerEdge = 10) {
      const key = `${seed}:${swapsPerEdge}:${k}`;
      let s = cache.get(key);
      if (!s) { s = scrambleWiring(D, deriveSeed(seed, 'scramble', k), { swapsPerEdge }); cache.set(key, s); }
      return s;
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Statistics (plain arithmetic; Math.sqrt is exactly rounded in IEEE 754).
 * --------------------------------------------------------------------------------------------- */

/** Quantile of ascending-sorted values by linear interpolation between order statistics (numpy/R default). */
export function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  const h = (n - 1) * q, lo = Math.floor(h), hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** {n, mean, sd, p95, min, max, values}: mean/sd (n−1)/p95 over the non-null values; n counts all. */
export function describe(values, q = 0.95) {
  const nums = values.filter((v) => v !== null);
  const k = nums.length;
  let s = 0;
  for (const v of nums) s += v;
  const mean = k ? s / k : null;
  let ss = 0;
  for (const v of nums) ss += (v - mean) * (v - mean);
  const sorted = Float64Array.from(nums).sort();
  return {
    n: values.length, mean, sd: k > 1 ? Math.sqrt(ss / (k - 1)) : k === 1 ? 0 : null,
    p95: quantile(sorted, q), min: k ? sorted[0] : null, max: k ? sorted[k - 1] : null, values: values.slice(),
  };
}

/** Share (%) of control values below x, ties counting half. null (no response) counts as +infinity. */
export function percentileOf(values, x) {
  const X = x === null ? Infinity : x;
  let below = 0, equal = 0;
  for (const v of values) { const V = v === null ? Infinity : v; if (V < X) below++; else if (V === X) equal++; }
  return values.length ? (100 * (below + equal / 2)) / values.length : null;
}

/** Monte Carlo p-value for "x is unusually large": (1 + #controls ≥ x) / (1 + #controls). */
export function upperP(values, x) {
  let ge = 0;
  for (const v of values) if (v >= x) ge++;
  return (1 + ge) / (1 + values.length);
}

/** Spearman rank correlation (average ranks for ties). */
export function spearman(x, y) {
  const rank = (v) => {
    const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b] || a - b), r = new Array(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
      for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x), ry = rank(y), n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/* ------------------------------------------------------------------------------------------------
 * Cells and a thin runner around makeSim (fresh worm = sim.reset(): activity, fatigue, input all 0).
 * --------------------------------------------------------------------------------------------- */

const meanOf = (r, ix) => { let s = 0; for (const i of ix) s += r[i]; return ix.length ? s / ix.length : 0; };
const uniqSorted = (a) => [...new Set(a)].sort((x, y) => x - y);

/** The cell groups the protocols name, from the real wiring (scrambles keep every cell's degrees). */
export function labCells(D, roles = indexRoles(D)) {
  const N = D.n.length, outDeg = new Int32Array(N);
  for (let k = 0; k < D.e.length; k += 3) outDeg[D.e[k]]++;
  const touchRole = [], otherSensory = [];
  for (let i = 0; i < N; i++) {
    const x = D.n[i];
    if (x[6] & ROLE.TOUCH) touchRole.push(i);
    if (x[1] === 0 && !(x[6] & (ROLE.EYE | ROLE.CPRC | ROLE.TOUCH)) && outDeg[i] > 0) otherSensory.push(i);
  }
  return {
    roles,
    eyes: uniqSorted([...roles.eyeL, ...roles.eyeR]),
    touchRole,
    touch: touchRole.filter((i) => !(D.n[i][6] & ROLE.EYE)),       // minus eyespot photoreceptors named "PRCR"
    otherSensory,
    muscles: uniqSorted([...roles.musL, ...roles.musR, ...roles.startle]),
    movers: uniqSorted([...roles.cilL, ...roles.cilR, ...roles.musL, ...roles.musR]),
  };
}

/**
 * Below this activity everywhere, with no input, no cell can reach the firing threshold again: every
 * synapse is excitatory, each cell's incoming weights sum to 1 and fatigue only subtracts, so a cell's
 * input stays under gain × (max activity) = theta / 2. From then on activity only decays, so every
 * peak measured so far is final. (test/lab.test.js checks that stopping here changes nothing.)
 */
export const quietLevel = (P) => P.theta / (2 * P.gain);

/**
 * Drive `cells` with `drive` for the first `onSteps` of `steps` steps from rest; calls each(t, sim)
 * after step t (1-based). With stopWhenQuiet (only for peak measures) it ends once activity can only decay.
 */
function drivePulse(sim, cells, drive, onSteps, steps, each, stopWhenQuiet = false) {
  sim.reset();
  const quiet = stopWhenQuiet ? quietLevel(sim.P) : -1;
  for (let t = 1; t <= steps; t++) {
    sim.ext.fill(0);
    if (t <= onSteps) for (const i of cells) sim.ext[i] += drive;
    sim.step();
    if (each(t, sim) === false) return t;
    if (t >= onSteps && quiet > 0) {
      let mx = 0;
      const r = sim.r;
      for (let i = 0; i < r.length; i++) if (r[i] > mx) mx = r[i];
      if (mx <= quiet) return t;
    }
  }
  return steps;
}

/** Peak of the startle muscles' mean activity (and optionally of cells firing) after driving `cells`. */
export function startlePeak(sim, roles, cells, drive, onSteps, steps, { countFiring = false, stopWhenQuiet = true } = {}) {
  let peak = 0, at = 0, firing = 0;
  drivePulse(sim, cells, drive, onSteps, steps, (t, s) => {
    const st = meanOf(s.r, roles.startle);
    if (st > peak) { peak = st; at = t; }
    if (countFiring) { let n = 0; for (let i = 0; i < s.r.length; i++) if (s.r[i] > 0.05) n++; if (n > firing) firing = n; }
  }, stopWhenQuiet);
  return { peak, step: at, firing };
}

/** Poke `cells` (drive for pokeSteps) every `interval` steps, `pokes` times; peak cells firing and startle per poke. */
export function pokeTrain(D, cells, prm, P = PARAMS, roles = indexRoles(D)) {
  const sim = makeSim(D, P), out = [];
  for (let k = 0; k < prm.pokes; k++) {
    let peak = 0, st = 0;
    for (let t = 0; t < prm.interval; t++) {
      sim.ext.fill(0);
      if (t < prm.pokeSteps) for (const i of cells) sim.ext[i] += prm.drive;
      sim.step();
      const ro = readouts(sim.r, roles);
      if (ro.nAct > peak) peak = ro.nAct;
      if (ro.st > st) st = ro.st;
    }
    out.push({ peak, st });
  }
  return { out, r: sim.r };
}

/* ------------------------------------------------------------------------------------------------
 * The experiments. Each engine reads its numbers from protocol.params, so the code cannot quietly
 * run something other than what was registered.
 * --------------------------------------------------------------------------------------------- */

const name = (D, i) => D.n[i][0] || `cell ${i}`;
const fmt = (x, d = 4) => (x === null || x === undefined ? 'none' : Number(x).toPrecision(d));
const side = (v) => (v > 0 ? 'the lit side' : v < 0 ? 'the opposite side' : 'neither side');

function scrambleLoop(ctx, fn) {
  const { prm, seed, n, ensemble, tick } = ctx;
  const out = [];
  for (let k = 0; k < n; k++) { out.push(fn(ensemble.get(seed, k, prm.swapsPerEdge))); tick(); }
  return out;
}

function eyesSides(ctx) {
  const { D, cells, prm } = ctx, { roles } = cells;
  const run = (W) => {
    const sim = makeSim(W);
    const one = (eyes) => {
      let cil = 0, bend = 0, movers = 0;
      drivePulse(sim, eyes, prm.drive, prm.onSteps, prm.windowSteps, (t, s) => {
        const ro = readouts(s.r, roles);
        cil += ro.cil; bend += ro.bend; movers += meanOf(s.r, cells.movers);
      });
      const w = prm.windowSteps;
      return { cil: cil / w, bend: bend / w, movers: movers / w };
    };
    const left = one(roles.eyeL), right = one(roles.eyeR);
    const L_cil = left.cil - right.cil, L_bend = left.bend - right.bend;
    return { lateralization: Math.abs(L_cil) + Math.abs(L_bend), L_cil, L_bend, movers: (left.movers + right.movers) / 2, leftLight: left, rightLight: right };
  };
  const real = run(D); ctx.tick();
  const scr = scrambleLoop(ctx, run);
  const vals = scr.map((s) => s.lateralization);
  const control = describe(vals, prm.percentile / 100);
  const passes = real.lateralization > control.p95;
  const part = (key) => {
    const abs = scr.map((s) => Math.abs(s[key])), c = describe(abs, prm.percentile / 100);
    return { real: real[key], realAbs: Math.abs(real[key]), side: side(real[key]), controlAbs: c, percentile: percentileOf(abs, Math.abs(real[key])), aboveP95: Math.abs(real[key]) > c.p95 };
  };
  const parts = { L_cil: part('L_cil'), L_bend: part('L_bend') };
  const movers = describe(scr.map((s) => s.movers), prm.percentile / 100);
  return {
    real, control, percentile: percentileOf(vals, real.lateralization), p: upperP(vals, real.lateralization),
    verdict: passes ? 'passes' : 'fails',
    details: { parts, movers: { real: real.movers, control: movers } },
    summary: `Lateralization ${fmt(real.lateralization)} (ciliary bands ${fmt(real.L_cil)}, more active on ${side(real.L_cil)}; body-wall muscles ${fmt(real.L_bend)}, more active on ${side(real.L_bend)}) against a scramble p95 of ${fmt(control.p95)}: ${passes ? 'passes' : 'fails'}.`,
  };
}

function touchStartle(ctx) {
  const { D, cells, prm, seed } = ctx, { roles } = cells;
  const touch = prm.touchExcludesEyes ? cells.touch : cells.touchRole;
  const peakOf = (sim, set) => startlePeak(sim, roles, set, prm.drive, prm.onSteps, prm.windowSteps);
  const simReal = makeSim(D);
  const t = peakOf(simReal, touch); ctx.tick();
  const draws = [];
  for (let k = 0; k < prm.otherDraws; k++) {
    const set = drawCells(cells.otherSensory, touch.length, deriveSeed(seed, 'other-sensory', k));
    const r = peakOf(simReal, set);
    draws.push({ peak: r.peak, step: r.step, cells: set.map((i) => name(D, i)) });
    ctx.tick();
  }
  let other = 0;
  for (const d of draws) other += d.peak;
  other /= draws.length;
  const scr = scrambleLoop(ctx, (W) => peakOf(makeSim(W), touch).peak);
  const control = describe(scr, prm.percentile / 100);
  const specific = t.peak >= prm.ratio * other, beats = t.peak > control.p95;
  const passes = specific && beats;
  const ratio = other > 0 ? t.peak / other : null;
  return {
    real: { touch: t.peak, touchPeakStep: t.step, other, ratio, touchCells: touch.length },
    control, percentile: percentileOf(scr, t.peak), p: upperP(scr, t.peak),
    verdict: passes ? 'passes' : 'fails',
    details: {
      conditions: { atLeastRatioTimesOther: specific, aboveScrambleP95: beats },
      touchCells: touch.map((i) => name(D, i)),
      excludedFromTouch: cells.touchRole.filter((i) => !touch.includes(i)).map((i) => name(D, i)),
      otherCandidates: cells.otherSensory.length,
      otherDraws: draws,
    },
    summary: `Touch drove the startle muscles to a peak of ${fmt(t.peak)} (step ${t.step}); ${draws.length} draws of other sensory neurons averaged ${fmt(other)}${ratio === null ? '' : ` (touch ${fmt(ratio, 3)}×)`}; scramble p95 ${fmt(control.p95)}. ${passes ? 'Passes' : `Fails: ${[!specific && `touch is under ${prm.ratio}× the other senses`, !beats && 'touch does not beat the scramble p95'].filter(Boolean).join(' and ')}`}.`,
  };
}

function touchStartleSingle(ctx) {
  const { D, cells, prm } = ctx, { roles } = cells;
  const touch = prm.touchExcludesEyes ? cells.touch : cells.touchRole;
  const half = D.n.length / 2;
  const poke = (sim, cell, count) => startlePeak(sim, roles, [cell], prm.drive, prm.pokeSteps, prm.windowSteps, { countFiring: count });
  const tally = (runs) => {
    let s = 0, reach = 0, cascades = 0;
    for (const r of runs) { s += r.peak; if (r.peak > prm.reachThreshold) reach++; if (r.firing > half) cascades++; }
    return { mean: runs.length ? s / runs.length : 0, reach, cascades, of: runs.length };
  };
  const simReal = makeSim(D);
  const tRuns = touch.map((c) => poke(simReal, c, true)); ctx.tick();
  const oRuns = cells.otherSensory.map((c) => poke(simReal, c, true)); ctx.tick();
  const T = tally(tRuns), O = tally(oRuns);
  const scr = scrambleLoop(ctx, (W) => {
    const sim = makeSim(W);
    let s = 0;
    for (const c of touch) s += poke(sim, c, false).peak;
    return s / touch.length;
  });
  const control = describe(scr, prm.percentile / 100);
  const specific = T.mean >= prm.ratio * O.mean, beats = T.mean > control.p95;
  const passes = specific && beats;
  const ratio = O.mean > 0 ? T.mean / O.mean : null;
  const topOther = oRuns.map((r, k) => ({ cell: name(D, cells.otherSensory[k]), peak: r.peak, cellsFiring: r.firing }))
    .map((x, k) => ({ ...x, k })).sort((a, b) => b.peak - a.peak || a.k - b.k).slice(0, 10).map(({ k, ...x }) => x);
  return {
    real: { touch: T.mean, other: O.mean, ratio, touchCells: touch.length, otherCells: oRuns.length },
    control, percentile: percentileOf(scr, T.mean), p: upperP(scr, T.mean),
    verdict: passes ? 'passes' : 'fails',
    details: {
      conditions: { atLeastRatioTimesOther: specific, aboveScrambleP95: beats },
      touchPokes: { reachedStartle: T.reach, cascades: T.cascades, of: T.of, each: tRuns.map((r, k) => ({ cell: name(D, touch[k]), peak: r.peak, cellsFiring: r.firing })) },
      otherPokes: { reachedStartle: O.reach, cascades: O.cascades, of: O.of, peaks: oRuns.map((r) => r.peak), top: topOther },
    },
    summary: `One touch sensor at a time drove the startle muscles to a mean peak of ${fmt(T.mean)} (${T.reach} of ${T.of} pokes above ${prm.reachThreshold}; ${T.cascades} lit up more than half the body); one other sensory neuron at a time: ${fmt(O.mean)} (${O.reach} of ${O.of}; ${O.cascades})${ratio === null ? '' : `, so touch ${fmt(ratio, 3)}×`}; scramble p95 ${fmt(control.p95)}. ${passes ? 'Passes' : `Fails: ${[!specific && `touch is under ${prm.ratio}× the other senses`, !beats && 'touch does not beat the scramble p95'].filter(Boolean).join(' and ')}`}.`,
  };
}

function lightLatency(ctx) {
  const { D, cells, prm } = ctx;
  const run = (W, who = false) => {
    const sim = makeSim(W);
    let hit = null, first = -1;
    drivePulse(sim, cells.eyes, prm.drive, prm.maxSteps, prm.maxSteps, (t, s) => {
      for (const i of cells.muscles) if (s.r[i] > prm.threshold) { hit = t; first = i; return false; }
      return true;
    });
    return who ? { steps: hit, first } : hit;
  };
  const real = run(D, true); ctx.tick();
  const scr = scrambleLoop(ctx, (W) => run(W));
  const control = { ...describe(scr), responded: scr.filter((v) => v !== null).length };
  const ms = (s) => (s === null ? null : (s * 1000) / STEPS_PER_SECOND);
  return {
    real: { steps: real.steps, ms: ms(real.steps), firstMuscle: real.first >= 0 ? name(D, real.first) : null },
    control, percentile: percentileOf(scr, real.steps), p: null,
    verdict: 'measured',
    details: { controlMs: { mean: ms(control.mean), p95: ms(control.p95) }, muscles: cells.muscles.length, stepsPerSecond: STEPS_PER_SECOND },
    summary: real.steps === null
      ? `No muscle crossed ${prm.threshold} within ${prm.maxSteps} steps of constant light; ${control.responded} of ${scr.length} scrambles did.`
      : `The first muscle (${name(D, real.first)}) crossed ${prm.threshold} ${real.steps} steps after light onset (${fmt(ms(real.steps), 3)} ms of model time); the ${control.responded} of ${scr.length} scrambles that responded took ${fmt(control.mean, 3)} steps on average (sd ${fmt(control.sd, 3)}).`,
  };
}

const popcount = (m) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };

function alphabet(ctx) {
  const { D, prm } = ctx;
  const rows = [];
  for (const ch of Object.keys(GLYPHS)) {
    let summary = null;
    const w = new WormCore(D, { onEvent: (e) => { if (e.type === 'done') summary = e.summary; } });
    w.say('lab', ch.repeat(prm.repeat));
    for (let i = 0; i < 100000 && !summary; i++) w.tick();
    if (!summary) throw new Error(`message ${JSON.stringify(ch)} never finished`);
    let ink = 0;
    for (const col of GLYPHS[ch]) ink += popcount(col);
    rows.push({ glyph: ch, code: 'U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'), peak: summary.peak, ink: ink * prm.repeat, flood: summary.flood, steps: summary.steps });
    ctx.tick();
  }
  const order = rows.map((_, i) => i).sort((a, b) => rows[b].peak - rows[a].peak || a - b);
  const ranking = order.map((i, k) => ({ rank: k + 1, ...rows[i] }));
  const rho = spearman(rows.map((r) => r.ink), rows.map((r) => r.peak));
  const top = ranking[0], bottom = ranking[ranking.length - 1];
  const q = (r) => (r.glyph === ' ' ? 'space' : `"${r.glyph}"`);
  return {
    real: { top: ranking.slice(0, 10), bottom: ranking.slice(-10), all: ranking, spearmanInkPeak: rho },
    control: null, percentile: null, p: null,
    verdict: 'measured',
    details: { glyphs: rows.length },
    summary: `${q(top)} × ${prm.repeat} fired the most cells (${top.peak}); ${q(bottom)} the fewest (${bottom.peak}). Rank correlation between a glyph's lit pixels and its peak: ${fmt(rho, 3)}.`,
  };
}

function fatigue(ctx) {
  const { D, cells, prm, seed } = ctx;
  const pool = prm.touchExcludesEyes ? cells.touch : cells.touchRole;
  const set = drawCells(pool, prm.cells, deriveSeed(seed, 'fatigue-cells', 0));
  const ratio = (a) => (a[0] > 0 ? a[a.length - 1] / a[0] : null);
  const pack = (res) => {
    const peaks = res.out.map((o) => o.peak), st = res.out.map((o) => o.st);
    return { peaks, st, ratio: ratio(peaks), stRatio: ratio(st) };
  };
  const real = pack(pokeTrain(D, set, prm, PARAMS, cells.roles)); ctx.tick();
  const off = pack(pokeTrain(D, set, prm, { ...PARAMS, adapt: 0 }, cells.roles)); ctx.tick();
  return {
    real: { cells: set.map((i) => name(D, i)), ...real },
    control: null, percentile: null, p: null,
    verdict: 'measured',
    details: { noFatigue: off, model: { tauA: PARAMS.tauA, adapt: PARAMS.adapt } },
    summary: `Poke 1 fired ${real.peaks[0]} cells at its peak, poke ${real.peaks.length} fired ${real.peaks[real.peaks.length - 1]} (ratio ${fmt(real.ratio, 3)}); with the model's fatigue switched off: ${off.peaks[0]} → ${off.peaks[off.peaks.length - 1]} (ratio ${fmt(off.ratio, 3)}). This is the model's chosen fatigue, not learning.`,
  };
}

function phototaxis(ctx) {
  const { D, prm } = ctx;
  // the registered numbers must be the ones the site runs
  if (prm.distance !== LAMP.distance || prm.steps !== LAMP.steps || prm.falloff !== LAMP.falloff || prm.eye.join() !== LAMP.eye.join()) {
    throw new Error('follow-the-light: shared/lamp.js differs from the registered protocol');
  }
  const dirs = CUBE.map((v) => { const l = Math.sqrt(3); return [v[0] / l, v[1] / l, v[2] / l]; });
  const um = (u) => u * UM_PER_UNIT;
  const trial = (W, dir, lit) => {
    const w = new WormCore(W);
    // placed exactly as WormCore places a lit lamp (tidied after the first run: the dark lamp now goes through
    // the same lampDir() call; the positions, the verdict and every number came out bit-identical)
    const pos = placeLamp(w.body.state.p, lampDir(dir), BODY.tank);
    if (lit) w.lamp('lab', dir);
    let sum = 0, min = Infinity, end = 0;
    for (let t = 0; t < prm.steps; t++) {
      w.tick();
      const p = w.body.state.p, dx = p[0] - pos[0], dy = p[1] - pos[1], dz = p[2] - pos[2];
      end = Math.sqrt(dx * dx + dy * dy + dz * dz);
      sum += end; if (end < min) min = end;
    }
    return { mean: sum / prm.steps, closest: min, end };
  };
  const dark = dirs.map((d) => trial(D, d, false));
  const run = (W) => {
    const lit = dirs.map((d) => trial(W, d, true));
    let a = 0;
    for (let k = 0; k < dirs.length; k++) a += dark[k].mean - lit[k].mean;
    return { attraction: a / dirs.length, lit, endedCloser: lit.filter((x, k) => x.end < dark[k].end).length };
  };
  const real = run(D); ctx.tick();
  const scr = scrambleLoop(ctx, run);
  const vals = scr.map((s) => s.attraction);
  const control = describe(vals, prm.percentile / 100);
  const passes = real.attraction > 0 && real.attraction > control.p95;
  const closest = Math.min(...real.lit.map((x) => x.closest));
  return {
    real: {
      attraction: real.attraction, attractionUm: um(real.attraction), endedCloser: real.endedCloser, closestUm: um(closest),
      trials: dirs.map((d, k) => ({ dir: CUBE[k], litMeanUm: um(real.lit[k].mean), darkMeanUm: um(dark[k].mean), closestUm: um(real.lit[k].closest), litEndUm: um(real.lit[k].end), darkEndUm: um(dark[k].end) })),
    },
    control, percentile: percentileOf(vals, real.attraction), p: upperP(vals, real.attraction),
    verdict: passes ? 'passes' : 'fails',
    details: { controlUm: { mean: um(control.mean), p95: um(control.p95) } },
    summary: `With the lamp lit the worm stayed ${fmt(Math.abs(um(real.attraction)), 3)} µm ${real.attraction >= 0 ? 'closer to' : 'farther from'} it on average than with it dark (ended closer in ${real.endedCloser} of ${dirs.length} directions; closest approach ${fmt(um(closest), 3)} µm), against a scramble p95 of ${fmt(um(control.p95), 3)} µm: ${passes ? 'passes' : 'fails'}.`,
  };
}

const ENGINES = { 'eyes-sides': eyesSides, 'touch-startle': touchStartle, 'touch-startle-single': touchStartleSingle, 'light-latency': lightLatency, alphabet, fatigue, phototaxis };

/** How many progress units an experiment reports (its real runs plus one per scramble). */
function unitsOf(protocol, n) {
  const P = protocol.params;
  switch (protocol.kind) {
    case 'eyes-sides': case 'light-latency': case 'phototaxis': return 1 + n;
    case 'touch-startle': return 1 + P.otherDraws + n;
    case 'touch-startle-single': return 2 + n;
    case 'alphabet': return Object.keys(GLYPHS).length;
    case 'fatigue': return 2;
    default: return 1;
  }
}

const scramblesFor = (protocol, scrambles) => {
  const reg = protocol.params.scrambles || 0;
  if (!reg) return 0;
  const n = scrambles === undefined || scrambles === null ? reg : scrambles;
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`${protocol.id}: needs at least 1 scramble (got ${scrambles})`);
  return n;
};

/**
 * Run one protocol on wiring D.
 * @param {{n:any[], e:number[]}} D the real wiring
 * @param {object} protocol one of PROTOCOLS
 * @param {{scrambles?: number, onProgress?: (p: {id: string, done: number, total: number}) => void, ensemble?: ReturnType<typeof createEnsemble>, cells?: object}} opts
 *   scrambles defaults to the registered number; any other number is run but flagged as a deviation.
 * @returns {{id, version, title, question, rule, real, control, percentile, p, verdict, details, summary, scrambles, deviation, protocol}}
 */
export function runExperiment(D, protocol, { scrambles, onProgress = () => {}, ensemble, cells } = {}) {
  const engine = ENGINES[protocol.kind];
  if (!engine) throw new Error(`unknown experiment kind "${protocol.kind}"`);
  const n = scramblesFor(protocol, scrambles);
  const reg = protocol.params.scrambles || 0;
  const total = unitsOf(protocol, n);
  let done = 0;
  const ctx = {
    D, prm: protocol.params, seed: protocol.seed, n,
    cells: cells || labCells(D),
    ensemble: ensemble || createEnsemble(D),
    tick: () => { done++; onProgress({ id: protocol.id, done, total }); },
  };
  const out = engine(ctx);
  return {
    id: protocol.id, version: protocol.version, title: protocol.title, question: protocol.question, rule: protocol.rule,
    verdict: out.verdict, summary: out.summary,
    real: out.real, control: out.control, percentile: out.percentile, p: out.p, details: out.details,
    scrambles: n, registeredScrambles: reg,
    deviation: n !== reg ? `ran ${n} scrambles; the registered protocol says ${reg}` : null,
    protocol,
  };
}

/**
 * Run every protocol. Scrambles are generated once and shared (scramble k is the same wiring in
 * every experiment with the same seed).
 * @param {{n:any[], e:number[]}} D the real wiring
 * @param {{scrambles?: number, protocols?: object[], onProgress?: (p: {phase: string, id?: string, done: number, total: number, fraction: number}) => void}} opts
 * @returns {{labVersion, protocolJson: string, model, wiring, scrambles, results: object[]}}
 *   protocolJson is the canonical JSON of the protocols: its SHA-256 identifies what was registered.
 */
export function runLab(D, { scrambles, protocols = PROTOCOLS, onProgress = () => {} } = {}) {
  const ensemble = createEnsemble(D), cells = labCells(D);
  const plan = protocols.map((p) => ({ p, n: scramblesFor(p, scrambles) }));
  const needs = new Map();   // seed:swaps -> {seed, swapsPerEdge, n}
  for (const { p, n } of plan) {
    if (!n) continue;
    const key = `${p.seed}:${p.params.swapsPerEdge}`, cur = needs.get(key);
    if (!cur || cur.n < n) needs.set(key, { seed: p.seed, swapsPerEdge: p.params.swapsPerEdge, n });
  }
  let scrambleUnits = 0;
  for (const s of needs.values()) scrambleUnits += s.n;
  const total = scrambleUnits + plan.reduce((s, { p, n }) => s + unitsOf(p, n), 0);
  let base = 0;
  const report = (phase, id, done, of) => onProgress({ phase, id, done, total: of, fraction: (base + done) / total });

  const made = [];
  for (const s of needs.values()) {
    for (let k = 0; k < s.n; k++) { made.push({ k, ...ensemble.get(s.seed, k, s.swapsPerEdge).scramble }); report('scramble', null, k + 1, s.n); }
    base += s.n;
  }
  const results = [];
  for (const { p, n } of plan) {
    report('start', p.id, 0, unitsOf(p, n));
    results.push(runExperiment(D, p, { scrambles: n || undefined, ensemble, cells, onProgress: (e) => report('run', e.id, e.done, e.total) }));
    base += unitsOf(p, n);
    report('done', p.id, 0, 0);
  }
  let synapses = 0;
  for (let k = 2; k < D.e.length; k += 3) synapses += D.e[k];
  const swapsPerEdge = [...needs.values()].map((s) => s.swapsPerEdge);
  return {
    labVersion: LAB_VERSION,
    protocolJson: protocolJson(protocols),
    model: { ...PARAMS, stepsPerSecond: STEPS_PER_SECOND },
    wiring: { cells: D.n.length, connections: D.e.length / 3, synapses },
    scrambles: {
      n: made.length ? Math.max(...[...needs.values()].map((s) => s.n)) : 0,
      swapsPerEdge: swapsPerEdge.length ? swapsPerEdge[0] : null,
      made: made.map(({ k, seed, swaps, attempts }) => ({ k, seed, swaps, attempts })),
    },
    results,
  };
}

// Sound: every cell that starts firing makes a soft click, panned by where it is on screen and
// pitched by what kind of cell it is, so a whole-body startle sounds like rain. Off until turned on.
const FREQ = { eye: 3400, touch: 2300, sn: 2700, in: 1500, mn: 850, mus: 150, cil: 4800, other: 1100 };
const ONSET = 40;         // activity x 255 that counts as "started firing"
const MAX_CLICKS = 30;    // per frame; more onsets than this are sampled and made louder instead

/**
 * @param {{kinds: string[], ctx?: AudioContext, output?: AudioNode}} opts
 *   Without ctx/output it plays to the speakers (created on first enable, which needs a user gesture).
 */
export function createSound({ kinds, ctx = null, output = null }) {
  const N = kinds.length, prev = new Uint8Array(N);
  let master = null, noise = null, bedGain = null, enabled = false, lastSt = 0, level = 0;

  function init() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    master = ctx.createGain(); master.gain.value = 0.85;
    master.connect(comp); comp.connect(output || ctx.destination);
    const len = Math.floor(ctx.sampleRate * 0.035);
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.1));
    // a quiet sea-like bed that swells with overall activity
    const bedBuf = ctx.createBuffer(2, ctx.sampleRate * 3, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const b = bedBuf.getChannelData(c); let v = 0; for (let i = 0; i < b.length; i++) { v = v * 0.985 + (Math.random() * 2 - 1) * 0.12; b[i] = v; } }
    const bed = ctx.createBufferSource(); bed.buffer = bedBuf; bed.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
    bedGain = ctx.createGain(); bedGain.gain.value = 0;
    bed.connect(lp); lp.connect(bedGain); bedGain.connect(master); bed.start();
  }

  function click(t, kind, pan, gain) {
    const src = ctx.createBufferSource(); src.buffer = noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    if (kind === 'mus') { f.type = 'lowpass'; f.frequency.value = FREQ.mus * 2; f.Q.value = 1; }
    else { f.type = 'bandpass'; f.frequency.value = FREQ[kind] * (0.85 + Math.random() * 0.3); f.Q.value = 7; }
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
    const g = ctx.createGain(); g.gain.value = gain * (kind === 'mus' ? 2.2 : 1);
    src.connect(f); f.connect(p); p.connect(g); g.connect(master);
    src.start(t);
  }

  function thump(t, v = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.45);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5 * v, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.65);
  }

  /** A short rising chime, for records. */
  function chime() {
    if (!enabled) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + k * 0.08); g.gain.exponentialRampToValueAtTime(0.18, t + k * 0.08 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + k * 0.08 + 0.5);
      o.connect(g); g.connect(master); o.start(t + k * 0.08); o.stop(t + k * 0.08 + 0.55);
    });
  }

  /**
   * Call once per drawn frame with the activity bytes.
   * @param {Uint8Array} act activity x 255 per cell
   * @param {(i:number) => number} panOf -1 (left of screen) .. 1 (right)
   * @param {number} st startle level 0..1
   */
  function update(act, panOf, st = 0) {
    if (!enabled) { prev.set(act.subarray(0, N)); return; }
    const on = [];
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const a = act[i]; sum += a;
      if (a >= ONSET && prev[i] < ONSET) on.push(i);
      prev[i] = a;
    }
    const t0 = ctx.currentTime + 0.01;
    const scale = on.length > MAX_CLICKS ? Math.sqrt(on.length / MAX_CLICKS) : 1;
    for (let k = 0; k < Math.min(on.length, MAX_CLICKS); k++) {
      const i = on.length > MAX_CLICKS ? on[Math.floor(Math.random() * on.length)] : on[k];
      click(t0 + Math.random() * 0.045, kinds[i], panOf(i), 0.16 * scale);
    }
    level += (Math.min(1, sum / (255 * 600)) - level) * 0.08;
    bedGain.gain.setTargetAtTime(0.02 + level * 0.35, ctx.currentTime, 0.2);
    if (st > 0.35 && lastSt <= 0.35) thump(t0, Math.min(1, st));
    lastSt = st;
  }

  return {
    get enabled() { return enabled; },
    get ctx() { return ctx; },
    async enable() {
      if (!ctx || !master) init();
      if (ctx.state === 'suspended') await ctx.resume();
      enabled = true;
    },
    disable() { enabled = false; if (bedGain) bedGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1); },
    update, chime,
  };
}

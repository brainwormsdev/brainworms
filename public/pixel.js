// The worm's pixel font (shared/glyphs.js, the same one messages are drawn to its eyes with),
// used for the title, the LED eye display and clip overlays.
import { GLYPHS, GLYPH_HEIGHT } from '/shared/glyphs.js';
import { renderText, renderHalf, VIEW, SPEED } from '/shared/text.js';
import { TUG_GAP, TUG_ORDER } from '/shared/worm.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Columns for a line of text (1 dark column between letters). */
export function columns(text) {
  const cols = [];
  for (const ch of text) { for (const c of (GLYPHS[ch] || GLYPHS['?'])) cols.push(c); cols.push(0); }
  cols.pop();
  return cols;
}

/**
 * An SVG of LED-style pixel text. lines: [{text, cls}] — each line gets its own class for colour.
 * Returns an <svg> sized in pixel units (scale with CSS width).
 */
export function pixelTitle(lines, { gap = 0.16, lineGap = 4 } = {}) {
  const rows = lines.map((l) => ({ ...l, cols: columns(l.text) }));
  const width = Math.max(...rows.map((r) => r.cols.length));
  const height = rows.length * GLYPH_HEIGHT + (rows.length - 1) * lineGap;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'pixeltitle');
  rows.forEach((r, k) => {
    const g = document.createElementNS(SVG, 'g');
    g.setAttribute('class', r.cls || '');
    const y0 = k * (GLYPH_HEIGHT + lineGap);
    let d = '';
    r.cols.forEach((c, x) => { for (let y = 0; y < GLYPH_HEIGHT; y++) if (c & (1 << y)) d += `M${x + gap / 2} ${y0 + y + gap / 2}h${1 - gap}v${1 - gap}h${gap - 1}z`; });
    const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d);
    g.append(p); svg.append(g);
  });
  return svg;
}

/**
 * One line of pixel text in several colours, e.g. [{text:'BRAIN', cls:'ink'}, {text:'WORM', cls:'amber', glow:true}].
 * Parts with glow get a soft light, drawn with an SVG filter.
 */
export function pixelWordmark(parts, { gap = 0.14, space = 2 } = {}) {
  let x0 = 0;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'wordmark-svg');
  const defs = document.createElementNS(SVG, 'defs');
  defs.innerHTML = '<filter id="pxglow" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
  svg.append(defs);
  for (const part of parts) {
    const cols = columns(part.text);
    let d = '';
    cols.forEach((c, x) => { for (let y = 0; y < GLYPH_HEIGHT; y++) if (c & (1 << y)) d += `M${x0 + x + gap / 2} ${y + gap / 2}h${1 - gap}v${1 - gap}h${gap - 1}z`; });
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d); p.setAttribute('class', part.cls || '');
    if (part.glow) p.setAttribute('filter', 'url(#pxglow)');
    svg.append(p);
    x0 += cols.length + space;
  }
  svg.setAttribute('viewBox', `-1 -2 ${x0 - space + 2} ${GLYPH_HEIGHT + 4}`);
  return svg;
}

/** Draw pixel text on a 2D canvas. */
export function drawPixelText(g, text, x, y, px, color, glow = 0) {
  const cols = columns(text);
  g.save();
  g.fillStyle = color;
  if (glow) { g.shadowColor = color; g.shadowBlur = glow; }
  const s = px * 0.84;
  cols.forEach((c, cx) => { for (let r = 0; r < GLYPH_HEIGHT; r++) if (c & (1 << r)) g.fillRect(x + cx * px, y + r * px, s, s); });
  g.restore();
  return cols.length * px;
}

/**
 * LED matrix view of what's in front of the eyes. windows: [{bmp, pos, x0, x1}] in view columns;
 * a normal message is one window over the whole view, a tug is two half-view windows.
 * The unlit grid and the lit-dot glow are drawn once and reused, so this is cheap every frame.
 */
const ledCache = new Map();
function ledParts(w, h, view, lit) {
  const key = `${w}x${h}x${view}${lit}`;
  let c = ledCache.get(key);
  if (c) return c;
  const cw = w / view, ch = h / GLYPH_HEIGHT, r = Math.min(cw, ch) * 0.36;
  const grid = document.createElement('canvas'); grid.width = w; grid.height = h;
  const g = grid.getContext('2d');
  g.fillStyle = '#020406'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(120,150,170,0.10)';
  for (let x = 0; x < view; x++) for (let y = 0; y < GLYPH_HEIGHT; y++) { g.beginPath(); g.arc((x + 0.5) * cw, (y + 0.5) * ch, r * 0.7, 0, 6.2832); g.fill(); }
  const s = Math.ceil(r * 7), dot = document.createElement('canvas'); dot.width = dot.height = s;
  const d = dot.getContext('2d'), gr = d.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, lit); gr.addColorStop(r / (s / 2) * 0.95, lit); gr.addColorStop(r / (s / 2) * 1.25, 'rgba(255,236,200,.35)'); gr.addColorStop(1, 'rgba(255,236,200,0)');
  d.fillStyle = gr; d.fillRect(0, 0, s, s);
  c = { grid, dot, half: s / 2, cw, ch };
  ledCache.set(key, c);
  return c;
}

export function paintLED(g, w, h, view, windows, { lit = '#F4F7F9', divider = true } = {}) {
  const L = ledParts(w, h, view, lit);
  g.drawImage(L.grid, 0, 0);
  for (const { bmp, pos, x0, x1 } of windows) {
    const i0 = Math.floor(pos), frac = pos - i0;
    for (let x = x0; x <= x1; x++) {
      const X = i0 + (x - x0);
      if (X < 0 || X >= bmp.width) continue;
      const col = bmp.cols[X]; if (!col) continue;
      const px = (x - frac + 0.5) * L.cw;
      if (px < x0 * L.cw || px > (x1 + 1) * L.cw) continue;
      for (let y = 0; y < bmp.height; y++) if (col & (1 << y)) g.drawImage(L.dot, px - L.half, (y + 0.5) * L.ch - L.half);
    }
  }
  if (divider) { g.fillStyle = 'rgba(255,184,77,.75)'; g.fillRect(w / 2 - 1, 0, 2, h); }
}

/** The LED panel with each half lit evenly at a level 0..1 (the lamp: what each side's eyes get). */
export function paintLEDLevels(g, w, h, view, left, right, { lit = '#FFE2B0', divider = true } = {}) {
  const L = ledParts(w, h, view, lit);
  g.drawImage(L.grid, 0, 0);
  for (const [x0, x1, a] of [[0, view / 2, left], [view / 2, view, right]]) {
    if (a < 0.02) continue;
    g.globalAlpha = Math.min(1, a);
    for (let x = x0; x < x1; x++) for (let y = 0; y < GLYPH_HEIGHT; y++) g.drawImage(L.dot, (x + 0.5) * L.cw - L.half, (y + 0.5) * L.ch - L.half);
  }
  g.globalAlpha = 1;
  if (divider) { g.fillStyle = 'rgba(255,184,77,.75)'; g.fillRect(w / 2 - 1, 0, 2, h); }
}

/**
 * What is in front of the eyes at `step` for a playing stimulus, as LED windows.
 * msg: {kind:'say', text, startStep} or {kind:'tug', a, b, startStep}. Bitmaps are cached on msg.
 * Also returns the tug pass (0 = warm-up) and whether word A is on the left.
 */
export function eyeWindows(msg, step) {
  if (!msg) return { windows: [] };
  const t = step - msg.startStep;
  if (msg.kind === 'tug') {
    msg.bmpA ||= renderHalf(msg.a); msg.bmpB ||= renderHalf(msg.b);
    const phase = Math.max(msg.bmpA.width, msg.bmpB.width) - VIEW / 2;
    const pass = Math.floor(Math.max(0, t) / (phase + TUG_GAP)), within = Math.max(0, t) % (phase + TUG_GAP);
    if (pass >= TUG_ORDER.length) return { windows: [], pass, done: true, phase };
    const aLeft = TUG_ORDER[pass] === 1;
    const windows = within >= phase ? [] : [
      { bmp: aLeft ? msg.bmpA : msg.bmpB, pos: within * SPEED, x0: 0, x1: VIEW / 2 - 1 },
      { bmp: aLeft ? msg.bmpB : msg.bmpA, pos: within * SPEED, x0: VIEW / 2, x1: VIEW - 1 },
    ];
    return { windows, pass, aLeft, phase, within };
  }
  msg.bmp ||= renderText(msg.text);
  return { windows: [{ bmp: msg.bmp, pos: Math.max(0, t) * SPEED, x0: 0, x1: VIEW - 1 }] };
}

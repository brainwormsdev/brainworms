// Turns a message into the light pattern that scrolls past the worm's eyes.
// Server and browser share this file, so both compute exactly the same pattern.
import { GLYPHS, GLYPH_HEIGHT } from './glyphs.js';

export const VIEW = 60;          // columns in front of the eyes at any moment
export const SPEED = 1;          // columns the message moves per simulation step
export const EYE_GAIN = 1.6;     // light fraction -> photoreceptor drive (capped at 1)
export const FLOOD = 0.45;       // view brightness above which the non-directional light sensors respond
export const FLOOD_GAIN = 2;

const popcount = (m) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };

/** Render text to columns, padded with `pad` dark columns on both sides (a full view by default). */
export function renderText(text, pad = VIEW) {
  const cols = [];
  for (let k = 0; k < pad; k++) cols.push(0);
  for (const ch of text) {
    const g = GLYPHS[ch] || GLYPHS['?'];
    for (const c of g) cols.push(c);
    cols.push(0);
  }
  for (let k = 0; k < pad; k++) cols.push(0);
  const lum = new Float32Array(cols.length);
  for (let x = 0; x < cols.length; x++) lum[x] = popcount(cols[x]) / GLYPH_HEIGHT;
  return { cols: Uint16Array.from(cols), lum, width: cols.length, height: GLYPH_HEIGHT };
}

/** Number of steps a rendered message takes to pass the eyes. */
export const durationSteps = (bmp) => Math.ceil((bmp.width - VIEW) / SPEED);

function bandMean(lum, pos, a, b) {
  // mean light over view columns [a, b) (fractional edges weighted)
  let s = 0, wsum = 0;
  for (let x = Math.floor(a); x < Math.ceil(b); x++) {
    const w = Math.min(b, x + 1) - Math.max(a, x);
    if (w <= 0) continue;
    const X = pos + x;
    s += w * (X >= 0 && X < lum.length ? lum[X] : 0);
    wsum += w;
  }
  return wsum ? s / wsum : 0;
}

/**
 * Add the eye input for a message at scroll position `pos` into ext.
 * Left photoreceptors each sample one strip of the left half of the view, right ones the right half.
 * The strip layout is a modelling choice: real receptive fields are not in the data.
 * @returns {number} how far the view's brightness exceeded FLOOD (0 if not)
 */
export function applyEyes(ext, roles, bmp, pos) {
  const half = VIEW / 2;
  const nL = roles.eyeL.length, nR = roles.eyeR.length;
  roles.eyeL.forEach((i, k) => { ext[i] += Math.min(1, EYE_GAIN * bandMean(bmp.lum, pos, k * half / nL, (k + 1) * half / nL)); });
  roles.eyeR.forEach((i, k) => { ext[i] += Math.min(1, EYE_GAIN * bandMean(bmp.lum, pos, half + k * half / nR, half + (k + 1) * half / nR)); });
  const flood = Math.max(0, bandMean(bmp.lum, pos, 0, VIEW) - FLOOD);
  if (flood > 0) for (const i of roles.cprc) ext[i] += FLOOD_GAIN * flood;
  return flood;
}

/** A word rendered for one half of the view (tugs): half a view of dark padding each side. */
export const renderHalf = (text) => renderText(text, VIEW / 2);
/** Steps for a half-view word to scroll fully across its half. */
export const halfDurationSteps = (bmp) => Math.ceil((bmp.width - VIEW / 2) / SPEED);

/**
 * Tug input: the left half of the view shows one word scrolling, the right half another.
 * Same strips and gains as applyEyes, so a word drives a side exactly as a message would.
 */
export function applyEyesSplit(ext, roles, bmpL, posL, bmpR, posR) {
  const half = VIEW / 2;
  const nL = roles.eyeL.length, nR = roles.eyeR.length;
  roles.eyeL.forEach((i, k) => { ext[i] += Math.min(1, EYE_GAIN * bandMean(bmpL.lum, posL, k * half / nL, (k + 1) * half / nL)); });
  roles.eyeR.forEach((i, k) => { ext[i] += Math.min(1, EYE_GAIN * bandMean(bmpR.lum, posR, k * half / nR, (k + 1) * half / nR)); });
  const flood = Math.max(0, (bandMean(bmpL.lum, posL, 0, half) + bandMean(bmpR.lum, posR, 0, half)) / 2 - FLOOD);
  if (flood > 0) for (const i of roles.cprc) ext[i] += FLOOD_GAIN * flood;
  return flood;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { WormCore } from '../shared/worm.js';
import { renderActivityPNG } from '../server/render.js';

const D = JSON.parse(fs.readFileSync(new URL('../data/wiring.json', import.meta.url)));

/** The worm shown "gm", at the step with the most cells firing (as scripts/make-og.js does). */
function peakActivity() {
  const worm = new WormCore(D);
  worm.say('x', 'gm');
  let best = -1, act = null;
  for (let s = 0; s < 120; s++) {
    worm.tick();
    let n = 0;
    for (const v of worm.sim.r) if (v > 0.05) n++;
    if (n > best) { best = n; act = Float32Array.from(worm.sim.r); }
  }
  return act;
}
const PEAK = peakActivity();

const CRC = new Int32Array(256).map((_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

/** Minimal reader for the PNGs render.js writes (8-bit RGB): checks signature and CRCs, undoes the row filters. */
function readPNG(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  let o = 8, ihdr = null, ended = false;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    assert.equal(buf.readUInt32BE(o + 8 + len), crc32(buf.subarray(o + 4, o + 8 + len)), `${type} CRC`);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') ended = true;
    o += 12 + len;
  }
  assert.ok(ihdr && ended, 'IHDR first, IEND last');
  const { width: w, height: h } = ihdr, stride = w * 3, raw = zlib.inflateSync(Buffer.concat(idat)), rgb = Buffer.alloc(stride * h);
  assert.equal(raw.length, (stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? rgb[y * stride + i - 3] : 0, b = y ? rgb[(y - 1) * stride + i] : 0, c = i >= 3 && y ? rgb[(y - 1) * stride + i - 3] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      rgb[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + pred) & 255;
    }
  }
  return { ...ihdr, rgb };
}
/** Mean luminance of the image, or of the part of it where keep(x, y) is true. */
function meanLuminance({ width, rgb }, keep = () => true) {
  let s = 0, n = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const p = i / 3;
    if (keep(p % width, Math.floor(p / width))) { s += 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]; n++; }
  }
  return s / n;
}

test('the same activity renders to byte-identical PNGs', () => {
  const opts = { D, act: PEAK, layout: 'square', lines: ['STEP 1,234,567'], footnote: 'STATE SHA-256 3F9A…C21B' };
  const a = renderActivityPNG(opts), b = renderActivityPNG({ ...opts, act: Float32Array.from(PEAK) });
  assert.ok(a.equals(b));
  const og = { D, act: PEAK, layout: 'og', height: 315, badge: 'LIVE', lines: ['TALK TO A REAL LARVA BRAIN.'] };
  assert.ok(renderActivityPNG(og).equals(renderActivityPNG(og)));
});

test('the PNG is well formed and has the requested size', () => {
  for (const [opts, w, h] of [[{}, 1000, 1000], [{ layout: 'og' }, 1200, 630], [{ layout: 'icon' }, 180, 180], [{ width: 320 }, 320, 320], [{ layout: 'og', height: 315 }, 600, 315]]) {
    const png = readPNG(renderActivityPNG({ D, act: PEAK, ...opts }));
    assert.deepEqual([png.width, png.height, png.depth, png.colour, png.interlace], [w, h, 8, 2, 0], JSON.stringify(opts));
  }
  assert.throws(() => renderActivityPNG({ D, act: PEAK, layout: 'poster' }), /unknown layout/);
});

test('more activity gives a brighter image, up to the whole body firing', () => {
  const N = D.n.length;
  const acts = [new Float32Array(N), PEAK.map((v) => v * 0.5), PEAK, new Float32Array(N).fill(0.5), new Float32Array(N).fill(1)];
  const lum = acts.map((act) => meanLuminance(readPNG(renderActivityPNG({ D, act, width: 300 }))));
  for (let i = 1; i < lum.length; i++) assert.ok(lum[i - 1] < lum[i], `mean luminance ${lum.map((v) => v.toFixed(2)).join(', ')}`);
});

test('byte activity (0-255, as streamed) renders like the same values as floats', () => {
  const bytes = Uint8Array.from(PEAK, (v) => Math.round(v * 255));
  const a = renderActivityPNG({ D, act: bytes, width: 300 });
  const b = renderActivityPNG({ D, act: Float32Array.from(bytes, (v) => v / 255), width: 300 });
  assert.ok(a.equals(b));
});

test('the token shows the larva head up, seen from its back: its left side on screen-left', () => {
  const only = (pick) => Float32Array.from(D.n, (x) => (x[5] && pick(x) ? 1 : 0));
  const render = (act) => readPNG(renderActivityPNG({ D, act, width: 300, title: [] }));
  const left = render(only((x) => x[2] === 0)), right = render(only((x) => x[2] === 1)), head = render(only((x) => x[5][1] > 0.3));
  const half = (img, side) => meanLuminance(img, (x) => (side ? x >= 150 : x < 150));
  assert.ok(half(left, 0) > half(left, 1), 'left-side cells light the left half');
  assert.ok(half(right, 1) > half(right, 0), 'right-side cells light the right half');
  assert.ok(meanLuminance(head, (x, y) => y < 150) > meanLuminance(head, (x, y) => y >= 150), 'head cells light the top half');
});

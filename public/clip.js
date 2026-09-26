// Clip it: the last few seconds of the live worm, re-rendered as a square video with the message
// burned in (and sound, if it's on), ready to post. Recorded in the browser; nothing is uploaded.
import { createGLRenderer, deform } from '/gl.js';
import { create2DRenderer } from '/render2d.js';
import { createSound } from '/sound.js';
import { drawPixelText, paintLED, eyeWindows } from '/pixel.js';
import { VIEW } from '/shared/text.js';

export const CLIP_SECONDS = 8;
const FPS = 30, SIZE = 1080;
const TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export const clipSupported = () => typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream && TYPES.some((t) => MediaRecorder.isTypeSupported(t));

/** Ring buffer of what was on screen, one entry per 1/FPS s. */
export function createClipBuffer(N) {
  const cap = CLIP_SECONDS * FPS, buf = [];
  let lastT = -1e9;
  return {
    /** @param {{t:number, act:Uint8Array, cam, bend, st, shock, step, msg, nAct}} f */
    push(f) {
      if (f.t - lastT < 1000 / FPS - 2) return;
      lastT = f.t;
      buf.push({ ...f, act: Uint8Array.from(f.act.subarray(0, N)), cam: { ...f.cam } });
      if (buf.length > cap) buf.shift();
    },
    frames: () => buf.slice(),
    get seconds() { return buf.length ? (buf[buf.length - 1].t - buf[0].t) / 1000 : 0; },
  };
}

/**
 * Re-render the buffered frames into a video. Resolves to {blob, type, ext}.
 * @param {{frames, D, colors, kinds, withSound: boolean, site: string, headline: string, onProgress?: (f:number)=>void}} o
 */
export async function recordClip({ frames, D, colors, kinds, withSound, site, headline, onProgress = () => {} }) {
  if (frames.length < FPS) throw new Error('Not enough to clip yet. Give it a few seconds.');
  const out = document.createElement('canvas'); out.width = out.height = SIZE;
  const g = out.getContext('2d');
  const glc = document.createElement('canvas');
  const r = createGLRenderer(glc, { D, colors, kinds }) || create2DRenderer(glc, { D, colors, kinds });
  r.resize(SIZE, SIZE);
  const eye = document.createElement('canvas'); eye.width = 960; eye.height = 160;
  const eg = eye.getContext('2d');

  const stream = out.captureStream(FPS);
  let audio = null, actx = null;
  if (withSound) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = actx.createMediaStreamDestination();
    audio = createSound({ kinds, ctx: actx, output: dest });
    await audio.enable();
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  }
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 9e6, audioBitsPerSecond: 128e3 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  const panOf = (i) => {
    const vp = r.vp; if (!vp) return 0;
    const [x, y, z] = deform(D.n[i][5] || [0, 0, 0], 0, 0);
    const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    return (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w;
  };

  let peak = 0;
  function draw(f) {
    r.frame({ act: f.act, cam: { ...f.cam, ox: 0, oy: 0.08 }, bend: f.bend, st: f.st, shock: f.shock, time: f.t / 1000, hover: -1, dof: 0.4 });
    g.drawImage(glc, 0, 0, SIZE, SIZE);
    peak = Math.max(peak, f.nAct);
    // top: title and live badge
    const grad = g.createLinearGradient(0, 0, 0, 260); grad.addColorStop(0, 'rgba(2,4,7,.75)'); grad.addColorStop(1, 'rgba(2,4,7,0)');
    g.fillStyle = grad; g.fillRect(0, 0, SIZE, 260);
    const bw = drawPixelText(g, 'BRAIN', 56, 60, 6, '#DCE7EC');
    drawPixelText(g, 'WORM', 56 + bw + 6, 60, 6, '#FFB84D', 18);
    g.font = '600 26px "Geist Mono", ui-monospace, monospace';
    g.fillStyle = '#FF6B5E'; g.beginPath(); g.arc(SIZE - 200, 74, 9, 0, 6.2832); g.fill();
    g.fillText('LIVE', SIZE - 180, 83);
    g.fillStyle = 'rgba(220,231,236,.7)'; g.font = '500 22px "Geist Mono", ui-monospace, monospace';
    g.fillText(`step ${f.step.toLocaleString()}`, SIZE - 200, 116);
    // bottom: what the eyes see, and the count
    const g2 = g.createLinearGradient(0, SIZE - 380, 0, SIZE); g2.addColorStop(0, 'rgba(2,4,7,0)'); g2.addColorStop(1, 'rgba(2,4,7,.88)');
    g.fillStyle = g2; g.fillRect(0, SIZE - 380, SIZE, 380);
    paintLED(eg, eye.width, eye.height, VIEW, eyeWindows(f.msg, f.step).windows);
    g.drawImage(eye, 60, SIZE - 330, 960, 160);
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 2; g.strokeRect(60, SIZE - 330, 960, 160);
    g.font = '200 72px Geist, system-ui, sans-serif'; g.fillStyle = '#FFFFFF';
    g.fillText(`${f.nAct.toLocaleString()}`, 60, SIZE - 88);
    const w = g.measureText(`${f.nAct.toLocaleString()}`).width;
    g.font = '500 26px "Geist Mono", ui-monospace, monospace'; g.fillStyle = 'rgba(220,231,236,.8)';
    g.fillText('cells firing', 60 + w + 16, SIZE - 94);
    g.fillStyle = '#FFB84D'; g.font = '600 28px "Geist Mono", ui-monospace, monospace';
    const head = headline.length > 44 ? headline.slice(0, 43) + '…' : headline;
    g.fillText(head, 60, SIZE - 352);
    g.fillStyle = 'rgba(220,231,236,.55)'; g.font = '500 22px "Geist Mono", ui-monospace, monospace';
    const tag = `${site} · real larva connectome`;
    g.fillText(tag, SIZE - 60 - g.measureText(tag).width, SIZE - 40);
    if (audio) audio.update(f.act, panOf, f.st);
  }

  rec.start(250);
  const t0 = performance.now(), base = frames[0].t;
  for (let k = 0; k < frames.length; k++) {
    const due = frames[k].t - base;
    const wait = due - (performance.now() - t0);
    if (wait > 1) await new Promise((res) => setTimeout(res, wait));
    draw(frames[k]);
    onProgress((k + 1) / frames.length);
  }
  await new Promise((res) => setTimeout(res, 250));
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  if (actx) actx.close();
  glc.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  const blob = new Blob(chunks, { type: type.split(';')[0] });
  return { blob, type: blob.type, ext: blob.type.includes('mp4') ? 'mp4' : 'webm', peak };
}

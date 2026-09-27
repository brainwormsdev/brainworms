// Worker thread for server/lab.js: runs every registered lab experiment on the wiring it is given
// and posts progress, then the results. Kept off the main thread so the live worm never stutters.
import { parentPort, workerData } from 'node:worker_threads';
import { runLab } from '../shared/lab.js';
import { withTransmitters } from '../shared/data.js';

const post = (m) => parentPort.postMessage(m);

try {
  const dec = new TextDecoder();
  const D = withTransmitters(JSON.parse(dec.decode(workerData.wiring)), JSON.parse(dec.decode(workerData.transmitters)));
  const t0 = performance.now();
  let lastSent = -1;
  const lab = runLab(D, {
    scrambles: workerData.scrambles ?? undefined,
    onProgress: (p) => {
      const pct = Math.floor(p.fraction * 100);   // at most ~100 progress messages
      if (pct === lastSent && p.phase !== 'start') return;
      lastSent = pct;
      post({ type: 'progress', progress: { fraction: p.fraction, phase: p.phase, id: p.id, done: p.done, total: p.total } });
    },
  });
  post({ type: 'done', lab, ms: performance.now() - t0 });
} catch (e) {
  post({ type: 'error', message: e && e.stack ? e.stack : String(e) });
}

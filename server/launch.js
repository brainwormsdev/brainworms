// The $BRAINWORM launch: the worm's first full-body startle after arming sets the moment and the image.
//
//  1. armed:     a mod arms it. From then on, the first full-body startle (startle muscles above
//                STARTLE) is "the moment". The arming step and the moment go into the event log, so a
//                replay shows the moment really was the first startle after arming.
//  2. moment:    the server renders the token image from the worm's exact activity at that step and
//                publishes the step, the state hash and the image hash.
//  3. metadata:  on a mod's click, the image and metadata are uploaded to pump.fun's IPFS.
//  4. prepared:  the site builds the pump.fun create transaction for the owner's wallet, with a fresh
//                mint key signed in. The owner's wallet adds its signature and sends it. The server
//                never holds the owner's key and never sends anything itself.
//  5. launched:  once the transaction confirms, the mint is the site's contract address and live
//                trades start reaching the worm.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateString } from '../shared/replay.js';

export const STARTLE = 0.35;
export const TOKEN = { name: 'BRAINWORM', symbol: 'BRAINWORM' };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');   // same bytes on every Node build

export function createLaunch({ dir, worm, D, writeLog, render, solana, site = {}, publicUrl = '', pinataJwt = '', onChange = () => {}, onLaunched = () => {}, logger = console }) {
  const root = path.join(dir, 'launch');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'state.json');
  let s = { armed: null, moment: null, metadata: null, launched: null };
  try { s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  let pending = null;   // {mint, preparedAt} of the last prepared transaction
  const save = () => { fs.writeFileSync(file, JSON.stringify(s, null, 1)); onChange(status()); };

  function status() {
    return {
      token: { ...TOKEN },
      armed: s.armed && { at: s.armed.at, step: s.armed.step, rule: s.armed.rule },
      moment: s.moment && { ...s.moment, image: '/launch/moment.png' },
      metadata: s.metadata && { uri: s.metadata.uri },
      uploader: pinataJwt ? 'Pinata' : 'pump.fun',
      launched: s.launched,
    };
  }

  function arm(rule = 'first full-body startle') {
    if (s.moment) throw new Error('The moment has already been captured.');
    s.armed = { at: Date.now(), step: worm.step, rule };
    writeLog({ k: 'launch-armed', step: worm.step, rule, startle: STARTLE });
    save();
  }
  function disarm() {
    if (s.moment) throw new Error('The moment has already been captured.');
    if (s.armed) writeLog({ k: 'launch-disarmed', step: worm.step });
    s.armed = null; save();
  }

  /** Call after every simulation step. */
  function onStep() {
    if (!s.armed || s.moment || worm.last.st <= STARTLE) return;
    const state = stateString(worm);
    const act = Float32Array.from(worm.sim.r);
    const step = worm.step, stateSha256 = sha256(state);
    const lines = [`STEP ${commas(step)}`, `${commas(worm.last.nAct)} CELLS FIRING`];
    const png = render.renderActivityPNG({ D, act, width: 1000, height: 1000, layout: 'square', lines, footnote: `STATE SHA-256 ${stateSha256.slice(0, 16).toUpperCase()}` });
    fs.writeFileSync(path.join(root, 'moment.png'), png);
    s.moment = { step, stateSha256, imageSha256: sha256(png), nAct: worm.last.nAct, startle: Math.round(worm.last.st * 1000) / 1000, capturedAt: Date.now(), rule: s.armed.rule };
    writeLog({ k: 'launch-moment', step, stateSha256, imageSha256: s.moment.imageSha256, startle: STARTLE });
    logger.log(`launch moment captured at step ${step}`);
    save();
  }

  function description() {
    const m = s.moment;
    return [
      'A simulation of a real marine worm larva\'s nervous system (Platynereis dumerilii, 2,675 cells, wired as published in eLife 2025), running live' + (publicUrl ? ` at ${publicUrl}` : '') + '.',
      m ? `This image is the worm's activity at step ${m.step}, its first full-body startle after the launch was armed. State SHA-256 ${m.stateSha256}. Replay the log to check it.` : '',
    ].filter(Boolean).join(' ');
  }

  async function uploadMetadata({ twitter = '', telegram = '', website = publicUrl, fetchImpl } = {}) {
    if (!s.moment) throw new Error('Capture the moment first.');
    const image = fs.readFileSync(path.join(root, 'moment.png'));
    const opts = { image, filename: 'brainworm.png', ...TOKEN, description: description(), twitter, telegram, website, fetchImpl };
    const r = pinataJwt ? await solana.uploadPinataMetadata({ ...opts, jwt: pinataJwt }) : await solana.uploadPumpMetadata(opts);
    s.metadata = { uri: r.metadataUri, uploadedAt: Date.now() };
    save();
    return s.metadata;
  }

  async function prepare({ creator, amountSol = 0, slippage = 10, priorityFee = 0.0005, fetchImpl } = {}) {
    if (s.launched) throw new Error('Already launched.');
    if (!s.metadata) throw new Error('Upload the metadata first.');
    const r = await solana.prepareLaunch({ creator, ...TOKEN, uri: s.metadata.uri, amountSol, slippage, priorityFee, fetchImpl });
    pending = { mint: r.mint, preparedAt: Date.now() };
    return r;
  }

  async function confirm({ signature, fetchImpl, url } = {}) {
    if (!pending) throw new Error('Nothing was prepared.');
    const r = await solana.confirmLaunch({ signature, mint: pending.mint, fetchImpl, url });
    if (!r.confirmed || r.err || !r.mintExists) return { ok: false, ...r };
    s.launched = { mint: pending.mint, signature, confirmedAt: Date.now() };
    writeLog({ k: 'launch-confirmed', step: worm.step, mint: pending.mint, signature });
    pending = null;
    save();
    onLaunched(s.launched);
    return { ok: true, ...r };
  }

  return { status, arm, disarm, onStep, uploadMetadata, prepare, confirm, description, get mint() { return s.launched ? s.launched.mint : null; }, imagePath: path.join(root, 'moment.png') };
}

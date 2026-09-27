import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WormCore } from '../shared/worm.js';
import { renderText, VIEW, durationSteps } from '../shared/text.js';
import { checkMessage, RateLimiter } from '../server/moderation.js';
import { loadD } from './data.js';

const D = loadD();

function run(fn, steps = 500) {
  const events = [];
  const w = new WormCore(D, { onEvent: (e) => events.push(e) });
  fn(w);
  for (let t = 0; t < steps; t++) w.tick();
  return { w, events, done: events.filter((e) => e.type === 'done') };
}

test('wiring has the published cell, connection and synapse counts', () => {
  assert.equal(D.n.length, 2675);
  assert.equal(D.e.length / 3, 14066);
  let syn = 0; for (let k = 2; k < D.e.length; k += 3) syn += D.e[k];
  assert.equal(syn, 26881);
});

test('a resting worm stays at rest', () => {
  const { w } = run(() => {}, 200);
  assert.equal(w.last.nAct, 0);
});

test('a message excites the worm and it settles again', () => {
  const { w, events, done } = run((w) => w.say('a', 'gm'));
  assert.ok(events.some((e) => e.type === 'start' && e.id === 'a' && e.step === 0));
  assert.equal(done.length, 1);
  assert.ok(done[0].summary.peak > 10, `peak ${done[0].summary.peak}`);
  assert.equal(done[0].summary.flood, 0);
  assert.equal(w.last.nAct, 0);
});

test('solid light floods the non-directional light sensors and fires more cells than a word', () => {
  const solid = run((w) => w.say('a', '█████')).done[0].summary, word = run((w) => w.say('a', 'gm')).done[0].summary;
  assert.ok(solid.flood > 0);
  assert.equal(word.flood, 0);
  assert.ok(solid.peak > word.peak, `solid ${solid.peak}, word ${word.peak}`);
});

test('messages play one at a time, in order', () => {
  const { events } = run((w) => { assert.equal(w.say('a', 'gm'), 0); assert.equal(w.say('b', 'hi'), 1); }, 600);
  const starts = events.filter((e) => e.type === 'start');
  assert.deepEqual(starts.map((e) => e.id), ['a', 'b']);
  assert.ok(starts[1].step >= durationSteps(renderText('gm')));
});

test('pokes only accept touch-sensor cells', () => {
  const w = new WormCore(D);
  assert.equal(w.poke('x', [0, 1, 2, -1, 'a', 99999]), null);
  const ok = w.poke('y', [...w.roles.touch.slice(0, 8), w.roles.touch[0]]);
  assert.equal(ok.length, 6);
});

test('the simulation is deterministic', () => {
  const a = run((w) => { w.say('a', 'wagmi'); w.poke('p', w.roles.touch.slice(10, 16)); });
  const b = run((w) => { w.say('a', 'wagmi'); w.poke('p', w.roles.touch.slice(10, 16)); });
  assert.deepEqual(a.done.map((e) => e.summary), b.done.map((e) => e.summary));
  assert.deepEqual(Array.from(a.w.sim.r), Array.from(b.w.sim.r));
});

test('text rendering pads the message with dark columns', () => {
  const bmp = renderText('gm');
  assert.equal(bmp.lum[0], 0);
  assert.equal(bmp.lum[bmp.width - 1], 0);
  assert.ok(bmp.width > 2 * VIEW);
});

test('moderation blocks links and addresses, censors profanity', () => {
  assert.equal(checkMessage('check pump.fun now').code, 'link');
  assert.equal(checkMessage('go to https://x.co').code, 'link');
  assert.equal(checkMessage('join t.me/scam').code, 'link');
  assert.equal(checkMessage('ca 0x4eb990547bce4a982432ca88cf5fae7eed1a2d35').code, 'address');
  assert.equal(checkMessage('So11111111111111111111111111111111111111112').code, 'address');
  assert.equal(checkMessage('  ').code, 'empty');
  assert.equal(checkMessage('free airdrop here', ['free airdrop']).code, 'blocked');
  const c = checkMessage('this is fucking great');
  assert.ok(c.ok); assert.ok(!/fucking/.test(c.text));
  assert.deepEqual(checkMessage('gm   worm'), { ok: true, text: 'gm worm' });
  assert.equal([...checkMessage('x'.repeat(100)).text].length, 40);
});

test('rate limiter allows a burst then refills', () => {
  const rl = new RateLimiter({ ratePerSec: 1, burst: 2 });
  assert.ok(rl.take('ip', 0)); assert.ok(rl.take('ip', 0)); assert.ok(!rl.take('ip', 0));
  assert.ok(rl.take('ip', 1000));
});

test('real Solana addresses are caught, long words are not', () => {
  assert.equal(checkMessage('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU').code, 'address');
  assert.ok(checkMessage('wagmiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii').ok);
  assert.ok(checkMessage('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').ok);
});

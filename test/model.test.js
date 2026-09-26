import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MODEL_V2 } from '../shared/model.js';
import { canonicalJson } from '../shared/lab.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const REG = JSON.parse(fs.readFileSync(new URL('../data/registrations/model-v2.json', import.meta.url)));

test('model v2 is exactly as registered before it was ever run', () => {
  assert.equal(sha(canonicalJson(MODEL_V2)), 'f854f64a50c1ebabd4afed61f1b8e7903188cfeb39d3b71825751f64ea00a71b');
  assert.equal(REG.sha256['shared/model.js MODEL_V2'], sha(canonicalJson(MODEL_V2)));
  assert.equal(REG.sha256['data/transmitters.json'], sha(fs.readFileSync(new URL('../data/transmitters.json', import.meta.url))));
  assert.throws(() => { MODEL_V2.params.strength = 1; }, TypeError);
});

// The wiring and transmitters every test loads, exactly as the server does.
import fs from 'node:fs';
import { withTransmitters } from '../shared/data.js';

export const wiringRaw = fs.readFileSync(new URL('../data/wiring.json', import.meta.url));
export const txRaw = fs.readFileSync(new URL('../data/transmitters.json', import.meta.url));
export const loadD = () => withTransmitters(JSON.parse(wiringRaw), JSON.parse(txRaw));

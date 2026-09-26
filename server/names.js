// Anonymous handles for visitors, e.g. "salty-copepod-3f". Picked from fixed word lists,
// so a handle can never carry a link, an address or anything offensive.
import crypto from 'node:crypto';

const ADJ = ['salty', 'drifting', 'glowing', 'tiny', 'curious', 'sleepy', 'wiggly', 'brave', 'misty', 'bubbly',
  'lucky', 'cosmic', 'fuzzy', 'swift', 'quiet', 'coral', 'tidal', 'amber', 'neon', 'deep',
  'sunny', 'spiral', 'velvet', 'pearly', 'zesty', 'frosty', 'mellow', 'jolly', 'stormy', 'silver'];
const NOUN = ['copepod', 'plankton', 'larva', 'krill', 'polyp', 'diatom', 'urchin', 'shrimp', 'jelly', 'squid',
  'nudibranch', 'limpet', 'barnacle', 'seahorse', 'eel', 'clam', 'snail', 'anemone', 'starfish', 'nautilus',
  'axolotl', 'tardigrade', 'rotifer', 'sponge', 'mantis', 'crab', 'octopus', 'minnow', 'cephalopod', 'worm'];

export function makeHandle() {
  const b = crypto.randomBytes(3);
  return `${ADJ[b[0] % ADJ.length]}-${NOUN[b[1] % NOUN.length]}-${b[2].toString(16).padStart(2, '0')}`;
}

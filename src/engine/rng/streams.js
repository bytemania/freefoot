import { nextUint32, splitmix32 } from './sfc32.js';

const seeder = new Uint32Array(1);

/**
 * Fills the four words of `out` from a splitmix32 chain seeded with `seed`,
 * then discards the first 16 sfc32 outputs.
 * @param {Uint32Array} out four-word sfc32 state
 * @param {number} seed
 * @returns {Uint32Array} `out`
 */
export function seedSfc32(out, seed) {
  seeder[0] = seed >>> 0;
  out[0] = splitmix32(seeder);
  out[1] = splitmix32(seeder);
  out[2] = splitmix32(seeder);
  out[3] = splitmix32(seeder);
  for (let i = 0; i < 16; i++) nextUint32(out);
  return out;
}

/**
 * Seed for the commentary stream of one event.
 * @param {number} matchSeed
 * @param {number} seq event sequence number
 * @returns {number} uint32
 */
export function commentarySeed(matchSeed, seq) {
  return (matchSeed ^ Math.imul(seq + 1, 0x9e3779b9)) >>> 0;
}

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

const bodyStream = new Uint32Array(4);

/**
 * The ball-to-body stream: a short sfc32 sequence derived from the match seed, the tick and the
 * player hit, so body blocks draw from their own deterministic stream and never move the main one.
 * Draw with `nextFloat(bodyRandom(...))`; the returned array is shared and reseeded per call.
 * @param {number} matchSeed
 * @param {number} tick
 * @param {number} player player index
 * @returns {Uint32Array}
 */
export function bodyRandom(matchSeed, tick, player) {
  return seedSfc32(bodyStream, (matchSeed ^ Math.imul(tick + 1, 0x85ebca6b) ^ Math.imul(player + 1, 0xc2b2ae35)) >>> 0);
}

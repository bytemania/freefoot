/**
 * sfc32 generator and splitmix32 seeder (design §5, item 35).
 * `sfc32` works on any 4-word Uint32Array; the engine's lives in MatchState,
 * while commentary, squadgen and the bootstrap use their own.
 */

const INV_2_24 = 5.9604644775390625e-8; // 2^-24, exact

/**
 * Next 32-bit output, advancing `s` in place.
 * @param {Uint32Array} s four state words (a, b, c, counter)
 * @returns {number} uint32
 */
export function nextUint32(s) {
  const t = (s[0] + s[1] + s[3]) >>> 0;
  s[3] = (s[3] + 1) >>> 0;
  s[0] = s[1] ^ (s[1] >>> 9);
  s[1] = (s[2] + (s[2] << 3)) >>> 0;
  s[2] = (((s[2] << 21) | (s[2] >>> 11)) + t) >>> 0;
  return t;
}

/**
 * Uniform float in [0, 1): the top 24 bits times 2^-24.
 * @param {Uint32Array} s
 * @returns {number}
 */
export function nextFloat(s) {
  return (nextUint32(s) >>> 8) * INV_2_24;
}

/**
 * Uniform float in [lo, hi) (excludes `hi`).
 * @param {Uint32Array} s
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function range(s, lo, hi) {
  return lo + Math.floor(nextFloat(s) * (hi - lo));
}

/**
 * True with probability `p`.
 * @param {Uint32Array} s
 * @param {number} p
 * @returns {boolean}
 */
export function chance(s, p) {
  return nextFloat(s) < p;
}

/**
 * One splitmix32 step: increment 0x9E3779B9, multipliers 0x85EBCA6B and
 * 0xC2B2AE35, shifts 16, 13, 16. Advances `state[0]` in place.
 * @param {Uint32Array} state one-word state
 * @returns {number} uint32
 */
export function splitmix32(state) {
  state[0] = (state[0] + 0x9e3779b9) >>> 0;
  let z = state[0];
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

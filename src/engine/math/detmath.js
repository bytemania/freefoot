/**
 * Deterministic math (design §5, item 36). Built only from + - * / and the
 * Math members the lint rules allow, so every conforming engine returns the
 * same bits.
 */

export const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const QUARTER_PI = 0.7853981633974483;
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634;
const TAN_PI_8 = 0.41421356237309503;

/** Inputs to fastExp are clamped to this range. */
export const EXP_LIMIT = 20;

// 2^k for k in [-EXP_LIMIT*1.4427 - 1, +...], built by exact doubling.
const POW2_OFFSET = 32;
const POW2 = new Float64Array(2 * POW2_OFFSET + 1);
POW2[POW2_OFFSET] = 1;
for (let k = 1; k <= POW2_OFFSET; k++) {
  POW2[POW2_OFFSET + k] = POW2[POW2_OFFSET + k - 1] * 2;
  POW2[POW2_OFFSET - k] = POW2[POW2_OFFSET - k + 1] * 0.5;
}

/**
 * e^x for x clamped to [-20, 20]; relative error below 1e-6.
 * @param {number} x
 * @returns {number}
 */
export function fastExp(x) {
  const c = x > EXP_LIMIT ? EXP_LIMIT : x < -EXP_LIMIT ? -EXP_LIMIT : x;
  const k = Math.round(c * INV_LN2);
  const r = c - k * LN2; // |r| <= ln2 / 2
  // Taylor series to r^8 (truncation error below 1e-8 for |r| <= 0.3466).
  const p =
    1 + r * (1 + r * (1 / 2 + r * (1 / 6 + r * (1 / 24 + r * (1 / 120 + r * (1 / 720 + r * (1 / 5040 + r / 40320)))))));
  return p * POW2[POW2_OFFSET + k];
}

/**
 * 1 / (1 + e^-z).
 * @param {number} z
 * @returns {number}
 */
export function sigmoid(z) {
  return 1 / (1 + fastExp(-z));
}

/**
 * atan(t) for t in [0, 1].
 * @param {number} t
 * @returns {number}
 */
function atanUnit(t) {
  let z = t;
  let base = 0;
  if (t > TAN_PI_8) {
    z = (t - 1) / (t + 1);
    base = QUARTER_PI;
  }
  const z2 = z * z;
  // Odd series to z^13 on |z| <= tan(pi/8): truncation error about 1e-7.
  const s =
    1 -
    z2 * (1 / 3 - z2 * (1 / 5 - z2 * (1 / 7 - z2 * (1 / 9 - z2 * (1 / 11 - z2 * (1 / 13))))));
  return base + z * s;
}

/**
 * atan2(y, x) with absolute error below 1e-5 rad.
 * @param {number} y
 * @param {number} x
 * @returns {number}
 */
export function fastAtan2(y, x) {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  if (ax === 0 && ay === 0) return 0;
  let a = ay > ax ? HALF_PI - atanUnit(ax / ay) : atanUnit(ay / ax);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

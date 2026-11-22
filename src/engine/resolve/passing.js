/**
 * Pass resolution (design §9, §9a, item 43). Pure functions: plain numbers in,
 * results written into the caller-owned `out`. `k` is the `weights` object
 * with starting values per tick/second as built by TickConfig; `u` is a
 * uniform draw from the engine RNG. Attributes are raw 1-20 values.
 */
import { sigmoid } from '../math/detmath.js';

/** @param {number} a attribute 1-20 @returns {number} about [-0.9, 1] */
export function n(a) {
  return (a - 10) / 10;
}

/**
 * pComplete = sigmoid(p0 + p1 n(passing) + p2 n(technique) - p3 dist/30 - p4 laneThreat - p5 receiverPressure).
 * Direction error is e0 x dist x (1 - 0.5 n(passing)) metres.
 * @param {number} dist metres
 * @param {number} laneThreat 1 - laneSafety, in [0, 1]
 * @param {number} receiverPressure in [0, 1]
 * @param {number} passing
 * @param {number} technique
 * @param {any} k weights
 * @param {number} u uniform draw
 * @param {{pComplete: number, errM: number, accurate: boolean}} out
 */
export function passOutcome(dist, laneThreat, receiverPressure, passing, technique, k, u, out) {
  const p = k.pass;
  out.pComplete = sigmoid(p.p0 + p.p1 * n(passing) + p.p2 * n(technique) - (p.p3 * dist) / 30 - p.p4 * laneThreat - p.p5 * receiverPressure);
  out.errM = p.e0 * dist * (1 - 0.5 * n(passing));
  out.accurate = u < out.pComplete;
}

/**
 * pControl = sigmoid(t0 + t1 n(firstTouch) + t2 n(technique) - t3 ballSpeed/20 - t4 pressure).
 * @param {number} ballSpeed m/s
 * @param {number} pressure in [0, 1]
 * @param {number} firstTouchAttr
 * @param {number} technique
 * @param {any} k
 * @param {number} u
 * @param {{pControl: number, controlled: boolean}} out
 */
export function firstTouch(ballSpeed, pressure, firstTouchAttr, technique, k, u, out) {
  const t = k.firstTouch;
  out.pControl = sigmoid(t.t0 + t.t1 * n(firstTouchAttr) + t.t2 * n(technique) - (t.t3 * ballSpeed) / 20 - t.t4 * pressure);
  out.controlled = u < out.pControl;
}

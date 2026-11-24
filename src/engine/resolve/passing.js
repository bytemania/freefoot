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
 * @param {number} [edge] logit offset (the passer's morale)
 */
export function passOutcome(dist, laneThreat, receiverPressure, passing, technique, k, u, out, edge = 0) {
  const p = k.pass;
  out.pComplete = sigmoid(edge + p.p0 + p.p1 * n(passing) + p.p2 * n(technique) - (p.p3 * dist) / 30 - p.p4 * laneThreat - p.p5 * receiverPressure);
  out.errM = p.e0 * dist * (1 - 0.5 * n(passing));
  out.accurate = u < out.pComplete;
}

/** First-touch outcomes. */
export const TOUCH = Object.freeze({ CLEAN: 0, HEAVY: 1, SPILL: 2 });

/**
 * pControl = sigmoid(t0 + t1 n(firstTouch) + t2 n(technique) + t5 n(composure) - t3 ballSpeed/20 - t4 pressure - t6 height).
 * One draw `u` gives three outcomes: below pClean the touch is CLEAN, below pControl it is HEAVY (controlled, but the
 * ball runs on ahead), otherwise SPILL. The heavy share of the controlled touches is
 * sigmoid(heavyOffset + heavySpeed ballSpeed/20 + heavyPressure pressure - heavySkill n(firstTouch)), so a heavy
 * touch takes nothing from the spill rate. `heavyFrac` in [0, 1) is where `u` sits inside the heavy band, which sizes
 * the knock without another draw. `controlled` (clean or heavy) is what callers that do not model a heavy touch read.
 * @param {number} ballSpeed m/s
 * @param {number} pressure in [0, 1]
 * @param {number} firstTouchAttr
 * @param {number} technique
 * @param {any} k
 * @param {number} u
 * @param {{pControl: number, controlled: boolean, outcome: number, heavyFrac: number}} out
 * @param {number} [composure] attribute 1-20
 * @param {number} [height] ball height in metres at the touch
 */
export function firstTouch(ballSpeed, pressure, firstTouchAttr, technique, k, u, out, composure = 10, height = 0) {
  const t = k.firstTouch;
  const h = height > 2 ? 2 : height;
  out.pControl = sigmoid(
    t.t0 + t.t1 * n(firstTouchAttr) + t.t2 * n(technique) + t.t5Composure * n(composure) - (t.t3 * ballSpeed) / 20 - t.t4 * pressure - t.t6Height * h,
  );
  out.controlled = u < out.pControl;
  const heavy = sigmoid(t.heavyOffset + (t.heavySpeed * ballSpeed) / 20 + t.heavyPressure * pressure - t.heavySkill * n(firstTouchAttr));
  const pClean = out.pControl * (1 - heavy);
  out.heavyFrac = 0;
  if (u < pClean) {
    out.outcome = TOUCH.CLEAN;
  } else if (u < out.pControl) {
    out.outcome = TOUCH.HEAVY;
    out.heavyFrac = (u - pClean) / (out.pControl - pClean);
  } else {
    out.outcome = TOUCH.SPILL;
  }
}

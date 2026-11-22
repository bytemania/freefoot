/**
 * Geometry helpers (design §8, item 37). Every function writes into a
 * caller-owned output and allocates nothing.
 */
import { fastAtan2 } from './detmath.js';

/**
 * Closest point to (px, py) on the segment (ax, ay)-(bx, by).
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} px
 * @param {number} py
 * @param {{x: number, y: number, t: number}} out point and its parameter t in [0, 1]
 * @returns {{x: number, y: number, t: number}}
 */
export function closestPointOnSegment(ax, ay, bx, by, px, py, out) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  out.x = ax + t * dx;
  out.y = ay + t * dy;
  out.t = t;
  return out;
}

/**
 * Squared distance from (px, py) to the segment (ax, ay)-(bx, by).
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} px
 * @param {number} py
 * @returns {number}
 */
export function distSqPointSegment(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/**
 * Unit vector of (dx, dy). A zero vector gives (0, 0).
 * @param {number} dx
 * @param {number} dy
 * @param {{x: number, y: number}} out
 * @returns {number} the original length
 */
export function normalize(dx, dy, out) {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) {
    out.x = 0;
    out.y = 0;
  } else {
    out.x = dx / len;
    out.y = dy / len;
  }
  return len;
}

/**
 * Angle in radians subtended at (px, py) by the two goal posts at
 * (goalX, goalY - halfWidth) and (goalX, goalY + halfWidth).
 * @param {number} px
 * @param {number} py
 * @param {number} goalX
 * @param {number} goalY
 * @param {number} halfWidth
 * @returns {number}
 */
export function angleToPosts(px, py, goalX, goalY, halfWidth) {
  const ax = goalX - px;
  const ay = goalY - halfWidth - py;
  const bx = goalX - px;
  const by = goalY + halfWidth - py;
  const cross = ax * by - ay * bx;
  const dot = ax * bx + ay * by;
  const a = fastAtan2(cross, dot);
  return a < 0 ? -a : a;
}

/**
 * Whether (px, py) lies inside the triangle from the apex (ox, oy) to the
 * points A and B (for example the ball and both posts). Edges count as inside.
 * @param {number} ox
 * @param {number} oy
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} px
 * @param {number} py
 * @returns {boolean}
 */
export function inCone(ox, oy, ax, ay, bx, by, px, py) {
  const d1 = (ax - ox) * (py - oy) - (ay - oy) * (px - ox);
  const d2 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d3 = (ox - bx) * (py - by) - (oy - by) * (px - bx);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

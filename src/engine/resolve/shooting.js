/**
 * Shot resolution (design §9, §9a, item 43). Pure functions, see passing.js.
 */
import { sigmoid } from '../math/detmath.js';
import { n } from './passing.js';

const HALF_GOAL = 3.66;
const GOAL_HEIGHT = 2.44;

/**
 * Aim at (aimY, aimZ); the error radius is
 * r0 (1 - 0.5 n(finishing)) (1 + r1 pressure) (1 - 0.3 n(composure)) metres, and the
 * shot lands uniformly inside that square around the aim. A result inside the frame is
 * on target; within `postWidth` of the posts or bar is woodwork.
 * @param {number} finishing (headers pass (jumpingReach + finishing) / 2)
 * @param {number} composure
 * @param {number} pressure 0-1
 * @param {number} aimY metres from the goal centre, -3.66..3.66
 * @param {number} aimZ metres above the ground
 * @param {number} vAim shot speed
 * @param {any} k
 * @param {number} uY
 * @param {number} uZ
 * @param {{goalY: number, goalZ: number, vShot: number, onTarget: boolean, woodwork: boolean}} out
 */
export function shotPlacement(finishing, composure, pressure, aimY, aimZ, vAim, k, uY, uZ, out) {
  const s = k.shot;
  const r = s.r0 * (1 - 0.5 * n(finishing)) * (1 + s.r1 * pressure) * (1 - 0.3 * n(composure));
  const y = aimY + (uY * 2 - 1) * r;
  let z = aimZ + (uZ * 2 - 1) * r;
  if (z < 0) z = 0;
  const ay = y < 0 ? -y : y;
  const w = s.postWidth;
  out.goalY = y;
  out.goalZ = z;
  out.vShot = vAim;
  out.onTarget = ay <= HALF_GOAL && z <= GOAL_HEIGHT;
  out.woodwork = !out.onTarget && ay <= HALF_GOAL + w && z <= GOAL_HEIGHT + w;
}

/**
 * pSave = sigmoid(g0 + g1 n(reflexes) + g2 n(positioning) + g3 n(oneOnOnes) isOneOnOne - g4 placement - g5 vShot/30).
 * The save is HELD when vShot < h1, TIPPED when the shot was within `tippedDist` of the frame
 * edge, otherwise PARRIED.
 * @param {number} reflexes
 * @param {number} positioning
 * @param {number} oneOnOnes
 * @param {boolean} isOneOnOne
 * @param {number} placement 0 (central) to 1 (corner)
 * @param {number} vShot
 * @param {number} edgeDist distance in metres from the shot to the nearest frame edge
 * @param {any} k
 * @param {number} u
 * @param {{pSave: number, saved: boolean, kind: 'HELD' | 'PARRIED' | 'TIPPED'}} out
 */
export function saveOutcome(reflexes, positioning, oneOnOnes, isOneOnOne, placement, vShot, edgeDist, k, u, out) {
  const g = k.save;
  out.pSave = sigmoid(
    g.g0 + g.g1 * n(reflexes) + g.g2 * n(positioning) + (isOneOnOne ? g.g3 * n(oneOnOnes) : 0) - g.g4 * placement - (g.g5 * vShot) / 30,
  );
  out.saved = u < out.pSave;
  out.kind = vShot < g.h1 ? 'HELD' : edgeDist <= g.tippedDist ? 'TIPPED' : 'PARRIED';
}

/**
 * Shared geometry and constants for decisions and actions (design §9, §9b).
 * Everything works on `MatchState` and allocates nothing.
 */
import { distSqPointSegment } from '../math/geom.js';
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { PITCH_LENGTH, PITCH_WIDTH, PLAYERS_PER_TEAM } from '../state/MatchState.js';

/** Intent codes stored in `PlayerMatchState.pendingAction`. */
export const ACTION = Object.freeze({
  HOLD: 0,
  DRIBBLE: 1,
  PRESS: 2,
  MARK: 3,
  SUPPORT: 4,
  CHASE: 5,
  RECEIVE: 6,
  KEEPER: 7,
  /** A run in behind or an overlap: to (px, py) at chasing speed. */
  RUN: 8,
});

export const GOAL_Y = PITCH_WIDTH / 2;
export const HALF_GOAL = 3.66;
export const BOX_DEPTH = 16.5;
export const BOX_HALF_WIDTH = 20.16;
export const PENALTY_SPOT = 11;

/** cos and sin of 35 degrees (dribble directions) and cos of 30 degrees (the space cone). */
export const COS35 = 0.8191520442889918;
export const SIN35 = 0.573576436351046;
export const COS30 = 0.8660254037844387;

/** Result slot of `nearestOpponent`. */
export const nearest = { index: -1, dist: 0 };

/**
 * x position in the team's own frame: metres from its own goal line.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @param {number} x
 * @returns {number}
 */
export function along(state, team, x) {
  return state.attackDir(team) > 0 ? x : PITCH_LENGTH - x;
}

/**
 * x of the goal the team attacks.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @returns {number}
 */
export function attackGoalX(state, team) {
  return state.attackDir(team) > 0 ? PITCH_LENGTH : 0;
}

/**
 * Whether (x, y) is inside the penalty area the team attacks.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function inAttackingBox(state, team, x, y) {
  return along(state, team, x) >= PITCH_LENGTH - BOX_DEPTH && y >= GOAL_Y - BOX_HALF_WIDTH && y <= GOAL_Y + BOX_HALF_WIDTH;
}

/**
 * Whether (x, y) is inside the penalty area the team defends.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function inOwnBox(state, team, x, y) {
  return along(state, team, x) <= BOX_DEPTH && y >= GOAL_Y - BOX_HALF_WIDTH && y <= GOAL_Y + BOX_HALF_WIDTH;
}

/**
 * Distance to the nearest on-pitch opponent of `team` (also sets `nearest.index`).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team the team whose opponents are searched
 * @param {number} x
 * @param {number} y
 * @param {number} [exclude] opponent index to skip
 * @returns {number} Infinity when there is none
 */
export function nearestOpponent(state, team, x, y, exclude = -1) {
  let best = Infinity;
  let idx = -1;
  const list = state.onPitchList;
  for (let n = 0; n < list.length; n++) {
    const q = state.players[list[n]];
    if (q.team === team || q.index === exclude) continue;
    const d = (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y);
    if (d < best) {
      best = d;
      idx = q.index;
    }
  }
  nearest.index = idx;
  nearest.dist = best === Infinity ? Infinity : Math.sqrt(best);
  return nearest.dist;
}

/**
 * Distance from the nearest opponent of `team` to the segment A-B.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
export function opponentToSegment(state, team, ax, ay, bx, by) {
  let best = Infinity;
  const list = state.onPitchList;
  for (let n = 0; n < list.length; n++) {
    const q = state.players[list[n]];
    if (q.team === team) continue;
    const d = distSqPointSegment(ax, ay, bx, by, q.x, q.y);
    if (d < best) best = d;
  }
  return best === Infinity ? Infinity : Math.sqrt(best);
}

/**
 * Kinematic time-to-intercept margin of a pass: seconds by which the ball beats the fastest opposing player to the
 * target (positive: the ball is there first; negative: a defender gets there first). Each opponent reads the pass for
 * `decision.tti.reactionSec`, drifting on at their velocity, then runs at `topSpeed x chaseFraction`
 * (`topSpeed` is v0 + v1 x pace / 20, repeated here because Movement imports this module). A ground ball is also
 * checked at the point of its path nearest to each opponent, reached after the same share of the flight time, so a
 * defender standing in the lane is caught as well as one at the end. Allocation-free.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} passer
 * @param {number} tx target x
 * @param {number} ty target y
 * @param {number} ballSpeed m/s, the mean speed of the ball over the flight
 * @param {boolean} [lane] whether to check the ground lane (false for a lofted ball)
 * @returns {number} seconds, or Infinity with no opponent
 */
export function passInterceptMargin(state, passer, tx, ty, ballSpeed, lane = true) {
  const k = state.k.weights;
  const react = k.decision.tti.reactionSec;
  const run = k.movement.chaseFraction;
  const sx = tx - passer.x;
  const sy = ty - passer.y;
  const len2 = sx * sx + sy * sy;
  const tBall = Math.sqrt(len2) / ballSpeed;
  let margin = Infinity;
  const list = state.onPitchList;
  for (let n = 0; n < list.length; n++) {
    const q = state.players[list[n]];
    if (q.team === passer.team) continue;
    const speed = (k.movement.v0 + (k.movement.v1 * getEffectiveAttribute(q, 'pace', state.k)) / 20) * run;
    const qx = q.x + q.vx * react;
    const qy = q.y + q.vy * react;
    // At the target.
    let dx = tx - qx;
    let dy = ty - qy;
    let m = react + Math.sqrt(dx * dx + dy * dy) / speed - tBall;
    if (m < margin) margin = m;
    if (lane && len2 > 0) {
      // At the nearest point of the lane.
      let f = ((qx - passer.x) * sx + (qy - passer.y) * sy) / len2;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      dx = passer.x + f * sx - qx;
      dy = passer.y + f * sy - qy;
      m = react + Math.sqrt(dx * dx + dy * dy) / speed - f * tBall;
      if (m < margin) margin = m;
    }
  }
  return margin;
}

/**
 * Index of the on-pitch goalkeeper of `team`, or -1.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @returns {number}
 */
export function keeperOf(state, team) {
  const base = team * PLAYERS_PER_TEAM;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    if (state.players[i].onPitch === 1 && state.players[i].isKeeper === 1) return i;
  }
  return -1;
}

/**
 * Pressure on a point: 1 - min(1, nearest opponent / 5).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @param {number} x
 * @param {number} y
 * @param {number} pressureDist
 * @param {number} [exclude]
 * @returns {number}
 */
export function pressureAt(state, team, x, y, pressureDist, exclude = -1) {
  const d = nearestOpponent(state, team, x, y, exclude);
  const f = d / pressureDist;
  return 1 - (f > 1 ? 1 : f);
}

/**
 * sqrt(dx^2 + dy^2).
 * @param {number} dx
 * @param {number} dy
 * @returns {number}
 */
export function hyp(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

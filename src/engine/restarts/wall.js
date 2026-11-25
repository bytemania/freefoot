/**
 * Direct free-kick defensive wall positioning and 3D `(x, y, z)` wall clearance
 * / block evaluation. Keeps all tuning constants in `weights.setPieces`.
 */
import { PITCH_LENGTH, PITCH_WIDTH } from '../state/MatchState.js';
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { closestPointOnSegment, distSqPointSegment } from '../math/geom.js';
import { computeBallKinematics } from '../ball/BallPhysics.js';
import { attackGoalX, GOAL_Y, keeperOf } from '../decisions/Perception.js';
import { ARRIVAL_SLOP, CLEARANCE } from './laws.js';

const wallSeg = { x: 0, y: 0, t: 0 };

/** Wall bounds: never behind the goal line or in the goal, never on a touchline. */
export const WALL_MIN_X = 0.5;
export const WALL_MAX_X = PITCH_LENGTH - 0.5;
export const WALL_MIN_Y = 1.0;
export const WALL_MAX_Y = PITCH_WIDTH - 1.0;

/** @param {import('../state/PlayerMatchState.js').PlayerMatchState} p */
function clampPitchTarget(p) {
  p.tx = p.tx < 0.5 ? 0.5 : p.tx > PITCH_LENGTH - 0.5 ? PITCH_LENGTH - 0.5 : p.tx;
  p.ty = p.ty < 0.5 ? 0.5 : p.ty > PITCH_WIDTH - 0.5 ? PITCH_WIDTH - 0.5 : p.ty;
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Clamps a wall target to the wall bounds while keeping it exactly `radius`
 * from the ball (cx, cy): a clamped coordinate is held and the other one is
 * re-solved on the circle, on the same side as before.
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} q
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 */
function clampOnRing(q, cx, cy, radius) {
  for (let pass = 0; pass < 2; pass++) {
    const x = clamp(q.tx, WALL_MIN_X, WALL_MAX_X);
    const y = clamp(q.ty, WALL_MIN_Y, WALL_MAX_Y);
    if (x !== q.tx) {
      const dx = x - cx;
      const rest = radius * radius - dx * dx;
      q.tx = x;
      q.ty = cy + (q.ty >= cy ? 1 : -1) * Math.sqrt(rest > 0 ? rest : 0);
    } else if (y !== q.ty) {
      const dy = y - cy;
      const rest = radius * radius - dy * dy;
      q.ty = y;
      q.tx = cx + (q.tx >= cx ? 1 : -1) * Math.sqrt(rest > 0 ? rest : 0);
    } else {
      return;
    }
  }
  q.tx = clamp(q.tx, WALL_MIN_X, WALL_MAX_X);
  q.ty = clamp(q.ty, WALL_MIN_Y, WALL_MAX_Y);
}

/**
 * Picks up to `count` outfield defenders for a defensive wall (CB/FB first,
 * then MF, ordered by aerial ability). Never selects the goalkeeper.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} defTeam
 * @param {number} count
 * @returns {number[]}
 */
export function selectWallDefenders(state, defTeam, count) {
  /** @type {{idx: number, score: number}[]} */
  const cands = [];
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team !== defTeam || q.isKeeper === 1 || q.onPitch !== 1 || q.out === 1) continue;
    const roleBonus = q.cold.role === 'CB' || q.cold.role === 'FB' ? 40 : q.cold.role === 'MF' ? 20 : 0;
    const score = roleBonus + getEffectiveAttribute(q, 'jumpingReach', state.k) + getEffectiveAttribute(q, 'positioning', state.k) * 0.25;
    cands.push({ idx: i, score });
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.slice(0, count).map((c) => c.idx);
}

/**
 * Places a 2–5 outfield-player defensive wall across the line from the ball to the centre of the goal: the
 * wall's centre is on that line at the 10-yard distance (`wallDist` plus the free-kick clearance and arrival
 * slop, so the wall is legal, at least 9.15 m away, as it forms), and the members stand shoulder to shoulder
 * (`wallSpacing` apart) along its perpendicular, centred on the shot line, so every one of them is at least that
 * far from the ball. A wall that would cross a wall bound (a touchline, the goal line) slides along its own line
 * to fit; a member still outside (a free kick near the goal line) is clamped back onto the ring. The goalkeeper
 * is offset toward the far post. Only called for direct free kicks the caller found eligible (`wallEligible`).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {any} r
 * @param {number} distGoal
 * @param {Set<number>} assigned
 * @returns {number[]} wall member indices, in order across the wall
 */
export function positionDirectFreeKickWall(state, r, distGoal, assigned) {
  const sp = state.k.weights.setPieces;
  const attTeam = r.teamIndex;
  const defTeam = 1 - attTeam;
  const gx = attackGoalX(state, attTeam);
  // dir: ball to the centre of the defending goal; perp: across it.
  const wx = gx - r.x;
  const wy = GOAL_Y - r.y;
  const wLen = Math.sqrt(wx * wx + wy * wy) || 1;
  const ux = wx / wLen;
  const uy = wy / wLen;
  const px = -uy;
  const py = ux;

  const rawCount = Math.round(sp.wallMaxPlayers - (distGoal - 17) / 5);
  const count = Math.max(Math.round(sp.wallMinPlayers), Math.min(Math.round(sp.wallMaxPlayers), rawCount));
  const wallIndices = selectWallDefenders(state, defTeam, count);
  // Slots across the wall in the order the members stand across the shot line, so nobody has to cross another
  // to get to theirs (and the order holds as they close in).
  wallIndices.sort((a, b) => {
    const qa = state.players[a];
    const qb = state.players[b];
    return qa.x * px + qa.y * py - (qb.x * px + qb.y * py) || a - b;
  });
  const ring = sp.wallDist + CLEARANCE.FREE_KICK + ARRIVAL_SLOP;
  const cx = r.x + ux * ring;
  const cy = r.y + uy * ring;

  // Slide the wall along its own line so both ends are inside the wall bounds (when it fits at all).
  const half = ((wallIndices.length - 1) / 2) * sp.wallSpacing;
  let shift = 0;
  for (const end of [-half, half]) {
    const ex = cx + px * (end + shift);
    const ey = cy + py * (end + shift);
    if (Math.abs(py) > 1e-9 && (ey < WALL_MIN_Y || ey > WALL_MAX_Y)) shift += ((ey < WALL_MIN_Y ? WALL_MIN_Y : WALL_MAX_Y) - ey) / py;
    if (Math.abs(px) > 1e-9 && (ex < WALL_MIN_X || ex > WALL_MAX_X)) shift += ((ex < WALL_MIN_X ? WALL_MIN_X : WALL_MAX_X) - ex) / px;
  }

  for (let n = 0; n < wallIndices.length; n++) {
    const idx = wallIndices[n];
    const q = state.players[idx];
    const lateral = (n - (wallIndices.length - 1) / 2) * sp.wallSpacing + shift;
    q.tx = cx + px * lateral;
    q.ty = cy + py * lateral;
    if (q.tx < WALL_MIN_X || q.tx > WALL_MAX_X || q.ty < WALL_MIN_Y || q.ty > WALL_MAX_Y) clampOnRing(q, r.x, r.y, ring);
    assigned.add(idx);
  }
  state.wall.tick = state.tick;
  state.wall.members = wallIndices;

  const gkIdx = keeperOf(state, defTeam);
  if (gkIdx >= 0) {
    const gk = state.players[gkIdx];
    gk.tx = gx === 0 ? 1.0 : PITCH_LENGTH - 1.0;
    gk.ty = GOAL_Y + (r.y <= GOAL_Y ? sp.gkWallOffset : -sp.gkWallOffset);
    clampPitchTarget(gk);
    assigned.add(gkIdx);
  }
  return wallIndices;
}

/**
 * Computes 3D `(x, y, z)` free-kick ball flight with gravity + topspin dip and
 * checks it against wall defenders' `(x, y)` span and standing/jumping height
 * (`wallBlockHeight` ~1.85 m up to `wallBlockHeight + wallJumpBonus` ~2.30 m).
 *
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} shooter
 * @param {number} tx
 * @param {number} ty
 * @param {number} goalZ
 * @param {number} vShot
 * @param {number} fkSkillNorm `(skill - 10) / 10`
 * @returns {{blocked: boolean, blocker: number, impactZ: number, vz0: number, az: number, maxZ: number}}
 */
export function evalWallShot3D(state, shooter, tx, ty, goalZ, vShot, fkSkillNorm) {
  const k = state.k.weights;
  const sp = k.setPieces;
  const dist = Math.sqrt((tx - shooter.x) * (tx - shooter.x) + (ty - shooter.y) * (ty - shooter.y));
  const dipFactor = fkSkillNorm > -0.2 ? (fkSkillNorm + 0.2) * sp.fkDipAccel : 0;
  const totalAz = k.ball.gravity + dipFactor;
  const z0 = 0.12;
  const kin = computeBallKinematics(dist, z0, goalZ, vShot, totalAz);

  let bestT = Infinity;
  let blocker = -1;
  let impactZ = kin.peakZ;

  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team === shooter.team || q.isKeeper === 1) continue;
    const dFromShooter = Math.sqrt((q.x - shooter.x) * (q.x - shooter.x) + (q.y - shooter.y) * (q.y - shooter.y));
    if (dFromShooter < sp.wallDist - 1.7 || dFromShooter > sp.wallDist + 2.3) continue;
    if (distSqPointSegment(shooter.x, shooter.y, tx, ty, q.x, q.y) > sp.wallReachHalf * sp.wallReachHalf) continue;
    closestPointOnSegment(shooter.x, shooter.y, tx, ty, q.x, q.y, wallSeg);
    if (wallSeg.t < 0.05 || wallSeg.t > 0.95) continue;

    const tAtWall = wallSeg.t * kin.flightTime;
    const zAtWall = Math.max(0, z0 + kin.vz0 * tAtWall - 0.5 * kin.az * tAtWall * tAtWall);
    const jumpFrac = getEffectiveAttribute(q, 'jumpingReach', state.k) / 20;
    const wallTop = sp.wallBlockHeight + jumpFrac * sp.wallJumpBonus;

    if (zAtWall <= wallTop && wallSeg.t < bestT) {
      bestT = wallSeg.t;
      blocker = i;
      impactZ = zAtWall;
    }
  }

  return {
    blocked: blocker >= 0,
    blocker,
    impactZ: blocker >= 0 ? impactZ : goalZ,
    vz0: kin.vz0,
    az: kin.az,
    maxZ: kin.peakZ,
  };
}

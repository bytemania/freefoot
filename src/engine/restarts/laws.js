/**
 * Laws of the Game restart geometry (Laws 8, 13, 14, 15, 16, 17), in one place.
 *
 * `legalize` is the single source of truth: it projects a point to the nearest
 * legal spot for one player at a restart. A player is in violation exactly when
 * the projection of their live position moves them, so the validator
 * (`findRestartViolations`), the cap-time snap (`snapRestartViolators`) and the
 * positioning targets can never disagree about what legal means.
 *
 * Every rule keeps a clearance on top of the law line so a legal player never
 * looks inside it on the canvas (the player dot is about 1.4 m across at match
 * scale): 0.9 m for the lines drawn on the pitch (centre circle, penalty area
 * and arc, goal-kick area), 0.3 m for the free-kick, corner and throw-in
 * distances. Positioning targets add `ARRIVAL_SLOP` more, because a player
 * eases onto a target and never stands exactly on it.
 */
import { PITCH_LENGTH, PITCH_WIDTH } from '../state/MatchState.js';
import { BOX_DEPTH, BOX_HALF_WIDTH, GOAL_Y, HALF_GOAL, attackGoalX } from '../decisions/Perception.js';

/** Ten yards: the centre-circle, free-kick, corner and penalty-arc distance (m). */
export const TEN_YARDS = 9.15;
/** Throw-in distance for opponents (Law 15, m). */
export const THROW_IN_DISTANCE = 2;
/** Clearance kept on top of each law line (m), by restart kind. */
export const CLEARANCE = Object.freeze({
  KICK_OFF: 0.9,
  PENALTY: 0.9,
  GOAL_KICK: 0.9,
  FREE_KICK: 0.3,
  CORNER: 0.3,
  THROW_IN: 0.3,
});
/** Clearance from the halfway line at a kick-off (m). */
export const HALF_CLEARANCE = 0.5;
/** Extra distance positioning targets keep beyond the clearance (m). */
export const ARRIVAL_SLOP = 0.3;
/**
 * Ticks after `resumeTick` a restart waits for stragglers before the referee
 * moves them to a legal spot (3.5 s at 20 ticks/s).
 */
export const GRACE_TICKS = 70;
/** A projection moving a player further than this is a violation (m). */
const EPS = 1e-6;
/** Margin past the legal line when snapping, absorbing rounding (m). */
const SNAP_EXTRA = 0.05;

const MIN_X = 0.5;
const MAX_X = PITCH_LENGTH - 0.5;
const MIN_Y = 0.5;
const MAX_Y = PITCH_WIDTH - 0.5;
const CENTRE_X = PITCH_LENGTH / 2;
const CENTRE_Y = PITCH_WIDTH / 2;

/**
 * @typedef {{kind: string, teamIndex: number, x: number, y: number, taker: number}} RestartSpec
 * @typedef {{player: number, rule: string, x: number, y: number}} RestartViolation
 *   `x`, `y`: the nearest legal spot for the player
 */

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pushes `pt` radially out of the circle of radius `radius` around (cx, cy),
 * staying inside the pitch: a clamped coordinate is held and the other one is
 * re-solved on the circle, on the same side as before.
 * @param {{x: number, y: number}} pt
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @param {number} fallbackDx direction used when `pt` is on the centre
 * @returns {boolean} whether it moved
 */
function pushOutOfCircle(pt, cx, cy, radius, fallbackDx) {
  let dx = pt.x - cx;
  let dy = pt.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= radius * radius) return false;
  let d = Math.sqrt(d2);
  if (d < 1e-9) {
    dx = fallbackDx;
    dy = 0;
    d = Math.abs(fallbackDx) || 1;
  }
  let x = cx + (dx / d) * radius;
  let y = cy + (dy / d) * radius;
  const cxc = clamp(x, MIN_X, MAX_X);
  const cyc = clamp(y, MIN_Y, MAX_Y);
  if (cxc !== x) {
    x = cxc;
    const rest = radius * radius - (x - cx) * (x - cx);
    y = clamp(cy + (dy >= 0 ? 1 : -1) * Math.sqrt(rest > 0 ? rest : 0), MIN_Y, MAX_Y);
  } else if (cyc !== y) {
    y = cyc;
    const rest = radius * radius - (y - cy) * (y - cy);
    x = clamp(cx + (dx >= 0 ? 1 : -1) * Math.sqrt(rest > 0 ? rest : 0), MIN_X, MAX_X);
  }
  pt.x = x;
  pt.y = y;
  return true;
}

/**
 * Moves `pt` out of the penalty area of the goal on the line `gx`, inflated
 * by `clear` on every side, by the shorter way (back out of the area, or
 * sideways off it).
 * @param {{x: number, y: number}} pt
 * @param {number} gx x of the goal line
 * @param {number} clear
 * @returns {boolean} whether it moved
 */
function pushOutOfBox(pt, gx, clear) {
  const sgn = gx === 0 ? 1 : -1;
  const depthLimit = BOX_DEPTH + clear;
  const widthLimit = BOX_HALF_WIDTH + clear;
  const depth = (pt.x - gx) * sgn;
  const dy = pt.y - GOAL_Y;
  const adx = dy < 0 ? -dy : dy;
  if (depth >= depthLimit || adx >= widthLimit) return false;
  if (depthLimit - depth <= widthLimit - adx) {
    pt.x = gx + sgn * depthLimit;
  } else {
    pt.y = GOAL_Y + (dy < 0 ? -widthLimit : widthLimit);
  }
  return true;
}

/**
 * Whether a keeper stands on their own goal line between the posts, which
 * Laws 13 and 17 let them do inside the free-kick / corner distance.
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @returns {boolean}
 */
function keeperOnGoalLine(p) {
  if (p.isKeeper !== 1) return false;
  const toLine = p.x < PITCH_LENGTH - p.x ? p.x : PITCH_LENGTH - p.x;
  return toLine <= 1.5 && Math.abs(p.y - GOAL_Y) <= HALF_GOAL + 0.5;
}

/**
 * The kick-off team-mate allowed in the centre circle beside the taker: the
 * outfield player nearest the centre spot among those inside it.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {RestartSpec} spec
 * @returns {number} player index, or -1
 */
function kickOffSupport(state, spec) {
  let best = -1;
  let bestD = TEN_YARDS * TEN_YARDS;
  for (const i of state.onPitchList) {
    const p = state.players[i];
    if (p.team !== spec.teamIndex || i === spec.taker) continue;
    const dx = p.x - CENTRE_X;
    const dy = p.y - CENTRE_Y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Projects `pt` (a player's spot) to the nearest legal one for this restart.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {RestartSpec} spec
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {{x: number, y: number}} pt moved in place
 * @param {number} extra additional clearance beyond `CLEARANCE`
 * @param {number} support kick-off support player (see `kickOffSupport`)
 * @returns {string | null} the first rule that moved the point, or null when it was legal
 */
function legalize(state, spec, p, pt, extra, support) {
  const kind = spec.kind;
  const clear = (CLEARANCE[/** @type {keyof typeof CLEARANCE} */ (kind)] ?? 0) + extra;
  const defending = p.team !== spec.teamIndex;
  /** @type {string | null} */
  let rule = null;
  switch (kind) {
    case 'KICK_OFF': {
      if (p.index === spec.taker) return null;
      const dir = state.attackDir(p.team);
      const limit = CENTRE_X - dir * (HALF_CLEARANCE + extra); // own half, on the team's side of the line
      if ((dir > 0 && pt.x > limit) || (dir < 0 && pt.x < limit)) {
        pt.x = limit;
        rule = 'KICK_OFF_HALF';
      }
      if (p.index !== support || defending) {
        if (pushOutOfCircle(pt, CENTRE_X, CENTRE_Y, TEN_YARDS + clear, -dir)) rule ??= 'KICK_OFF_CIRCLE';
      }
      return rule;
    }
    case 'PENALTY': {
      if (p.index === spec.taker || p.isKeeper === 1) return null;
      const gx = attackGoalX(state, spec.teamIndex);
      const away = gx === 0 ? 1 : -1;
      for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        if (pushOutOfBox(pt, gx, clear)) {
          rule ??= 'PENALTY_BOX';
          moved = true;
        }
        if (pushOutOfCircle(pt, spec.x, spec.y, TEN_YARDS + clear, away)) {
          rule ??= 'PENALTY_ARC';
          moved = true;
        }
        if (!moved) break;
      }
      return rule;
    }
    case 'GOAL_KICK': {
      if (!defending) return null;
      const gx = spec.x < CENTRE_X ? 0 : PITCH_LENGTH;
      return pushOutOfBox(pt, gx, clear) ? 'GOAL_KICK_BOX' : null;
    }
    case 'FREE_KICK':
    case 'CORNER': {
      if (!defending || keeperOnGoalLine(p)) return null;
      return pushOutOfCircle(pt, spec.x, spec.y, TEN_YARDS + clear, spec.x < CENTRE_X ? 1 : -1) ? `${kind}_DISTANCE` : null;
    }
    case 'THROW_IN': {
      if (!defending) return null;
      return pushOutOfCircle(pt, spec.x, spec.y, THROW_IN_DISTANCE + clear, spec.x < CENTRE_X ? 1 : -1) ? 'THROW_IN_DISTANCE' : null;
    }
    default:
      return null;
  }
}

const probe = { x: 0, y: 0 };

/**
 * Every on-pitch player whose live position breaks the restart's rules (with
 * the clearance), and where the nearest legal spot is. The taker is exempt.
 * Pure: reads `state`, changes nothing.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {RestartSpec} [spec] defaults to the current restart
 * @returns {RestartViolation[]}
 */
export function findRestartViolations(state, spec = state.restart) {
  /** @type {RestartViolation[]} */
  const out = [];
  const support = spec.kind === 'KICK_OFF' ? kickOffSupport(state, spec) : -1;
  for (const i of state.onPitchList) {
    const p = state.players[i];
    probe.x = p.x;
    probe.y = p.y;
    const rule = legalize(state, spec, p, probe, 0, support);
    if (rule === null) continue;
    const dx = probe.x - p.x;
    const dy = probe.y - p.y;
    if (dx * dx + dy * dy > EPS * EPS) out.push({ player: i, rule, x: probe.x, y: probe.y });
  }
  return out;
}

/**
 * The referee's last resort at the end of the grace period: puts every
 * violating player on the nearest legal spot (a hair beyond the line), standing
 * still, in player-index order.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {RestartSpec} spec
 * @returns {number} how many players were moved
 */
export function snapRestartViolators(state, spec) {
  const support = spec.kind === 'KICK_OFF' ? kickOffSupport(state, spec) : -1;
  let moved = 0;
  for (const i of state.onPitchList) {
    const p = state.players[i];
    probe.x = p.x;
    probe.y = p.y;
    if (legalize(state, spec, p, probe, 0, support) === null) continue;
    const dx = probe.x - p.x;
    const dy = probe.y - p.y;
    if (dx * dx + dy * dy <= EPS * EPS) continue;
    probe.x = p.x;
    probe.y = p.y;
    legalize(state, spec, p, probe, SNAP_EXTRA, support);
    p.x = p.prevX = p.tx = probe.x;
    p.y = p.prevY = p.ty = probe.y;
    p.vx = 0;
    p.vy = 0;
    moved++;
  }
  return moved;
}

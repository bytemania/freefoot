/**
 * Off-ball decisions (design §9, §9a, §9b, item 42): the goalkeeper's position,
 * chasing a loose ball, receiving a pass, and for the team without the ball
 * pressing, marking and holding; for the team with it, support runs.
 * The chosen intent is stored on the player; `applyIntent` turns it into
 * movement targets every tick.
 */
import { PITCH_LENGTH, PITCH_WIDTH, PLAYERS_PER_TEAM } from '../state/MatchState.js';
import { ACTION, along, GOAL_Y, hyp, nearestOpponent } from './Perception.js';

/** Eight points on a ring, unit vectors. */
const RING_X = [1, 0.7071067811865476, 0, -0.7071067811865476, -1, -0.7071067811865476, 0, 0.7071067811865476];
const RING_Y = [0, 0.7071067811865476, 1, 0.7071067811865476, 0, -0.7071067811865476, -1, -0.7071067811865476];

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 */
export function decideOffBall(state, p) {
  const b = state.ball;
  const team = p.team;
  if (p.isKeeper === 1) {
    keeperPosition(state, p);
    return;
  }
  p.markTarget = -1;
  // A pass in flight: the receiver already runs to it (set at launch); the others react to its destination.
  if (b.pass !== null) {
    if (p.index === b.pass.receiver) return;
    const passTeam = state.players[b.pass.passer].team;
    if (passTeam !== team && isNearestOfTeam(state, p, b.pass.px, b.pass.py)) {
      p.pendingAction = ACTION.RECEIVE;
      p.px = b.pass.px;
      p.py = b.pass.py;
      return;
    }
    p.pendingAction = passTeam === team ? ACTION.SUPPORT : ACTION.HOLD;
    if (passTeam === team) supportRun(state, p);
    return;
  }
  if (b.owner < 0) {
    // Loose ball: the nearest player of each team goes for it.
    if (isNearestOfTeam(state, p, b.x, b.y)) {
      p.pendingAction = ACTION.CHASE;
    } else {
      p.pendingAction = ACTION.HOLD;
    }
    return;
  }
  const owner = state.players[b.owner];
  if (owner.team === team) {
    if (p.cold.role === 'CB' || p.cold.role === 'FB') p.pendingAction = ACTION.HOLD;
    else supportRun(state, p);
    return;
  }
  defend(state, p, owner);
}

/**
 * Whether `p` is the closest on-pitch outfield player of its team to a point
 * (ties go to the lower index).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function isNearestOfTeam(state, p, x, y) {
  const mine = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
  const base = p.team * PLAYERS_PER_TEAM;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const q = state.players[i];
    if (i === p.index || q.onPitch !== 1 || q.isKeeper === 1) continue;
    const d = (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y);
    if (d < mine || (d === mine && i < p.index)) return false;
  }
  return p.isKeeper !== 1;
}

/**
 * Press, mark or hold: the nearest defender presses the carrier inside their
 * press zone, the second nearest too when `pressTrigger` holds; the rest mark
 * the nearest unmarked attacker in their zone, or hold their anchor.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} carrier
 */
function defend(state, p, carrier) {
  const slot = state.config.tactics.formations[state.teams[p.team].formationId].slots[p.slot];
  const dCarrier = hyp(carrier.x - p.x, carrier.y - p.y);
  // Rank among team-mates by distance to the carrier.
  let rank = 0;
  const base = p.team * PLAYERS_PER_TEAM;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const q = state.players[i];
    if (i === p.index || q.onPitch !== 1 || q.isKeeper === 1) continue;
    const d = hyp(carrier.x - q.x, carrier.y - q.y);
    if (d < dCarrier || (d === dCarrier && i < p.index)) rank++;
  }
  // pressTrigger: the carrier faces its own goal, or has just received the ball.
  const ownGoalDir = state.attackDir(carrier.team) > 0 ? -1 : 1;
  const trigger = carrier.vx * ownGoalDir > 1 || state.tick - state.ball.touchTick <= 5;
  if (slot && dCarrier <= slot.pressZone && (rank === 0 || (rank === 1 && trigger))) {
    p.pendingAction = ACTION.PRESS;
    return;
  }
  // Mark the nearest unmarked attacker in this player's zone.
  if (slot && slot.markZone > 0) {
    let best = -1;
    let bestD = slot.markZone * slot.markZone;
    const obase = carrier.team * PLAYERS_PER_TEAM;
    for (let i = obase; i < obase + PLAYERS_PER_TEAM; i++) {
      const o = state.players[i];
      if (o.onPitch !== 1 || o.isKeeper === 1 || i === carrier.index) continue;
      const d = (o.x - p.tx) * (o.x - p.tx) + (o.y - p.ty) * (o.y - p.ty);
      if (d >= bestD) continue;
      let taken = false;
      for (let j = base; j < base + PLAYERS_PER_TEAM; j++) {
        if (j !== p.index && state.players[j].onPitch === 1 && state.players[j].markTarget === i) {
          taken = true;
          break;
        }
      }
      if (!taken) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      p.markTarget = best;
      p.pendingAction = ACTION.MARK;
      return;
    }
  }
  p.pendingAction = ACTION.HOLD;
}

/**
 * Support run: eight points on a 6 m ring around the anchor; take the onside
 * point farthest from the nearest opponent (ties go to the lower point index).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 */
function supportRun(state, p) {
  const ring = state.k.weights.support.ringRadius;
  const points = state.k.weights.support.points;
  // Offside line in the player's frame.
  let first = -Infinity;
  let second = -Infinity;
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team === p.team) continue;
    const a = along(state, p.team, q.x);
    if (a > first) {
      second = first;
      first = a;
    } else if (a > second) second = a;
  }
  let bestD = -1;
  let bx = p.tx;
  let by = p.ty;
  const n = points < 8 ? points : 8;
  for (let i = 0; i < n; i++) {
    const x = Math.min(PITCH_LENGTH - 0.5, Math.max(0.5, p.tx + RING_X[i] * ring));
    const y = Math.min(PITCH_WIDTH - 0.5, Math.max(0.5, p.ty + RING_Y[i] * ring));
    if (along(state, p.team, x) > second) continue; // offside
    const d = nearestOpponent(state, p.team, x, y);
    if (d > bestD) {
      bestD = d;
      bx = x;
      by = y;
    }
  }
  p.pendingAction = ACTION.SUPPORT;
  p.px = bx;
  p.py = by;
}

/**
 * Goalkeeper: on the line from the ball to the goal centre, at depth
 * `gkDepth = 1 + 5 (1 - dist / 40)` clamped to 0.5-6 m.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 */
function keeperPosition(state, p) {
  const k = state.k.weights.keeper;
  const b = state.ball;
  const goalX = state.attackDir(p.team) > 0 ? 0 : PITCH_LENGTH;
  const dx = b.x - goalX;
  const dy = b.y - GOAL_Y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let depth = k.depthBase + k.depthScale * (1 - dist / k.depthRef);
  depth = depth < k.depthMin ? k.depthMin : depth > k.depthMax ? k.depthMax : depth;
  const f = dist > 0 ? depth / dist : 0;
  p.pendingAction = ACTION.KEEPER;
  p.px = goalX + dx * f;
  p.py = GOAL_Y + dy * f;
}

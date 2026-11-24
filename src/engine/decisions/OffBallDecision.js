/**
 * Off-ball decisions (design §9, §9a, §9b, item 42): the goalkeeper's position,
 * chasing a loose ball, receiving a pass, and for the team without the ball
 * pressing, marking and holding; for the team with it, support runs.
 * The chosen intent is stored on the player; `applyIntent` turns it into
 * movement targets every tick.
 */
import { PITCH_LENGTH, PITCH_WIDTH, PLAYERS_PER_TEAM } from '../state/MatchState.js';
import { ACTION, along, GOAL_Y, hyp, nearestOpponent, opponentToSegment } from './Perception.js';
import { xT } from './xT.js';
import { isAttackingPhase } from '../tactics/Phase.js';

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
    const ob = state.k.weights.offBall;
    const role = ob === undefined ? '' : slotRole(state, p);
    if (role === 'FB' && overlapRun(state, p, owner, ob)) return;
    if (role === 'W' && wideChannel(state, p, owner, ob)) return;
    if (role === 'ST' && diagonalRun(state, p, owner, ob)) return;
    if (p.cold.role === 'CB' || p.cold.role === 'FB') p.pendingAction = ACTION.HOLD;
    else supportRun(state, p);
    return;
  }
  defend(state, p, owner);
}

/**
 * The role of the formation slot a player fills (their own role off-slot).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @returns {string}
 */
function slotRole(state, p) {
  if (p.slot < 0) return p.cold.role;
  return state.config.tactics.formations[state.teams[p.team].formationId].slots[p.slot]?.role ?? p.cold.role;
}

/**
 * Whether a team-mate of `p` is already making a run (one at a time).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @returns {boolean}
 */
function otherRunner(state, p) {
  const base = p.team * PLAYERS_PER_TEAM;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    if (i !== p.index && state.players[i].onPitch === 1 && state.players[i].pendingAction === ACTION.RUN) return true;
  }
  return false;
}

/**
 * Offside line (second-last opponent) in the team's own frame.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @returns {number}
 */
function lineOf(state, team) {
  let first = -Infinity;
  let second = -Infinity;
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team === team) continue;
    const a = along(state, team, q.x);
    if (a > first) {
      second = first;
      first = a;
    } else if (a > second) second = a;
  }
  return second;
}

/**
 * Pitch x for a distance `a` along the team's attacking axis.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @param {number} a
 * @returns {number}
 */
function xAlong(state, team, a) {
  const c = a < 0.5 ? 0.5 : a > PITCH_LENGTH - 0.5 ? PITCH_LENGTH - 0.5 : a;
  return state.attackDir(team) > 0 ? c : PITCH_LENGTH - c;
}

/**
 * Final-third build-up on the full-back's wing: they overlap the carrier
 * down the wide channel (`overlapWidth` from the touchline), staying onside.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} owner
 * @param {any} ob `weights.offBall`
 * @returns {boolean} whether a run was chosen
 */
function overlapRun(state, p, owner, ob) {
  const ownerAlong = along(state, p.team, owner.x);
  if (ownerAlong < ob.overlapAlong) return false;
  if (otherRunner(state, p)) return false;
  const side = p.ty < GOAL_Y ? -1 : 1;
  if ((owner.y - GOAL_Y) * side < 6) return false; // the ball is not on this wing
  const line = lineOf(state, p.team) - ob.runOnsideGap;
  const want = ownerAlong + 6 < line ? ownerAlong + 6 : line;
  if (want <= along(state, p.team, p.x)) return false;
  p.pendingAction = ACTION.RUN;
  p.px = xAlong(state, p.team, want);
  p.py = side < 0 ? ob.overlapWidth : PITCH_WIDTH - ob.overlapWidth;
  return true;
}

/**
 * Final-third build-up for a winger on the ball's wing: they come inside to
 * the half-space (`wingerInside` from the centre line), keeping the depth of
 * their anchor, while the full-back overlaps outside them.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} owner
 * @param {any} ob
 * @returns {boolean}
 */
function wideChannel(state, p, owner, ob) {
  const ownerAlong = along(state, p.team, owner.x);
  if (ownerAlong < ob.overlapAlong || p.index === owner.index) return false;
  const side = p.ty < GOAL_Y ? -1 : 1;
  if ((owner.y - GOAL_Y) * side <= 0) return false; // not the ball's wing
  // Width only: the winger keeps the depth of their anchor (onside).
  const line = lineOf(state, p.team) - ob.runOnsideGap;
  const base = along(state, p.team, p.tx);
  p.pendingAction = ACTION.SUPPORT;
  p.px = xAlong(state, p.team, base < line ? base : line);
  p.py = GOAL_Y + side * ob.wingerInside;
  return true;
}

/**
 * A striker's diagonal run in behind, into the gap between the centre-backs
 * (the most central gap of the last line), when a midfielder on the ball has time to look up
 * (pressure below `runPressureMax`) past `runAlong`. Ends onside.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} owner
 * @param {any} ob
 * @returns {boolean}
 */
function diagonalRun(state, p, owner, ob) {
  const ownerAlong = along(state, p.team, owner.x);
  if (slotRole(state, owner) !== 'MF' || ownerAlong < ob.runAlong || ownerAlong > ob.overlapAlong) return false;
  if (otherRunner(state, p)) return false; // one runner in behind at a time
  const pressure = 1 - Math.min(1, nearestOpponent(state, owner.team, owner.x, owner.y) / state.k.weights.decision.features.pressureDist);
  if (pressure > ob.runPressureMax) return false;
  // The four deepest outfield opponents, by y: aim for the most central gap
  // (between the centre-backs), so a striker starting off-centre runs diagonally.
  /** @type {{a: number, y: number}[]} */
  const deep = [];
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team === p.team || q.isKeeper === 1) continue;
    deep.push({ a: along(state, p.team, q.x), y: q.y });
  }
  deep.sort((u, v) => v.a - u.a || u.y - v.y);
  const last = deep.slice(0, 4).sort((u, v) => u.y - v.y);
  if (last.length < 2) return false;
  let gapY = GOAL_Y;
  let best = Infinity;
  for (let i = 0; i + 1 < last.length; i++) {
    const mid = (last[i].y + last[i + 1].y) / 2;
    const dy = Math.abs(mid - GOAL_Y);
    if (dy < best) {
      best = dy;
      gapY = mid;
    }
  }
  const want = lineOf(state, p.team) - ob.runOnsideGap;
  if (want <= along(state, p.team, p.x) + 1) return false;
  p.pendingAction = ACTION.RUN;
  p.px = xAlong(state, p.team, want);
  p.py = gapY;
  return true;
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
  // Counter-press: just after losing the ball up the pitch the nearest few close the new carrier down at once.
  const ob = state.k.weights.offBall;
  if (ob !== undefined && ob.counterPressTicks !== undefined && state.teams[p.team].pressTicks > 0 && slot && slot.role !== 'GK' && rank < ob.counterPressCount && dCarrier <= slot.pressZone * ob.counterPressZone) {
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
 * Second-last opponent in `team`'s own frame: the offside line.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @returns {number}
 */
function offsideSecond(state, team) {
  let first = -Infinity;
  let second = -Infinity;
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team === team) continue;
    const a = along(state, team, q.x);
    if (a > first) {
      second = first;
      first = a;
    } else if (a > second) second = a;
  }
  return second;
}

const SPOTS = 16;
const spotX = new Float64Array(SPOTS);
const spotY = new Float64Array(SPOTS);
const spotScore = new Float64Array(SPOTS);

/**
 * The shared support spots of the team with the ball (every `support.cadenceTicks`): sixteen spots on two rings
 * around the carrier, scored on lane safety from the carrier, closeness to the best passing distance, room from the
 * opponents and the xT gain, with a bonus for a spot within 3 m of one already held. The best two (at least a ring
 * apart) go to the nearest eligible midfielder, winger or striker, who keeps a spot against a slightly nearer rival
 * (`hysteresisM`). Nothing is allocated; the result lives on `TeamState.support*` (saved with the match).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 */
export function updateSupportSpots(state, team) {
  const sp = state.k.weights.support;
  const ts = state.teams[team];
  const owner = state.ball.owner;
  if (owner < 0 || state.players[owner].team !== team || !isAttackingPhase(ts.phase)) {
    ts.supportPlayer[0] = ts.supportPlayer[1] = -1;
    return;
  }
  const c = state.players[owner];
  const f = state.k.weights.decision.features;
  const second = offsideSecond(state, team);
  const cAlong = along(state, team, c.x);
  const cXt = xT(cAlong, c.y);
  let count = 0;
  for (let ring = 0; ring < 2; ring++) {
    const radius = ring === 0 ? sp.spotRadiusMin : sp.spotRadiusMax;
    for (let a = 0; a < 8; a++) {
      const x = Math.min(PITCH_LENGTH - 0.5, Math.max(0.5, c.x + RING_X[a] * radius));
      const y = Math.min(PITCH_WIDTH - 0.5, Math.max(0.5, c.y + RING_Y[a] * radius));
      const sa = along(state, team, x);
      let score = -Infinity;
      // Not offside, and not far behind the ball while the team is still short of the final stretch.
      if (sa <= second && !(sa < 60 && sa < cAlong - 2)) {
        const dx = x - c.x;
        const dy = y - c.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const lane = Math.min(1, opponentToSegment(state, team, c.x, c.y, x, y) / f.laneSafetyDist);
        const band = Math.max(0, 1 - Math.abs(dist - sp.optPassDist) / sp.optPassDist);
        const room = Math.min(1, nearestOpponent(state, team, x, y) / f.pressureDist);
        score = sp.wLane * lane + sp.wDist * band + sp.wSpace * room + sp.wXt * (xT(sa, y) - cXt);
        for (let k = 0; k < 2; k++) {
          if (ts.supportPlayer[k] >= 0 && Math.abs(x - ts.supportX[k]) + Math.abs(y - ts.supportY[k]) < 3) score += sp.hysteresis;
        }
      }
      spotX[count] = x;
      spotY[count] = y;
      spotScore[count] = score;
      count++;
    }
  }
  // The best spot, and the best one a ring away from it.
  let first = -1;
  for (let i = 0; i < count; i++) if (spotScore[i] > -Infinity && (first < 0 || spotScore[i] > spotScore[first])) first = i;
  let other = -1;
  if (first >= 0) {
    for (let i = 0; i < count; i++) {
      if (i === first || spotScore[i] === -Infinity) continue;
      const dx = spotX[i] - spotX[first];
      const dy = spotY[i] - spotY[first];
      if (dx * dx + dy * dy < sp.spotRadiusMin * sp.spotRadiusMin) continue;
      if (other < 0 || spotScore[i] > spotScore[other]) other = i;
    }
  }
  const prev0 = ts.supportPlayer[0];
  const prev1 = ts.supportPlayer[1];
  let taken = -1;
  for (let slot = 0; slot < 2; slot++) {
    const spot = slot === 0 ? first : other;
    let best = -1;
    let bestD = sp.maxAssignDist;
    if (spot >= 0) {
      for (const i of state.onPitchList) {
        const q = state.players[i];
        if (q.team !== team || i === owner || i === taken || q.isKeeper === 1) continue;
        const role = slotRole(state, q);
        if (role !== 'MF' && role !== 'W' && role !== 'ST') continue;
        let d = hyp(q.x - spotX[spot], q.y - spotY[spot]);
        if (i === prev0 || i === prev1) d -= sp.hysteresisM;
        if (d < bestD || (d === bestD && best >= 0 && i < best)) {
          bestD = d;
          best = i;
        }
      }
    }
    ts.supportPlayer[slot] = best;
    if (best >= 0) {
      ts.supportX[slot] = spotX[spot];
      ts.supportY[slot] = spotY[spot];
      taken = best;
    }
  }
}

/**
 * Support run: a player holding one of the team's shared support spots goes to it; anybody else takes, from eight
 * points on a ring around their anchor, the onside point farthest from the nearest opponent (ties go to the lower
 * point index).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 */
function supportRun(state, p) {
  const ts = state.teams[p.team];
  for (let k = 0; k < 2; k++) {
    if (ts.supportPlayer[k] === p.index) {
      p.pendingAction = ACTION.SUPPORT;
      p.px = ts.supportX[k];
      p.py = ts.supportY[k];
      return;
    }
  }
  const ring = state.k.weights.support.ringRadius;
  const points = state.k.weights.support.points;
  const second = offsideSecond(state, p.team);
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

/**
 * Ball actions (design §9, §9b, §13): passes, shots, clearances, dribbles,
 * goals and restart deliveries. Each action draws from the engine RNG, writes
 * the ball and the players, and emits its events.
 */
import { nextFloat } from '../rng/sfc32.js';
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { PITCH_LENGTH, PITCH_WIDTH } from '../state/MatchState.js';
import { launchGround, launchLofted } from '../ball/BallPhysics.js';
import { angleToPosts, inCone, distSqPointSegment, closestPointOnSegment } from '../math/geom.js';
import { passOutcome } from '../resolve/passing.js';
import { contestOutcome } from '../resolve/duels.js';
import { shotPlacement, saveOutcome } from '../resolve/shooting.js';
import { xg as xgModel, psxg as psxgModel } from '../xg/ShotModels.js';
import { judgeOffside } from '../officiating/Referee.js';
import { startRestart } from '../restarts/RestartMachine.js';
import { choosePassTarget } from './CarrierDecision.js';
import {
  ACTION, GOAL_Y, HALF_GOAL, along, attackGoalX, inAttackingBox, keeperOf, opponentToSegment, pressureAt,
} from './Perception.js';

const passOut = { pComplete: 0, errM: 0, accurate: false };
const placeOut = { goalY: 0, goalZ: 0, vShot: 0, onTarget: false, woodwork: false };
const saveOut = { pSave: 0, saved: false, kind: /** @type {'HELD' | 'PARRIED' | 'TIPPED'} */ ('HELD') };
const contestOut = { pWin: 0, won: false };
const seg = { x: 0, y: 0, t: 0 };

const GROUND_KINDS = new Set(['SHORT', 'THROUGH', 'SWITCH', 'GK_THROW']);
/** Kinds that appear as PASS meta.kind. */
const PASS_META_KINDS = new Set(['SHORT', 'LONG', 'THROUGH', 'SWITCH', 'CROSS', 'GK_THROW', 'GK_KICK']);

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Gives the ball to a player and forces them to decide on the next tick.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} index
 * @param {boolean} [touchEvents] emit TOUCH_IN_BOX when the player receives in the opponent box
 */
export function giveBall(state, index, touchEvents = true) {
  const b = state.ball;
  const p = state.players[index];
  b.owner = index;
  b.lastTouch = index;
  b.touchTick = state.tick;
  b.pass = null;
  b.flight = null;
  b.x = p.x;
  b.y = p.y;
  b.vx = 0;
  b.vy = 0;
  b.height = 0;
  // The new owner settles for a moment before deciding (less under pressure).
  const d = state.k.weights.decision;
  p.decisionTimer = pressureAt(state, p.team, p.x, p.y, d.features.pressureDist) > 0.6 ? d.settlePressureTicks : d.settleTicks;
  p.pendingAction = ACTION.HOLD;
  if (touchEvents && inAttackingBox(state, p.team, p.x, p.y)) {
    state.emit('TOUCH_IN_BOX', { teamIndex: p.team, actorIndex: index, x: p.x, y: p.y });
  }
}

/**
 * Closes a pass in flight: emits PASS (and CROSS) for open-play passes, records
 * the last completed pass, and emits POSSESSION_LOST for a failed one.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {boolean} completed
 */
export function endPass(state, completed) {
  const b = state.ball;
  const pass = b.pass;
  if (pass === null) return;
  b.pass = null;
  const passer = state.players[pass.passer];
  if (pass.receiver >= 0 && state.players[pass.receiver].pendingAction === ACTION.RECEIVE) {
    state.players[pass.receiver].pendingAction = ACTION.HOLD;
  }
  if (!pass.restart) {
    state.emit('PASS', {
      teamIndex: passer.team,
      actorIndex: pass.passer,
      secondaryIndices: pass.receiver >= 0 ? [pass.receiver] : [],
      x: passer.x,
      y: passer.y,
      meta: { kind: PASS_META_KINDS.has(pass.kind) ? pass.kind : 'SHORT', completed },
    });
    if (pass.kind === 'CROSS') {
      state.emit('CROSS', { teamIndex: passer.team, actorIndex: pass.passer, x: passer.x, y: passer.y, meta: { completed } });
    }
    if (!completed) state.emit('POSSESSION_LOST', { teamIndex: passer.team, actorIndex: pass.passer, x: passer.x, y: passer.y });
  }
  if (completed && pass.receiver >= 0) {
    state.lastPass = { passer: pass.passer, receiver: pass.receiver, tick: state.tick, kind: pass.restart ? 'SETPIECE' : pass.kind };
  }
}

/**
 * Second-last opponent position in the passer's frame (the offside line).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @returns {number}
 */
function offsideLine(state, team) {
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
 * Passes toward a team-mate (or `receiverIdx = -1` for a ball into an area).
 * Returns false when the pass was offside and play was stopped.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p the passer
 * @param {number} receiverIdx
 * @param {string} kind SHORT, LONG, THROUGH, SWITCH, CROSS, GK_THROW or GK_KICK
 * @param {string} [restartKind] the restart this delivers, or '' for open play
 * @param {number} [aimX] destination when there is no receiver
 * @param {number} [aimY]
 * @returns {boolean}
 */
export function launchPass(state, p, receiverIdx, kind, restartKind = '', aimX = 0, aimY = 0) {
  const k = state.k.weights;
  const r = receiverIdx >= 0 ? state.players[receiverIdx] : null;
  const tx = r ? r.x : aimX;
  const ty = r ? r.y : aimY;
  const dist = Math.sqrt((tx - p.x) * (tx - p.x) + (ty - p.y) * (ty - p.y));
  const shape = k.ball.kinds[kind === 'GK_THROW' ? 'SHORT' : kind === 'GK_KICK' ? 'LONG' : kind];
  const lofted = !GROUND_KINDS.has(kind);
  const laneSafety = Math.min(1, opponentToSegment(state, p.team, p.x, p.y, tx, ty) / k.decision.features.laneSafetyDist);
  const rPressure = r ? pressureAt(state, p.team, r.x, r.y, k.decision.features.pressureDist) : 0.3;
  passOutcome(dist, 1 - laneSafety, rPressure, getEffectiveAttribute(p, 'passing', state.k), getEffectiveAttribute(p, 'technique', state.k), k, nextFloat(state.rng), passOut);
  let ax = tx;
  let ay = ty;
  if (kind === 'THROUGH' && r) {
    const t = dist / shape.speed;
    ax += r.vx * t;
    ay += r.vy * t;
  }
  if (!passOut.accurate) {
    const mag = passOut.errM + 2;
    ax += (nextFloat(state.rng) * 2 - 1) * mag;
    ay += (nextFloat(state.rng) * 2 - 1) * mag;
  }
  ax = clamp(ax, -3, PITCH_LENGTH + 3);
  ay = clamp(ay, -3, PITCH_WIDTH + 3);

  if (r) {
    const ctx = {
      receiverAlong: along(state, p.team, r.x),
      ballAlong: along(state, p.team, p.x),
      secondLastAlong: offsideLine(state, p.team),
      tolerance: state.k.officiating.offsideTolerance,
      restartKind,
    };
    if (judgeOffside(ctx)) {
      state.emit('OFFSIDE', { teamIndex: r.team, actorIndex: receiverIdx, x: r.x, y: r.y });
      state.ball.owner = -1;
      startRestart(state, 'FREE_KICK', 1 - r.team, r.x, r.y, { direct: false });
      return false;
    }
  }

  const b = state.ball;
  b.owner = -1;
  if (lofted) launchLofted(state, p.x, p.y, ax, ay, shape.speed, shape.peak, p.index);
  else {
    // A rolling ball loses pace: launch hard enough to arrive with a few m/s left.
    const roll = k.ball.rolling / state.k.dt;
    const need = k.ball.arrivalSpeed + roll * Math.sqrt((ax - p.x) * (ax - p.x) + (ay - p.y) * (ay - p.y));
    launchGround(state, p.x, p.y, ax, ay, need > shape.speed ? need : shape.speed, p.index);
  }
  b.touchTick = state.tick;
  b.pass = { passer: p.index, receiver: receiverIdx, kind, restart: restartKind !== '', accurate: passOut.accurate, px: ax, py: ay, tried: [] };
  p.pendingAction = ACTION.HOLD;
  if (r) {
    r.pendingAction = ACTION.RECEIVE;
    r.px = ax;
    r.py = ay;
  }
  return true;
}

/**
 * Hoofs the ball upfield without a target (a clearance).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 */
export function launchClearance(state, p) {
  const dir = state.attackDir(p.team);
  const shape = state.k.weights.ball.kinds.CLEARANCE;
  const tx = clamp(p.x + dir * (30 + nextFloat(state.rng) * 15), 1, PITCH_LENGTH - 1);
  const ty = clamp(p.y + (nextFloat(state.rng) - 0.5) * 40, 1, PITCH_WIDTH - 1);
  state.ball.owner = -1;
  launchLofted(state, p.x, p.y, tx, ty, shape.speed, shape.peak, p.index);
  state.ball.touchTick = state.tick;
  state.emit('CLEARANCE', { teamIndex: p.team, actorIndex: p.index, x: p.x, y: p.y });
  p.pendingAction = ACTION.HOLD;
}

/**
 * Awards a goal: score, GOAL and ASSIST events, and the kick-off for the conceding team.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} scorer player index (the own-goal scorer for an own goal), or -1
 * @param {number} scoringTeam the team that scores
 * @param {'OPEN_PLAY' | 'PENALTY' | 'FREE_KICK' | 'OWN_GOAL'} kind
 * @param {number} x
 * @param {number} y
 */
export function awardGoal(state, scorer, scoringTeam, kind, x, y) {
  state.teams[scoringTeam].score++;
  const own = kind === 'OWN_GOAL';
  const eventTeam = own ? 1 - scoringTeam : scoringTeam;
  state.emit('GOAL', { teamIndex: eventTeam, actorIndex: scorer, x, y, meta: { kind } });
  const lp = state.lastPass;
  if (!own && lp !== null && lp.receiver === scorer && state.tick - lp.tick <= 200 && state.players[lp.passer].team === scoringTeam) {
    state.emit('ASSIST', { teamIndex: scoringTeam, actorIndex: lp.passer, secondaryIndices: [scorer], x: state.players[lp.passer].x, y: state.players[lp.passer].y });
  }
  state.lastPass = null;
  if (state.ball.pass !== null) state.ball.pass = null;
  startRestart(state, 'KICK_OFF', 1 - scoringTeam, PITCH_LENGTH / 2, PITCH_WIDTH / 2);
}

/**
 * Shoots. Placement, the block, the save and the goal are resolved at the
 * strike, in this order; xG and PSxG are reported, never used to decide.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {{header?: boolean, penalty?: boolean, freeKick?: boolean}} [options]
 */
export function launchShot(state, p, { header = false, penalty = false, freeKick = false } = {}) {
  const k = state.k.weights;
  const s = k.shot;
  const team = p.team;
  const gx = attackGoalX(state, team);
  const dirX = gx > 50 ? 1 : -1;
  const distance = Math.sqrt((gx - p.x) * (gx - p.x) + (GOAL_Y - p.y) * (GOAL_Y - p.y));
  const keeperIdx = keeperOf(state, 1 - team);
  const keeper = keeperIdx >= 0 ? state.players[keeperIdx] : null;
  const angle = angleToPosts(p.x, p.y, gx, GOAL_Y, HALF_GOAL);
  const finishing = getEffectiveAttribute(p, 'finishing', state.k);
  const heading = (getEffectiveAttribute(p, 'jumpingReach', state.k) + finishing) / 2;
  const skill = header ? heading : finishing;
  const nSkill = (skill - 10) / 10;
  // Aim: the far post when the angle is wide enough, otherwise the corner further from the keeper.
  const post = HALF_GOAL - 0.5;
  let aimY;
  if (angle >= s.thetaFar) aimY = p.y > GOAL_Y ? -post : post;
  else aimY = keeper !== null && keeper.y > GOAL_Y ? -post : post;
  const aimZ = finishing >= s.aimZFinishingMin ? s.aimZFinishing : s.aimZ;
  const vAim = header ? s.headS0 + s.headS1 * nSkill : s.s0 + s.s1 * nSkill;
  const pressure = penalty ? 0 : pressureAt(state, team, p.x, p.y, k.decision.features.pressureDist);
  shotPlacement(skill, getEffectiveAttribute(p, 'composure', state.k), pressure, aimY, aimZ, vAim, k, nextFloat(state.rng), nextFloat(state.rng), placeOut);
  const goalY = placeOut.goalY;
  const goalZ = placeOut.goalZ;
  const vShot = placeOut.vShot;

  // Shot quality (reported, not used to decide).
  let defendersInCone = 0;
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team !== team && q.isKeeper !== 1 && inCone(p.x, p.y, gx, GOAL_Y - HALF_GOAL, gx, GOAL_Y + HALF_GOAL, q.x, q.y)) defendersInCone++;
  }
  const lp = state.lastPass;
  const fromPass = lp !== null && lp.receiver === p.index && state.tick - lp.tick <= 200;
  const assistType = freeKick || (fromPass && lp.kind === 'SETPIECE') ? 'setPiece' : fromPass && lp.kind === 'CROSS' ? 'cross' : fromPass && lp.kind === 'THROUGH' ? 'through' : 'none';
  const xgValue = penalty ? state.config.xg.penaltyXg : xgModel({ distance, angle, isHeader: header, defendersInCone, assistType }, state.config.xg.logistic);

  // A defender on the path can block it (never a penalty).
  const tx = gx;
  const ty = GOAL_Y + goalY;
  let blocker = -1;
  const reach = k.contest.groundReach;
  if (!penalty) {
    let bestT = Infinity;
    for (const i of state.onPitchList) {
      const q = state.players[i];
      if (q.team === team || q.isKeeper === 1) continue;
      if (distSqPointSegment(p.x, p.y, tx, ty, q.x, q.y) > reach * reach) continue;
      closestPointOnSegment(p.x, p.y, tx, ty, q.x, q.y, seg);
      if (seg.t < 0.05 || seg.t > 0.95) continue;
      if (seg.t < bestT) {
        const d = Math.sqrt((q.x - seg.x) * (q.x - seg.x) + (q.y - seg.y) * (q.y - seg.y));
        contestOutcome(getEffectiveAttribute(q, 'positioning', state.k), vShot, d, reach, k, nextFloat(state.rng), contestOut);
        if (contestOut.won) {
          bestT = seg.t;
          blocker = i;
        }
      }
    }
  }

  const bodyPart = header ? 'HEAD' : 'FOOT';
  /** @type {'ON_TARGET' | 'OFF_TARGET' | 'BLOCKED' | 'WOODWORK'} */
  const result = blocker >= 0 ? 'BLOCKED' : placeOut.onTarget ? 'ON_TARGET' : placeOut.woodwork ? 'WOODWORK' : 'OFF_TARGET';
  const ps = result === 'ON_TARGET' ? psxgModel(xgValue, goalY, goalZ, vShot, state.config.xg.psxg) : 0;
  state.emit('SHOT', {
    teamIndex: team, actorIndex: p.index, x: p.x, y: p.y,
    meta: { result, xg: xgValue, psxg: ps, goalY, goalZ, vShot, distance, bodyPart },
  });
  if (xgValue >= state.config.playback.highlights.bigChanceXg) state.emit('BIG_CHANCE', { teamIndex: team, actorIndex: p.index, x: p.x, y: p.y, meta: { xg: xgValue } });
  if (fromPass && lp.passer !== p.index) {
    state.emit('KEY_PASS', { teamIndex: team, actorIndex: lp.passer, secondaryIndices: [p.index], x: state.players[lp.passer].x, y: state.players[lp.passer].y });
  }
  const b = state.ball;
  b.owner = -1;
  b.pass = null;
  b.lastTouch = p.index;
  b.touchTick = state.tick;
  p.pendingAction = ACTION.HOLD;

  if (result === 'BLOCKED') {
    const q = state.players[blocker];
    state.emit('BLOCK', { teamIndex: q.team, actorIndex: blocker, x: q.x, y: q.y });
    // Deflection: the reverse of the shot direction, turned by up to the deflection noise.
    let dx = p.x - q.x;
    let dy = p.y - q.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len;
    dy /= len;
    const tilt = (nextFloat(state.rng) * 2 - 1) * 0.4663;
    const nx = dx - dy * tilt;
    const ny = dy + dx * tilt;
    const nl = Math.sqrt(nx * nx + ny * ny);
    launchGround(state, q.x, q.y, q.x + nx / nl, q.y + ny / nl, vShot * 0.3, blocker);
    b.touchTick = state.tick;
    return;
  }
  if (result === 'OFF_TARGET') {
    // Wide or over the bar: the ball runs on past the goal line (lofted when high, so it clears the bar).
    const ex = gx + dirX * 4;
    const ey = ty + ((ty - p.y) / Math.max(1, Math.abs(gx - p.x))) * 4;
    if (goalZ > 2.44 && Math.abs(goalY) <= HALF_GOAL) launchLofted(state, p.x, p.y, ex, ey, vShot, 9, p.index);
    else launchGround(state, p.x, p.y, ex, ey, vShot, p.index);
    b.touchTick = state.tick;
    return;
  }
  if (result === 'WOODWORK') {
    b.x = b.prevX = gx - dirX * 0.3;
    b.y = b.prevY = clamp(ty, 0, PITCH_WIDTH);
    b.vx = -dirX * 8;
    b.vy = (nextFloat(state.rng) * 2 - 1) * 4;
    b.flight = null;
    return;
  }

  // On target: the keeper's save, else a goal.
  const isOneOnOne = penalty || (distance < s.oneOnOneDist && defendersInCone === 0);
  const placement = Math.max(Math.abs(goalY) / HALF_GOAL, goalZ / 2.44);
  const edge = Math.min(HALF_GOAL - Math.abs(goalY), 2.44 - goalZ);
  if (keeper !== null) {
    const kp = keeper;
    saveOutcome(
      getEffectiveAttribute(kp, 'reflexes', state.k), getEffectiveAttribute(kp, 'positioning', state.k), getEffectiveAttribute(kp, 'oneOnOnes', state.k),
      isOneOnOne, placement > 1 ? 1 : placement, vShot, edge, k, nextFloat(state.rng), saveOut,
    );
    if (saveOut.saved) {
      b.x = b.prevX = kp.x;
      b.y = b.prevY = kp.y;
      b.vx = 0;
      b.vy = 0;
      if (saveOut.kind === 'HELD') {
        giveBall(state, keeperIdx, false);
        if (isOneOnOne && !penalty) state.emit('SMOTHER', { teamIndex: kp.team, actorIndex: keeperIdx, x: kp.x, y: kp.y });
        else state.emit('SAVE', { teamIndex: kp.team, actorIndex: keeperIdx, x: kp.x, y: kp.y, meta: { kind: 'HELD', psxg: ps } });
      } else if (saveOut.kind === 'TIPPED') {
        state.emit('SAVE', { teamIndex: kp.team, actorIndex: keeperIdx, x: kp.x, y: kp.y, meta: { kind: 'TIPPED', psxg: ps } });
        b.lastTouch = keeperIdx;
        startRestart(state, 'CORNER', team, gx, ty < GOAL_Y ? 0 : PITCH_WIDTH);
      } else {
        state.emit('SAVE', { teamIndex: kp.team, actorIndex: keeperIdx, x: kp.x, y: kp.y, meta: { kind: 'PARRIED', psxg: ps } });
        b.lastTouch = keeperIdx;
        b.vx = -dirX * (4 + nextFloat(state.rng) * 3);
        b.vy = (nextFloat(state.rng) * 2 - 1) * 5;
      }
      return;
    }
  }
  awardGoal(state, p.index, team, penalty ? 'PENALTY' : freeKick ? 'FREE_KICK' : 'OPEN_PLAY', p.x, p.y);
}

/**
 * Runs the restart delivery for the taker, who already has the ball.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} takerIdx
 * @param {string} kind
 * @param {boolean} direct
 */
export function executeRestartAction(state, takerIdx, kind, direct) {
  const p = state.players[takerIdx];
  const team = p.team;
  const gx = attackGoalX(state, team);
  const toGoal = Math.sqrt((gx - p.x) * (gx - p.x) + (GOAL_Y - p.y) * (GOAL_Y - p.y));
  if (kind === 'PENALTY') {
    launchShot(state, p, { penalty: true });
    return;
  }
  if (kind === 'FREE_KICK' && direct && toGoal <= 27) {
    launchShot(state, p, { freeKick: true });
    return;
  }
  if (kind === 'CORNER' || (kind === 'FREE_KICK' && along(state, team, p.x) > 70 && toGoal > 27)) {
    // Delivery into the box: the best-placed team-mate, or the penalty spot.
    let target = -1;
    let bestReach = -1;
    for (const i of state.onPitchList) {
      const q = state.players[i];
      if (q.team !== team || i === takerIdx || q.isKeeper === 1) continue;
      if (!inAttackingBox(state, team, q.x, q.y)) continue;
      const reachScore = getEffectiveAttribute(q, 'jumpingReach', state.k) + getEffectiveAttribute(q, 'finishing', state.k);
      if (reachScore > bestReach) {
        bestReach = reachScore;
        target = i;
      }
    }
    launchPass(state, p, target, 'CROSS', kind, gx === 0 ? 11 : PITCH_LENGTH - 11, GOAL_Y);
    return;
  }
  if (kind === 'GOAL_KICK') {
    const t = choosePassTarget(state, p, 60, true);
    if (t >= 0) launchPass(state, p, t, 'GK_KICK', 'GOAL_KICK');
    else launchClearance(state, p);
    return;
  }
  // Throw-in, kick-off, drop ball and short free kicks: a safe short pass.
  const t = choosePassTarget(state, p, 30, false);
  if (t >= 0) launchPass(state, p, t, 'SHORT', kind);
}


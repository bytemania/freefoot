/**
 * Restart state machine (design §10, item 45): IN_PLAY, DEAD_BALL, HALF_TIME
 * and FULL_TIME. Owns the restart kind, the taker (§9b rules), the set-piece
 * hold, kick-off side and set-piece positioning, applies queued substitutions
 * on entering a dead ball, and turns a ball that left play into the right
 * restart.
 */
import { PITCH_LENGTH, PITCH_WIDTH, PLAYERS_PER_TEAM } from '../state/MatchState.js';
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { BALL_GOAL, BALL_GOAL_LINE, BALL_TOUCHLINE } from '../ball/BallPhysics.js';
import { along, attackGoalX, GOAL_Y, keeperOf, PENALTY_SPOT } from '../decisions/Perception.js';
import { giveBall, executeRestartAction, endPass, awardGoal } from '../decisions/Actions.js';
import { computeAnchors } from '../tactics/Formation.js';
import { positionDirectFreeKickWall } from './wall.js';

/**
 * Picks the taker of a restart by the §9b rules (ties go to the lower index).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {string} kind
 * @param {number} team
 * @param {number} x
 * @param {number} y
 * @param {boolean} direct
 * @returns {number} player index, or -1
 */
export function chooseTaker(state, kind, team, x, y, direct) {
  const k = state.k;
  const base = team * PLAYERS_PER_TEAM;
  const gx = attackGoalX(state, team);
  const toGoal = Math.sqrt((gx - x) * (gx - x) + (GOAL_Y - y) * (GOAL_Y - y));
  let best = -1;
  let bestScore = -Infinity;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const p = state.players[i];
    if (p.onPitch !== 1) continue;
    const keeper = p.isKeeper === 1;
    let score;
    switch (kind) {
      case 'GOAL_KICK':
        score = keeper ? 1 : -1;
        break;
      case 'THROW_IN': {
        if (keeper) continue;
        const wide = p.cold.role === 'FB' || p.cold.role === 'W';
        score = (wide ? 1000 : 0) - ((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y));
        break;
      }
      case 'CORNER':
        if (keeper) continue;
        score = getEffectiveAttribute(p, 'crossing', k);
        break;
      case 'FREE_KICK':
        if (keeper) continue;
        score = getEffectiveAttribute(p, direct && toGoal <= 30 ? 'finishing' : 'crossing', k);
        break;
      case 'PENALTY':
        if (keeper) continue;
        score = getEffectiveAttribute(p, 'finishing', k) + getEffectiveAttribute(p, 'composure', k);
        break;
      default: // KICK_OFF, DROP_BALL: the nearest outfield player
        if (keeper && kind !== 'DROP_BALL') continue;
        score = -((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y));
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Starts a dead-ball restart: the ball is placed at the spot, the taker is
 * chosen, and play resumes after the configured hold. After a kick-off the
 * players return to their kick-off positions.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {string} kind
 * @param {number} teamIndex team taking the restart
 * @param {number} x
 * @param {number} y
 * @param {{direct?: boolean, holdSeconds?: number}} [options]
 */
export function startRestart(state, kind, teamIndex, x, y, { direct = false, holdSeconds = 0 } = {}) {
  const r = state.restart;
  const b = state.ball;
  r.state = 'DEAD_BALL';
  r.kind = kind;
  r.teamIndex = teamIndex;
  r.x = x;
  r.y = y;
  const hold = state.config.tactics.setPieces[kind].seconds;
  r.resumeTick = state.tick + Math.ceil((holdSeconds > hold ? holdSeconds : hold) * 20);
  r.announced = false;
  r.direct = direct;
  b.x = b.prevX = x;
  b.y = b.prevY = y;
  b.vx = 0;
  b.vy = 0;
  b.height = 0;
  b.owner = -1;
  b.flight = null;
  b.pass = null;
  state.ballStatus.code = 0;
  state.advantage = null;
  if (kind === 'KICK_OFF') {
    for (const i of state.onPitchList) {
      const p = state.players[i];
      if (p.slot >= 0) {
        const slot = state.config.tactics.formations[state.teams[p.team].formationId].slots[p.slot];
        state.placeAtAnchor(p, slot.defend);
      }
    }
  }
  r.taker = chooseTaker(state, kind, teamIndex, x, y, direct);
}

/**
 * Applies queued substitutions, in command order. Called on entering a dead
 * ball and while a dead ball lasts.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function applyQueuedSubstitutions(state) {
  if (state.pendingSubs.length === 0) return;
  const queue = state.pendingSubs.slice().sort((a, b) => a.seq - b.seq);
  state.pendingSubs.length = 0;
  for (const sub of queue) performSubstitution(state, sub.teamIndex, sub.outIndex, sub.inIndex);
}

/**
 * Makes one substitution now: swaps the players, counts it, and emits the event.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 * @param {number} outIndex
 * @param {number} inIndex
 */
export function performSubstitution(state, teamIndex, outIndex, inIndex) {
  const out = state.players[outIndex];
  const incoming = state.players[inIndex];
  const wasKeeper = out.isKeeper === 1;
  state.substitute(outIndex, inIndex);
  out.out = 1;
  const team = state.teams[teamIndex];
  team.subsUsed++;
  if (incoming.cold.role === 'GK' && keeperOf(state, teamIndex) < 0) incoming.isKeeper = 1;
  else if (wasKeeper && incoming.isKeeper === 1 && incoming.cold.role !== 'GK') incoming.isKeeper = 1;
  state.emit('SUBSTITUTION', { teamIndex, actorIndex: outIndex, secondaryIndices: [inIndex], x: out.x, y: out.y });
}

/**
 * Turns a ball that left play (set by `updateBall` this tick) into the right
 * restart, or a goal (tick step 6).
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function handleBallOut(state) {
  const status = state.ballStatus;
  if (status.code === 0 || state.restart.state !== 'IN_PLAY') return;
  const b = state.ball;
  if (b.pass !== null) endPass(state, false);
  const lastTeam = b.lastTouch >= 0 ? state.players[b.lastTouch].team : -1;
  if (status.code === BALL_TOUCHLINE) {
    startRestart(state, 'THROW_IN', lastTeam === 0 ? 1 : 0, status.x, status.y);
    return;
  }
  const goalX = status.x;
  const scoring = attackGoalX(state, 0) === goalX ? 0 : 1;
  const defending = 1 - scoring;
  if (status.code === BALL_GOAL) {
    if (lastTeam === defending) awardGoal(state, b.lastTouch, defending, 'OWN_GOAL', status.x, status.y);
    else awardGoal(state, b.lastTouch, scoring, 'OPEN_PLAY', status.x, status.y);
    return;
  }
  if (status.code === BALL_GOAL_LINE) {
    if (lastTeam === defending) {
      startRestart(state, 'CORNER', scoring, goalX, status.y < GOAL_Y ? 0 : PITCH_WIDTH);
    } else {
      startRestart(state, 'GOAL_KICK', defending, goalX === 0 ? 5.5 : PITCH_LENGTH - 5.5, GOAL_Y);
    }
  }
}

/**
 * Starts the restart for a foul: a penalty (with its PENALTY_AWARDED event)
 * or a direct free kick, taken by the fouled team.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} fouledTeam
 * @param {number} x
 * @param {number} y
 * @param {boolean} penalty
 * @param {number} fouler
 * @param {number} fouled
 */
export function startFoulRestart(state, fouledTeam, x, y, penalty, fouler, fouled) {
  if (penalty) {
    state.emit('PENALTY_AWARDED', { teamIndex: fouledTeam, actorIndex: fouler, secondaryIndices: [fouled], x, y });
    const gx = attackGoalX(state, fouledTeam);
    startRestart(state, 'PENALTY', fouledTeam, gx === 0 ? PENALTY_SPOT : PITCH_LENGTH - PENALTY_SPOT, GOAL_Y);
  } else {
    startRestart(state, 'FREE_KICK', fouledTeam, x, y, { direct: true });
  }
}

/**
 * Advances the restart machine by one tick (tick step 6): announces a new dead
 * ball (and applies queued substitutions), and resumes play when the hold is over.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function advanceRestart(state) {
  const r = state.restart;
  if (r.state !== 'DEAD_BALL') return;
  if (!r.announced) {
    r.announced = true;
    applyQueuedSubstitutions(state);
    switch (r.kind) {
      case 'KICK_OFF':
        state.emit('KICK_OFF', { teamIndex: r.teamIndex, x: r.x, y: r.y });
        break;
      case 'DROP_BALL':
        state.emit('DROP_BALL', { teamIndex: r.teamIndex, x: r.x, y: r.y });
        break;
      case 'PENALTY':
        break;
      default:
        if (r.taker >= 0) {
          state.emit(r.kind, { teamIndex: r.teamIndex, actorIndex: r.taker, x: r.x, y: r.y, meta: r.kind === 'FREE_KICK' ? { direct: r.direct } : {} });
        }
    }
  }
  if (state.tick >= r.resumeTick && !state.awaitingDecision) resume(state);
}

/**
 * Hands the ball to the taker and runs the restart action.
 * @param {import('../state/MatchState.js').MatchState} state
 */
function resume(state) {
  const r = state.restart;
  r.state = 'IN_PLAY';
  let taker = r.taker;
  if (taker < 0 || state.players[taker].onPitch !== 1) taker = chooseTaker(state, r.kind, r.teamIndex, r.x, r.y, r.direct);
  if (taker < 0) return;
  const p = state.players[taker];
  p.x = p.prevX = r.x;
  p.y = p.prevY = r.y;
  p.vx = 0;
  p.vy = 0;
  giveBall(state, taker, false);
  executeRestartAction(state, taker, r.kind, r.direct);
}

/** Clamps a player's target coordinates inside the pitch touchlines.
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 */
function clampTarget(p) {
  p.tx = p.tx < 0.5 ? 0.5 : p.tx > PITCH_LENGTH - 0.5 ? PITCH_LENGTH - 0.5 : p.tx;
  p.ty = p.ty < 0.5 ? 0.5 : p.ty > PITCH_WIDTH - 0.5 ? PITCH_WIDTH - 0.5 : p.ty;
}

/**
 * Structured attacking & defending routines for corners and wide free kicks.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {any} r
 * @param {Set<number>} assigned
 */
function positionCornerOrWideFk(state, r, assigned) {
  const sp = state.k.weights.setPieces;
  const attTeam = r.teamIndex;
  const defTeam = 1 - attTeam;
  const gx = attackGoalX(state, attTeam);
  const dir = state.attackDir(attTeam);
  const nearSign = r.y < GOAL_Y ? -1 : 1;

  /** @type {{idx: number, aerial: number, pace: number, role: string}[]} */
  const attackers = [];
  /** @type {{idx: number, def: number, pace: number, role: string}[]} */
  const defenders = [];
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (i === r.taker || q.isKeeper === 1) continue;
    const pace = getEffectiveAttribute(q, 'pace', state.k);
    if (q.team === attTeam) {
      const aerial = getEffectiveAttribute(q, 'jumpingReach', state.k) + getEffectiveAttribute(q, 'finishing', state.k) * 0.5;
      attackers.push({ idx: i, aerial, pace, role: q.cold.role });
    } else if (q.team === defTeam) {
      const def = getEffectiveAttribute(q, 'jumpingReach', state.k) + getEffectiveAttribute(q, 'marking', state.k) * 0.6;
      defenders.push({ idx: i, def, pace, role: q.cold.role });
    }
  }

  // Attacking roles: 3 box targets, 1-2 edge-of-box runners, 2 fast rest-defense
  attackers.sort((a, b) => b.aerial - a.aerial);
  const boxCoords = [
    { x: gx - dir * 5.5, y: GOAL_Y }, // central 6-yard target
    { x: gx - dir * 6.5, y: GOAL_Y + nearSign * 5.0 }, // near-post runner
    { x: gx - dir * 7.5, y: GOAL_Y - nearSign * 5.5 }, // far-post aerial threat
  ];
  /** @type {{x: number, y: number}[]} */
  const threatPositions = [];
  for (let k = 0; k < boxCoords.length && k < attackers.length; k++) {
    const p = state.players[attackers[k].idx];
    p.tx = boxCoords[k].x;
    p.ty = boxCoords[k].y;
    clampTarget(p);
    assigned.add(p.index);
    threatPositions.push({ x: p.tx, y: p.ty });
  }

  // Rest defense: pick 2 fastest remaining outfielders (FB/CB bias) near halfway
  const remainingAtt = attackers.slice(Math.min(3, attackers.length));
  remainingAtt.sort((a, b) => (b.role === 'FB' || b.role === 'CB' ? 15 : 0) + b.pace - ((a.role === 'FB' || a.role === 'CB' ? 15 : 0) + a.pace));
  const restDefCount = Math.min(2, remainingAtt.length);
  const restDef = remainingAtt.slice(0, restDefCount);
  const edgeRunners = remainingAtt.slice(restDefCount, restDefCount + 2);

  for (let k = 0; k < restDef.length; k++) {
    const p = state.players[restDef[k].idx];
    p.tx = gx - dir * sp.cornerRestDefX;
    p.ty = GOAL_Y + (k === 0 ? -10 : 10);
    clampTarget(p);
    assigned.add(p.index);
  }
  for (let k = 0; k < edgeRunners.length; k++) {
    const p = state.players[edgeRunners[k].idx];
    p.tx = gx - dir * sp.cornerEdgeRadius;
    p.ty = GOAL_Y + (k === 0 ? -4.5 : 5.5);
    clampTarget(p);
    assigned.add(p.index);
  }

  // Defending roles: forward outlet near halfway, zonal near-post protector, man-markers on aerial threats
  if (defenders.length > 0) {
    const outletIdx = defenders.reduce((best, cur) => {
      const bScore = (best.role === 'ST' || best.role === 'W' ? 15 : 0) + best.pace;
      const cScore = (cur.role === 'ST' || cur.role === 'W' ? 15 : 0) + cur.pace;
      return cScore > bScore ? cur : best;
    }, defenders[0]);
    const outletP = state.players[outletIdx.idx];
    outletP.tx = gx - dir * sp.cornerOutletX;
    outletP.ty = GOAL_Y - nearSign * 8;
    clampTarget(outletP);
    assigned.add(outletP.index);

    const boxDefs = defenders.filter((d) => d.idx !== outletIdx.idx).sort((a, b) => b.def - a.def);
    if (boxDefs.length > 0) {
      const zonalP = state.players[boxDefs[0].idx];
      zonalP.tx = gx - dir * 5.2;
      zonalP.ty = GOAL_Y + nearSign * 4.2;
      clampTarget(zonalP);
      assigned.add(zonalP.index);
    }
    for (let k = 0; k < threatPositions.length && k + 1 < boxDefs.length; k++) {
      const markerP = state.players[boxDefs[k + 1].idx];
      markerP.tx = threatPositions[k].x + dir * 0.9;
      markerP.ty = threatPositions[k].y * 0.9 + GOAL_Y * 0.1;
      clampTarget(markerP);
      assigned.add(markerP.index);
    }
  }
}

/**
 * Anchors for a dead ball: everyone holds their shape, the taker goes to the
 * ball, set-piece routines position walls/markers/runners, and non-wall
 * opponents keep the minimum distance from the ball.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function positionForRestart(state) {
  const r = state.restart;
  computeAnchors(state, state.teams[0]);
  computeAnchors(state, state.teams[1]);
  const minD = state.config.tactics.setPieces[r.kind]?.minDistance ?? 0;
  const sp = state.k.weights.setPieces;
  /** @type {Set<number>} */
  const assigned = new Set();

  const gx = attackGoalX(state, r.teamIndex);
  const dxGoal = gx - r.x;
  const dyGoal = GOAL_Y - r.y;
  const distGoal = Math.sqrt(dxGoal * dxGoal + dyGoal * dyGoal);

  if (r.kind === 'FREE_KICK' && r.direct && distGoal <= sp.wallMaxDist && distGoal > 0.5) {
    positionDirectFreeKickWall(state, r, distGoal, assigned);
  } else if (r.kind === 'CORNER' || (r.kind === 'FREE_KICK' && along(state, r.teamIndex, r.x) > 70 && distGoal > sp.wideFkDist)) {
    positionCornerOrWideFk(state, r, assigned);
  }

  for (const i of state.onPitchList) {
    const p = state.players[i];
    if (i === r.taker) {
      p.tx = r.x;
      p.ty = r.y;
    } else if (p.team !== r.teamIndex && minD > 0 && !assigned.has(i)) {
      const dx = p.tx - r.x;
      const dy = p.ty - r.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minD + 1) {
        const f = d > 0 ? (minD + 1) / d : 0;
        p.tx = d > 0 ? r.x + dx * f : r.x + minD + 1;
        p.ty = d > 0 ? r.y + dy * f : r.y;
        clampTarget(p);
      }
    }
  }
}

/** @param {import('../state/MatchState.js').MatchState} state */
export function enterHalfTime(state) {
  state.restart.state = 'HALF_TIME';
  state.restart.kind = '';
  state.restart.taker = -1;
  state.emit('HALF_TIME');
}

/** @param {import('../state/MatchState.js').MatchState} state */
export function enterFullTime(state) {
  state.restart.state = 'FULL_TIME';
  state.restart.kind = '';
  state.restart.taker = -1;
  state.emit('FULL_TIME');
}

/**
 * Begins the second half: sides swap, the away team kicks off.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function startSecondHalf(state) {
  const c = state.clock;
  c.half = 2;
  c.halfTick = 0;
  c.addedSeconds = 0;
  c.addedTicks = 0;
  c.announced = false;
  for (const p of state.players) {
    if (p.onPitch === 1) {
      p.x = PITCH_LENGTH - p.x;
      p.y = PITCH_WIDTH - p.y;
      p.prevX = p.x;
      p.prevY = p.y;
      p.tx = PITCH_LENGTH - p.tx;
      p.ty = PITCH_WIDTH - p.ty;
    }
  }
  state.advantage = null;
  state.lastPass = null;
  startRestart(state, 'KICK_OFF', 1, PITCH_LENGTH / 2, PITCH_WIDTH / 2);
}


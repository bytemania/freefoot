/**
 * Pure, deterministic read-only inspection helpers for the `#seed` debug viewer
 * (Step 6). Never mutates `MatchState` and never touches `state.rng`, so
 * inspecting any tick has zero effect on simulation determinism.
 */
import { getEffectiveAttribute, roleRating } from '../state/PlayerMatchState.js';
import { PITCH_LENGTH, PITCH_WIDTH, TOTAL_PLAYERS } from '../state/MatchState.js';
import { angleToPosts, inCone } from '../math/geom.js';
import { zoneOf } from '../events/MatchEvent.js';
import { clockSeconds } from '../clock/MatchClock.js';
import { n } from '../resolve/passing.js';
import { xg as xgModel } from '../xg/ShotModels.js';
import {
  ACTION,
  COS30,
  COS35,
  SIN35,
  GOAL_Y,
  HALF_GOAL,
  along,
  attackGoalX,
  inAttackingBox,
  opponentToSegment,
  pressureAt,
} from '../decisions/Perception.js';

const WIDE_ZONES = [13, 15, 16, 18];

/** Human-readable FSM / action labels for debug overlays. */
export const ACTION_NAMES = Object.freeze({
  [ACTION.HOLD]: 'HOLD',
  [ACTION.DRIBBLE]: 'DRIBBLE',
  [ACTION.PRESS]: 'PRESS',
  [ACTION.MARK]: 'MARK',
  [ACTION.SUPPORT]: 'SUPPORT',
  [ACTION.CHASE]: 'CHASE',
  [ACTION.RECEIVE]: 'RECEIVE',
  [ACTION.KEEPER]: 'GK_SET',
});

/**
 * Second-last opponent along the team's attacking axis (offside line).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @returns {number}
 */
function offsideLineOf(state, team) {
  let first = -Infinity;
  let second = -Infinity;
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team === team) continue;
    const a = along(state, team, q.x);
    if (a > first) {
      second = first;
      first = a;
    } else if (a > second) {
      second = a;
    }
  }
  return second;
}

/**
 * Read-only breakdown of the current ball carrier's noiseless utility scores
 * (matching `CarrierDecision.js` exactly). Returns `null` when nobody owns
 * the ball.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function inspectCarrierDecision(state) {
  const owner = state.ball.owner;
  if (owner < 0) return null;
  const p = state.players[owner];
  const k = state.k.weights;
  const d = k.decision;
  const f = d.features;
  const team = p.team;
  const dir = state.attackDir(team);
  const gx = attackGoalX(state, team);
  const pressure = pressureAt(state, team, p.x, p.y, f.pressureDist);
  const line = offsideLineOf(state, team);

  /** @type {Array<{receiverIndex: number, number: number, name: string, role: string, passKind: string, dist: number, laneSafety: number, progress: number, receiverPressure: number, offside: boolean, score: number}>} */
  const passes = [];
  for (const i of state.onPitchList) {
    const r = state.players[i];
    if (r.team !== team || i === p.index) continue;
    const dist = Math.sqrt((r.x - p.x) * (r.x - p.x) + (r.y - p.y) * (r.y - p.y));
    if (dist < d.minPassDist || dist > d.maxPassDist) continue;
    const ls = Math.min(1, opponentToSegment(state, team, p.x, p.y, r.x, r.y) / f.laneSafetyDist);
    const progress = (Math.abs(gx - p.x) - Math.abs(gx - r.x)) / f.progressScale;
    const rp = pressureAt(state, team, r.x, r.y, f.pressureDist);
    const ahead = along(state, team, r.x) - along(state, team, p.x);
    let passKind = 'SHORT';
    if (dist > 25 && Math.abs(r.y - p.y) > 28) passKind = 'SWITCH';
    else if (ahead >= 15 && getEffectiveAttribute(p, 'vision', state.k) >= d.visionMin) passKind = 'THROUGH';
    else if (dist > 30) passKind = 'LONG';
    const ra = along(state, team, r.x);
    const offside = ra > 52.5 && ra > along(state, team, p.x) && ra > line + state.k.officiating.offsideTolerance;
    let score = d.w.pass.laneSafety * ls + d.w.pass.progress * progress + d.w.pass.receiverFree * (1 - rp);
    if (offside) score -= d.offsidePenalty;
    passes.push({
      receiverIndex: i,
      number: r.cold.number,
      name: r.cold.name,
      role: r.cold.role,
      passKind,
      dist,
      laneSafety: ls,
      progress,
      receiverPressure: rp,
      offside,
      score,
    });
  }
  passes.sort((a, b) => b.score - a.score || a.receiverIndex - b.receiverIndex);

  // Dribble directions
  const labels = ['LEFT_35', 'FORWARD', 'RIGHT_35'];
  const defVx = [dir * COS35, dir, dir * COS35];
  const defVy = [-SIN35, 0, SIN35];
  const dribblingAttr = getEffectiveAttribute(p, 'dribbling', state.k);
  const dribbles = [];
  for (let a = 0; a < 3; a++) {
    const vx = defVx[a];
    const vy = defVy[a];
    let space = 20;
    for (const i of state.onPitchList) {
      const q = state.players[i];
      if (q.team === team) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0 && len < space && (dx * vx + dy * vy) / len >= COS30) space = len;
    }
    const score = d.w.dribble.space * Math.min(1, space / f.spaceDist) + d.w.dribble.skill * n(dribblingAttr);
    dribbles.push({ dir: labels[a], vx, vy, space, score });
  }
  dribbles.sort((a, b) => b.score - a.score);

  // Shot
  const dGoal = Math.sqrt((gx - p.x) * (gx - p.x) + (GOAL_Y - p.y) * (GOAL_Y - p.y));
  const shotAvailable = p.isKeeper !== 1 && dGoal < d.shotMaxDist;
  let defendersInCone = 0;
  let angle = 0;
  let estXg = 0;
  let shotScore = -Infinity;
  if (shotAvailable) {
    for (const i of state.onPitchList) {
      const q = state.players[i];
      if (q.team !== team && q.isKeeper !== 1 && inCone(p.x, p.y, gx, GOAL_Y - HALF_GOAL, gx, GOAL_Y + HALF_GOAL, q.x, q.y)) {
        defendersInCone++;
      }
    }
    angle = angleToPosts(p.x, p.y, gx, GOAL_Y, HALF_GOAL);
    estXg = xgModel(
      { distance: dGoal, angle, isHeader: false, defendersInCone, assistType: 'none' },
      state.config.xg.logistic,
    );
    shotScore = d.w.shot.xg * estXg;
  }

  // Cross
  const inWideZone = p.isKeeper !== 1 && WIDE_ZONES.includes(zoneOf(p.x, p.y, dir));
  let matesInBox = 0;
  if (inWideZone) {
    for (const i of state.onPitchList) {
      const q = state.players[i];
      if (q.team === team && i !== p.index && inAttackingBox(state, team, q.x, q.y)) matesInBox++;
    }
  }
  const crossAvailable = inWideZone && matesInBox > 0;
  const crossScore = crossAvailable
    ? d.w.cross.wideZone + d.w.cross.boxMates * Math.min(1, matesInBox / f.boxMatesDiv)
    : -Infinity;

  // Clearance
  const alongX = along(state, team, p.x);
  const clearanceAvailable = p.isKeeper !== 1 && alongX < d.clearanceZone && pressure > d.clearancePressure;
  const clearanceScore = clearanceAvailable ? d.clearanceScore : -Infinity;

  // Hold
  const holdScore = p.isKeeper === 1 ? -Infinity : d.w.hold.free * (1 - pressure);

  // Best noiseless option
  const candidates = [
    { kind: 'PASS', score: passes.length > 0 ? passes[0].score : -Infinity, target: passes.length > 0 ? passes[0].receiverIndex : -1 },
    { kind: 'DRIBBLE', score: p.isKeeper === 1 ? -Infinity : dribbles[0].score, target: -1 },
    { kind: 'SHOT', score: shotScore, target: -1 },
    { kind: 'CROSS', score: crossScore, target: -1 },
    { kind: 'CLEARANCE', score: clearanceScore, target: -1 },
    { kind: 'HOLD', score: holdScore, target: -1 },
  ];
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  return {
    carrierIndex: p.index,
    teamIndex: team,
    number: p.cold.number,
    name: p.cold.name,
    role: p.cold.role,
    isKeeper: p.isKeeper === 1,
    pressure,
    decisionTimer: p.decisionTimer,
    bestKind: best.kind,
    bestScore: best.score,
    bestTarget: best.target,
    shot: {
      available: shotAvailable,
      distance: dGoal,
      angle,
      defendersInCone,
      xg: estXg,
      score: shotScore,
      goalX: gx,
      goalY: GOAL_Y,
    },
    passes: passes.slice(0, 5),
    dribbles,
    cross: { available: crossAvailable, inWideZone, matesInBox, score: crossScore },
    clearance: { available: clearanceAvailable, along: alongX, pressure, score: clearanceScore },
    hold: { score: holdScore, pressure },
  };
}

/**
 * Pure read-only tactical snapshot of the entire pitch for debug overlays and
 * player inspection. Never mutates state or RNG.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function inspectPitch(state) {
  const b = state.ball;
  const roles = state.config.roles;
  const players = [];

  for (let i = 0; i < TOTAL_PLAYERS; i++) {
    const p = state.players[i];
    const isCarrier = b.owner === i;
    const baseName = /** @type {Record<number, string>} */ (ACTION_NAMES)[p.pendingAction] ?? 'HOLD';
    const actionName = isCarrier && (p.pendingAction === ACTION.HOLD || p.pendingAction === ACTION.DRIBBLE)
      ? 'CARRY'
      : baseName;

    players.push({
      index: p.index,
      team: p.team,
      number: p.cold.number,
      name: p.cold.name,
      role: p.cold.role,
      onPitch: p.onPitch === 1,
      isKeeper: p.isKeeper === 1,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      tx: p.tx,
      ty: p.ty,
      action: p.pendingAction,
      actionName,
      fitness: p.fitness,
      card: p.card,
      injury: p.injury,
      decisionTimer: p.decisionTimer,
      ca: roleRating(p, roles, p.cold.role),
      attrs: {
        pace: getEffectiveAttribute(p, 'pace', state.k),
        passing: getEffectiveAttribute(p, 'passing', state.k),
        finishing: getEffectiveAttribute(p, 'finishing', state.k),
        dribbling: getEffectiveAttribute(p, 'dribbling', state.k),
        tackling: getEffectiveAttribute(p, 'tackling', state.k),
        positioning: getEffectiveAttribute(p, 'positioning', state.k),
        aggression: getEffectiveAttribute(p, 'aggression', state.k),
        composure: getEffectiveAttribute(p, 'composure', state.k),
        decisions: getEffectiveAttribute(p, 'decisions', state.k),
      },
    });
  }

  // Defensive line height & width spread per team (outfield on-pitch players).
  const teams = [0, 1].map((t) => {
    const dir = state.attackDir(t);
    let minAlong = Infinity;
    let maxAlong = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let defLineX = dir > 0 ? 0 : PITCH_LENGTH;

    for (let i = t * 18; i < (t + 1) * 18; i++) {
      const p = state.players[i];
      if (p.onPitch !== 1 || p.isKeeper === 1) continue;
      const a = along(state, t, p.x);
      if (a < minAlong) {
        minAlong = a;
        defLineX = p.x;
      }
      if (a > maxAlong) maxAlong = a;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    return {
      teamIndex: t,
      formationId: state.teams[t].formationId,
      attackDir: dir,
      score: state.teams[t].score,
      defensiveLineX: minAlong === Infinity ? (dir > 0 ? 0 : PITCH_LENGTH) : defLineX,
      defensiveLineAlong: minAlong === Infinity ? 0 : minAlong,
      widthMinY: minY === Infinity ? 0 : minY,
      widthMaxY: maxY === -Infinity ? PITCH_WIDTH : maxY,
      compactnessWidth: minY === Infinity ? 0 : maxY - minY,
      compactnessLength: minAlong === Infinity ? 0 : maxAlong - minAlong,
    };
  });

  return {
    tick: state.tick,
    clockSeconds: clockSeconds(state),
    half: state.clock.half,
    restartState: state.restart.state,
    restartKind: state.restart.kind,
    ball: {
      x: b.x,
      y: b.y,
      vx: b.vx,
      vy: b.vy,
      height: b.height,
      owner: b.owner,
      passTarget: b.pass ? b.pass.receiver : -1,
      passX: b.pass ? b.pass.px : -1,
      passY: b.pass ? b.pass.py : -1,
      passKind: b.pass ? b.pass.kind : null,
    },
    teams,
    players,
  };
}

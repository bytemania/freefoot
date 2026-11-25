/**
 * Decisions (design §9, §9a, §9b, item 42), tick step 2.
 *
 * Every on-pitch player decides every 5 ticks, staggered by
 * `(tick + playerIndex) mod 5`; a new owner decides at once. The carrier scores
 * pass, dribble, shot, cross, clearance and hold candidates with weighted
 * features plus triangular noise, and acts on the best. Everyone else picks
 * an intent in `OffBallDecision.js`. Intents set the movement targets every
 * tick.
 */
import { nextFloat } from '../rng/sfc32.js';
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { PITCH_LENGTH, PITCH_WIDTH } from '../state/MatchState.js';
import { computeAnchors } from '../tactics/Formation.js';
import { positionForRestart } from '../restarts/RestartMachine.js';
import { angleToPosts, inCone } from '../math/geom.js';
import { zoneOf } from '../events/MatchEvent.js';
import { dribbleOutcome } from '../resolve/duels.js';
import { n } from '../resolve/passing.js';
import { xg as xgModel } from '../xg/ShotModels.js';
import { giveBall, launchPass, launchShot, launchClearance } from './Actions.js';
import { decideOffBall, updateSupportSpots } from './OffBallDecision.js';
import { PHASE_EVERY, isAttackingPhase, updatePhases } from '../tactics/Phase.js';
import {
  ACTION, COS30, COS35, SIN35, GOAL_Y, HALF_GOAL, hyp, along, attackGoalX, inAttackingBox, nearestOpponent, nearest,
  opponentToSegment, passInterceptMargin, pressureAt,
} from './Perception.js';
import { xT } from './xT.js';
import { sigmoid } from '../math/detmath.js';
import { PHASE } from '../state/TeamState.js';

const beatOut = { pBeat: 0, beat: false };
let passKind = 'SHORT';

/** Metres from the pitch's centre line beyond which a pass target is in a wide channel (14 m from the touchline). */
const WIDE_CHANNEL = 20;
/** Metres from the centre line within which a pass target is in the central channel. */
const CENTRAL_CHANNEL = 12;

/** Wide attacking zones (§2, §9b). */
const WIDE_ZONES = [13, 15, 16, 18];

/**
 * Tick step 2: sets every on-pitch player's movement target.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function runDecisions(state) {
  if (state.restart.state === 'DEAD_BALL') {
    positionForRestart(state);
    state.teams[0].pressTicks = state.teams[1].pressTicks = 0;
    return;
  }
  if (state.teams[0].pressTicks > 0) state.teams[0].pressTicks--;
  if (state.teams[1].pressTicks > 0) state.teams[1].pressTicks--;
  if (state.tick % PHASE_EVERY === 0) updatePhases(state);
  computeAnchors(state, state.teams[0]);
  computeAnchors(state, state.teams[1]);
  const cadence = state.k.weights.support.cadenceTicks;
  if (state.tick % cadence === 0) {
    updateSupportSpots(state, 0);
    updateSupportSpots(state, 1);
  }
  updateDefensiveLines(state);
  const carrier = state.ball.owner;
  const list = state.onPitchList;
  for (let i = 0; i < list.length; i++) {
    const p = state.players[list[i]];
    let due;
    if (p.index === carrier) {
      // A new owner settles for `decisionTimer` ticks, then decides every cycle.
      if (p.decisionTimer > 0) {
        p.decisionTimer--;
        due = p.decisionTimer === 0;
      } else {
        due = (state.tick + p.index) % 5 === 0;
      }
    } else {
      p.decisionTimer = 0;
      due = (state.tick + p.index) % 5 === 0;
    }
    if (due) {
      if (p.index === carrier) decideCarrier(state, p);
      else decideOffBall(state, p);
    }
    applyIntent(state, p, carrier);
  }
}

/** Each team's defensive line this tick (own-frame x), read by the goal-side marking. */
const lineAlong = [0, 0];

/**
 * Refreshes both teams' defensive line (after the anchors, before the intents).
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function updateDefensiveLines(state) {
  if (state.k.weights.goalSide === undefined) return;
  lineAlong[0] = defensiveLine(state, 0);
  lineAlong[1] = defensiveLine(state, 1);
}

/**
 * The defensive line: the deepest centre-back / full-back anchor in the team's own frame (the shape's
 * line, not wherever a defender has strayed), or the deepest outfield anchor when no back-line slot is on.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @returns {number}
 */
function defensiveLine(state, team) {
  const slots = state.config.tactics.formations[state.teams[team].formationId].slots;
  let back = Infinity;
  let any = Infinity;
  const base = team * 18;
  for (let i = base; i < base + 18; i++) {
    const q = state.players[i];
    if (q.onPitch !== 1 || q.isKeeper === 1 || q.slot < 0) continue;
    const a = along(state, team, q.tx);
    if (a < any) any = a;
    const role = slots[q.slot].role;
    if ((role === 'CB' || role === 'FB') && a < back) back = a;
  }
  return back < Infinity ? back : any < Infinity ? any : 0;
}

/**
 * Sets `p`'s target goal-side of opponent `o`: `gap` metres from `o` toward `p`'s own goal (straight back,
 * turned `goalCentreWeight` of the way toward the goal centre: goal-side without giving up the outside).
 * Unless `o` has broken clear behind the defensive line (by more than `breakawayMargin`: then it is a
 * recovery run toward that point), the target never drops below the line, so the line holds its height.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} o
 * @param {number} gap
 * @param {{breakawayMargin: number, goalCentreWeight: number}} gs
 */
function goalSideTarget(state, p, o, gap, gs) {
  const ownDir = state.attackDir(p.team) > 0 ? -1 : 1;
  const gx = ownDir < 0 ? 0 : PITCH_LENGTH;
  // Direction: straight back toward the own goal line, turned `goalCentreWeight` of the way toward the goal centre.
  let dx = gx - o.x;
  let dy = GOAL_Y - o.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const w = gs.goalCentreWeight;
  dx = len > 1e-9 ? (1 - w) * ownDir + (w * dx) / len : ownDir;
  dy = len > 1e-9 ? (w * dy) / len : 0;
  const unit = Math.sqrt(dx * dx + dy * dy);
  const step = Math.min(gap, 0.5 * len) / (unit > 1e-9 ? unit : 1);
  let tx = o.x + dx * step;
  const ty = o.y + dy * step;
  const line = lineAlong[p.team];
  if (along(state, p.team, o.x) >= line - gs.breakawayMargin && along(state, p.team, tx) < line) {
    tx = state.attackDir(p.team) > 0 ? line : PITCH_LENGTH - line;
  }
  p.tx = tx;
  p.ty = ty;
}

/**
 * Turns the player's intent into this tick's movement target (exported for tests).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {number} carrier
 */
export function applyIntent(state, p, carrier) {
  const b = state.ball;
  switch (p.pendingAction) {
    case ACTION.DRIBBLE:
    case ACTION.SUPPORT:
    case ACTION.RECEIVE:
    case ACTION.KEEPER:
    case ACTION.RUN:
      p.tx = p.px;
      p.ty = p.py;
      break;
    case ACTION.PRESS:
      p.tx = b.x;
      p.ty = b.y;
      break;
    case ACTION.CHASE:
      p.tx = b.x + b.vx * 0.5;
      p.ty = b.y + b.vy * 0.5;
      break;
    case ACTION.MARK: {
      const o = p.markTarget >= 0 ? state.players[p.markTarget] : null;
      if (o !== null && o.onPitch === 1) {
        const gs = state.k.weights.goalSide;
        if (gs !== undefined) {
          // Goal side: between the opponent and the centre of the marker's own goal, holding the line.
          goalSideTarget(state, p, o, gs.markGap * state.teams[p.team].knobs.markGapMul, gs);
        } else {
          // Legacy: one and a half metres straight back toward the marker's own goal.
          const ownGoalDir = state.attackDir(p.team) > 0 ? -1 : 1;
          p.tx = o.x + ownGoalDir * 1.5;
          p.ty = o.y;
        }
      }
      break;
    }
    case ACTION.HOLD:
      if (p.index === carrier) {
        p.tx = p.x;
        p.ty = p.y;
      } else screen(state, p);
      break;
    default:
      if (p.index === carrier) {
        p.tx = p.x;
        p.ty = p.y;
      }
  }
}

/**
 * Line screening: a centre-back or full-back holding its zone while the team defends drops goal-side
 * of the nearest attacker within `screenRadius` of its anchor who has got goal-side of that anchor
 * (an attacker in front of it is left to the midfield; one already clear behind the line gets a recovery run).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 */
function screen(state, p) {
  const gs = state.k.weights.goalSide;
  if (gs === undefined || p.slot < 0 || p.isKeeper === 1) return;
  const team = state.teams[p.team];
  const radius = gs.screenRadius * team.knobs.screenMul; // man-to-man marking switches screening off
  if (radius <= 0) return;
  if (isAttackingPhase(team.phase)) return;
  const role = state.config.tactics.formations[team.formationId].slots[p.slot].role;
  if (role !== 'CB' && role !== 'FB') return;
  const anchorAlong = along(state, p.team, p.tx);
  let best = null;
  let bestD = radius * radius;
  for (const i of state.onPitchList) {
    const o = state.players[i];
    if (o.team === p.team || o.isKeeper === 1) continue;
    if (along(state, p.team, o.x) >= anchorAlong) continue;
    const d = (o.x - p.tx) * (o.x - p.tx) + (o.y - p.ty) * (o.y - p.ty);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  if (best !== null) goalSideTarget(state, p, best, gs.screenGap, gs);
}

/**
 * Triangular noise: the sum of two uniforms in [-0.5, 0.5], scaled by
 * n0 (1 - 0.5 n(decisions)) (1 + n1 (1 - fitness)) (1 - decisionNoise x morale level):
 * a confident player reads the options more cleanly.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @returns {number}
 */
function noise(state, p) {
  const d = state.k.weights.decision;
  const scale = d.n0 * (1 - 0.5 * n(getEffectiveAttribute(p, 'decisions', state.k))) * (1 + d.n1 * (1 - p.fitness)) * (1 - state.k.weights.morale.decisionNoise * p.moraleLevel) * state.teams[p.team].knobs.noiseMul;
  return (nextFloat(state.rng) - 0.5 + (nextFloat(state.rng) - 0.5)) * scale;
}

/** @returns {string} the kind the last `passScore` call chose */
export function lastPassKind() {
  return passKind;
}

/**
 * Pass score without noise; sets the module's `passKind` to the kind it would use.
 * Besides lane safety, progress and the receiver's space it reads the kinematic interception margin
 * (`passInterceptMargin`, against the lead point for a ball in behind or a runner) and the gain in xT.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} r
 * @param {number} line offside line in the passer's frame
 * @returns {number}
 */
export function passScore(state, p, r, line) {
  const k = state.k.weights;
  const d = k.decision;
  const f = d.features;
  const team = p.team;
  const dist = Math.sqrt((r.x - p.x) * (r.x - p.x) + (r.y - p.y) * (r.y - p.y));
  const ls = Math.min(1, opponentToSegment(state, team, p.x, p.y, r.x, r.y) / f.laneSafetyDist);
  const gx = attackGoalX(state, team);
  const progress = (Math.abs(gx - p.x) - Math.abs(gx - r.x)) / f.progressScale;
  const rp = pressureAt(state, team, r.x, r.y, f.pressureDist);
  const ahead = along(state, team, r.x) - along(state, team, p.x);
  if (dist > 25 && Math.abs(r.y - p.y) > 28) passKind = 'SWITCH';
  else if (ahead >= 15 && along(state, team, r.x) >= line - d.throughLineGap && getEffectiveAttribute(p, 'vision', state.k) >= d.visionMin) passKind = 'THROUGH'; // a ball in behind
  else if (dist > 30) passKind = 'LONG';
  else passKind = 'SHORT';
  // Directness and the attacking transition weigh progress and the kind of pass (all exact no-ops by default).
  const tk = state.teams[team].knobs;
  const progressW = d.w.pass.progress * tk.progressMul * (state.teams[team].phase === PHASE.TRANSITION_ATT ? tk.transitionProgressMul : 1);
  let score = d.w.pass.laneSafety * ls + progressW * progress + d.w.pass.receiverFree * (1 - rp);
  // A ball in behind is more (or less) inviting against the opponent's defensive line (`invitesThroughAdd`).
  score += passKind === 'SHORT' ? tk.shortPassAdd : passKind === 'THROUGH' ? tk.throughPassAdd + state.teams[1 - team].knobs.invitesThroughAdd : tk.longPassAdd;
  // Where the ball is meant to go: the receiver's feet, or ahead of a runner / a ball in behind (as `launchPass` leads a THROUGH ball).
  const shape = k.ball.kinds[passKind];
  let ax = r.x;
  let ay = r.y;
  if (passKind === 'THROUGH' || r.pendingAction === ACTION.RUN) {
    const t = dist / shape.speed;
    ax += r.vx * t;
    ay += r.vy * t;
    ax = ax < 0 ? 0 : ax > PITCH_LENGTH ? PITCH_LENGTH : ax;
    ay = ay < 0 ? 0 : ay > PITCH_WIDTH ? PITCH_WIDTH : ay;
  }
  // Attacking corridor: a bias toward a target in a wide channel or in the central one (0 by default).
  const lateral = Math.abs(ay - GOAL_Y);
  if (lateral > WIDE_CHANNEL) score += tk.widePassBias;
  else if (lateral < CENTRAL_CHANNEL) score += tk.centerPassBias;
  const margin = passInterceptMargin(state, p, ax, ay, shape.speed, shape.peak === 0);
  score += d.w.pass.tti * sigmoid(margin / d.tti.marginScale);
  score += d.w.pass.xt * (xT(along(state, team, ax), ay) - xT(along(state, team, p.x), p.y));
  if (looksOffside(state, p, r, line)) score -= d.offsidePenalty;
  return score;
}

/**
 * Whether team-mate `r` looks offside to the carrier `p`, given the line as the carrier reads it.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} r
 * @param {number} line offside line in the carrier's frame
 * @returns {boolean}
 */
function looksOffside(state, p, r, line) {
  const ra = along(state, p.team, r.x);
  return ra > 52.5 && ra > along(state, p.team, p.x) && ra > line + state.k.officiating.offsideTolerance;
}

/**
 * Game-state shift of the shot bias: `leadShotBias` when the team leads,
 * `trailShotBias` when it trails, scaled by the share of normal time played.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team
 * @returns {number}
 */
function gameStateBias(state, team) {
  const diff = state.teams[team].score - state.teams[1 - team].score;
  if (diff === 0) return 0;
  const gs = state.k.weights.decision.gameState;
  const played = ((state.clock.half - 1) * state.k.halfTicks + state.clock.halfTick) / (2 * state.k.halfTicks);
  return (diff > 0 ? gs.leadShotBias : gs.trailShotBias) * (played > 1 ? 1 : played);
}

/**
 * Second-last opponent in the carrier's frame (the offside line).
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
    } else if (a > second) second = a;
  }
  return second;
}

/**
 * The best pass target by score alone (no noise), for restarts and goal kicks.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {number} maxDist
 * @param {boolean} anyDirection true for a goal kick (long balls forward preferred)
 * @returns {number} receiver index, or -1
 */
export function choosePassTarget(state, p, maxDist, anyDirection) {
  const line = offsideLineOf(state, p.team);
  const minD = state.k.weights.decision.minPassDist;
  let best = -1;
  let bestScore = -Infinity;
  for (const i of state.onPitchList) {
    const r = state.players[i];
    if (r.team !== p.team || i === p.index) continue;
    const dist = Math.sqrt((r.x - p.x) * (r.x - p.x) + (r.y - p.y) * (r.y - p.y));
    if (dist < minD || dist > maxDist) continue;
    if (anyDirection && r.isKeeper === 1) continue;
    const score = passScore(state, p, r, line);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * The carrier's shot utility without noise, or null out of shooting range.
 *
 * `bias + gameState + xg x estimated xG`, then by where the carrier stands:
 *  - inside the opponent's penalty area (`along >= 88.5`, `|y - 34| <= 20.16`):
 *    `+ box x xG` (the chance's quality counts for more: good chances are
 *    taken, tight angles are not), `+ clearLane` with no outfield defender in
 *    the shooting cone, and
 *    `+ boxFree x (1 - pressure)` when that cone is empty, and
 *    `+ oneOnOne` with no outfield defender between the carrier and the goal,
 *    so attackers pull the trigger in the box instead of over-passing;
 *  - outside it: `- longRange x (1 - longRangeSkill x space x skill)`, where
 *    space is `1 - pressure` and skill the mean of n(technique) and
 *    n(finishing) clamped to 0-1 (the long-shot proxy): speculative shots stay
 *    rare unless the carrier has room and the technique for them.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {number} pressure pressure on the carrier (0-1)
 * @returns {null | {score: number, xg: number, cone: number, inBox: boolean, oneOnOne: boolean}}
 */
export function shotUtility(state, p, pressure) {
  const d = state.k.weights.decision;
  const w = d.w.shot;
  const team = p.team;
  const gx = attackGoalX(state, team);
  const dGoal = Math.sqrt((gx - p.x) * (gx - p.x) + (GOAL_Y - p.y) * (GOAL_Y - p.y));
  if (dGoal >= d.shotMaxDist) return null;
  const myAlong = along(state, team, p.x);
  let cone = 0;
  let between = 0;
  for (const i of state.onPitchList) {
    const q = state.players[i];
    if (q.team === team || q.isKeeper === 1) continue;
    if (inCone(p.x, p.y, gx, GOAL_Y - HALF_GOAL, gx, GOAL_Y + HALF_GOAL, q.x, q.y)) cone++;
    if (along(state, team, q.x) > myAlong && Math.abs(q.y - p.y) < 8) between++;
  }
  const est = xgModel({ distance: dGoal, angle: angleToPosts(p.x, p.y, gx, GOAL_Y, HALF_GOAL), isHeader: false, defendersInCone: cone, assistType: 'none' }, state.config.xg.logistic);
  // Shot appetite: a flat bias inside shooting range; game state moves it (a side
  // protecting a lead shoots less, a side chasing the game more, increasingly as
  // the match goes on).
  let score = w.bias + gameStateBias(state, team) + w.xg * est;
  const inBox = inAttackingBox(state, team, p.x, p.y);
  const oneOnOne = inBox && between === 0;
  if (inBox) {
    score += (w.box ?? 0) * est;
    if (cone === 0) score += (w.clearLane ?? 0) + (w.boxFree ?? 0) * (1 - pressure);
    if (oneOnOne) score += w.oneOnOne ?? 0;
  } else if (w.longRange !== undefined) {
    const raw = (n(getEffectiveAttribute(p, 'technique', state.k)) + n(getEffectiveAttribute(p, 'finishing', state.k))) / 2;
    const skill = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    score -= w.longRange * (1 - (w.longRangeSkill ?? 0) * (1 - pressure) * skill);
  }
  return { score, xg: est, cone, inBox, oneOnOne };
}

/**
 * The carrier's decision: scores the candidates and acts on the best (§9, §9a).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 */
export function decideCarrier(state, p) {
  const k = state.k.weights;
  const d = k.decision;
  const f = d.features;
  const team = p.team;
  const dir = state.attackDir(team);
  const gx = attackGoalX(state, team);
  const pressure = pressureAt(state, team, p.x, p.y, f.pressureDist);
  // The carrier reads the offside line with an error of up to +-offsideMisjudge
  // metres (less with good decisions): the source of real offsides.
  const misjudge = d.offsideMisjudge * (1 - 0.5 * n(getEffectiveAttribute(p, 'decisions', state.k)));
  const line = offsideLineOf(state, team) + (nextFloat(state.rng) * 2 - 1) * misjudge;

  let bestScore = -Infinity;
  let bestKind = 'HOLD';
  let bestTarget = -1;
  let bestPassKind = 'SHORT';
  let bestDx = 0;
  let bestDy = 0;

  // Passes: each team-mate.
  for (const i of state.onPitchList) {
    const r = state.players[i];
    if (r.team !== team || i === p.index) continue;
    const dist = Math.sqrt((r.x - p.x) * (r.x - p.x) + (r.y - p.y) * (r.y - p.y));
    if (dist < d.minPassDist || dist > d.maxPassDist) continue;
    const score = passScore(state, p, r, line) + noise(state, p);
    if (score > bestScore) {
      bestScore = score;
      bestKind = 'PASS';
      bestTarget = i;
      bestPassKind = passKind;
    }
  }

  if (p.isKeeper === 1) {
    // A goalkeeper only distributes.
    if (bestKind === 'PASS') {
      const dist = hyp(state.players[bestTarget].x - p.x, state.players[bestTarget].y - p.y);
      state.emit('GK_DISTRIBUTION', { teamIndex: team, actorIndex: p.index, x: p.x, y: p.y });
      launchPass(state, p, bestTarget, dist < k.keeper.throwMax ? 'GK_THROW' : 'GK_KICK');
    } else {
      state.emit('GK_DISTRIBUTION', { teamIndex: team, actorIndex: p.index, x: p.x, y: p.y });
      launchClearance(state, p);
    }
    return;
  }

  // Dribble: forward and 35 degrees to either side.
  const defVx = [dir * COS35, dir, dir * COS35];
  const defVy = [-SIN35, 0, SIN35];
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
    const score = d.w.dribble.space * Math.min(1, space / f.spaceDist) + d.w.dribble.skill * n(getEffectiveAttribute(p, 'dribbling', state.k)) + noise(state, p);
    if (score > bestScore) {
      bestScore = score;
      bestKind = 'DRIBBLE';
      bestDx = vx;
      bestDy = vy;
    }
  }

  // Shot.
  const shot = shotUtility(state, p, pressure);
  if (shot !== null) {
    const score = shot.score + noise(state, p);
    if (score > bestScore) {
      bestScore = score;
      bestKind = 'SHOT';
    }
  }

  // Cross, from a wide attacking zone when at least one team-mate is in the box
  // and (as the carrier reads the line) onside.
  if (WIDE_ZONES.includes(zoneOf(p.x, p.y, dir))) {
    let mates = 0;
    for (const i of state.onPitchList) {
      const q = state.players[i];
      if (q.team === team && i !== p.index && inAttackingBox(state, team, q.x, q.y) && !looksOffside(state, p, q, line)) mates++;
    }
    if (mates > 0) {
      const score = d.w.cross.wideZone + d.w.cross.boxMates * Math.min(1, mates / f.boxMatesDiv) + noise(state, p);
      if (score > bestScore) {
        bestScore = score;
        bestKind = 'CROSS';
      }
    }
  }

  // Clearance under pressure in the defensive third.
  const cl = k.clearance;
  const onTouchline = cl !== undefined && Math.min(p.y, PITCH_WIDTH - p.y) < cl.sideZone;
  const clearZone = onTouchline ? cl.zoneWide : d.clearanceZone;
  if (along(state, team, p.x) < clearZone && pressure > d.clearancePressure) {
    const score = d.clearanceScore + (cl === undefined ? 0 : cl.pressureGain * (pressure - d.clearancePressure) + (onTouchline ? cl.sideBonus : 0)) + noise(state, p);
    if (score > bestScore) {
      bestScore = score;
      bestKind = 'CLEARANCE';
    }
  }

  // Hold.
  const holdScore = d.w.hold.free * (1 - pressure) + state.teams[team].knobs.holdAdd + noise(state, p);
  if (holdScore > bestScore) {
    bestScore = holdScore;
    bestKind = 'HOLD';
  }

  switch (bestKind) {
    case 'PASS':
      launchPass(state, p, bestTarget, bestPassKind);
      break;
    case 'SHOT':
      launchShot(state, p);
      break;
    case 'CROSS': {
      let target = -1;
      let bestJump = -1;
      for (const i of state.onPitchList) {
        const q = state.players[i];
        if (q.team !== team || i === p.index || !inAttackingBox(state, team, q.x, q.y) || looksOffside(state, p, q, line)) continue;
        const j = getEffectiveAttribute(q, 'jumpingReach', state.k) + getEffectiveAttribute(q, 'finishing', state.k);
        if (j > bestJump) {
          bestJump = j;
          target = i;
        }
      }
      launchPass(state, p, target, 'CROSS', '', gx === 0 ? 11 : PITCH_LENGTH - 11, GOAL_Y);
      break;
    }
    case 'CLEARANCE':
      launchClearance(state, p);
      break;
    case 'DRIBBLE':
      startDribble(state, p, bestDx, bestDy);
      break;
    default:
      p.pendingAction = ACTION.HOLD;
  }
}

/**
 * Carries the ball along (dx, dy). A defender close ahead contests it:
 * `dribbleOutcome` decides, and losing hands the ball to the defender.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {number} dx unit direction
 * @param {number} dy
 */
function startDribble(state, p, dx, dy) {
  const k = state.k.weights;
  const step = k.decision.dribbleStep;
  p.pendingAction = ACTION.DRIBBLE;
  p.px = Math.min(PITCH_LENGTH - 0.5, Math.max(0.5, p.x + dx * step));
  p.py = Math.min(PITCH_WIDTH - 0.5, Math.max(0.5, p.y + dy * step));
  const d = nearestOpponent(state, p.team, p.x, p.y);
  if (d < 2.5) {
    const q = state.players[nearest.index];
    const ahead = (q.x - p.x) * dx + (q.y - p.y) * dy;
    if (ahead > 0) {
      dribbleOutcome(
        getEffectiveAttribute(p, 'dribbling', state.k), getEffectiveAttribute(p, 'agility', state.k), getEffectiveAttribute(p, 'flair', state.k),
        getEffectiveAttribute(q, 'tackling', state.k), getEffectiveAttribute(q, 'positioning', state.k), k, nextFloat(state.rng), beatOut,
        state.teams[q.team].knobs.dribbledLogit, // a tight man-marker is easier to turn (0 by default)
      );
      state.emit('DRIBBLE', { teamIndex: p.team, actorIndex: p.index, secondaryIndices: [q.index], x: p.x, y: p.y, meta: { won: beatOut.beat } });
      if (!beatOut.beat) {
        state.emit('POSSESSION_LOST', { teamIndex: p.team, actorIndex: p.index, x: p.x, y: p.y });
        p.pendingAction = ACTION.HOLD;
        giveBall(state, q.index, false);
      }
    }
  }
}

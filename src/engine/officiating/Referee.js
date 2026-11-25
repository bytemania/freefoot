/**
 * Officiating (design §9b, §10, item 44): plain functions that use the engine
 * RNG. Fouls come from `tackleOutcome`; the referee decides severity, cards,
 * penalties and advantage, judges offside, and keeps the added-time rule.
 */
import { sigmoid } from '../math/detmath.js';
import { DT } from '../TickConfig.js';
import { nextFloat } from '../rng/sfc32.js';
import { n } from '../resolve/passing.js';
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';
import { along } from '../decisions/Perception.js';
import { startRestart } from '../restarts/RestartMachine.js';
import { reduce, setFormation } from '../tactics/Formation.js';
import { raiseForced } from '../commands/Forced.js';
import { onRedCard } from '../morale/Morale.js';

const verdict = { foul: true, card: 0, penalty: false, advantage: false, severity: 0 };

/**
 * Probability that a foul is a yellow card (before the red check): the severity and aggression logit, plus for a
 * foul that is not a last-man one the match-minute escalation (lenient early, strict late) and a repeat-offender
 * term from the tackler's earlier fouls.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} tackler player index
 * @param {number} severity 0..1
 * @param {boolean} lastMan
 * @returns {number}
 */
export function cardProbability(state, tackler, severity, lastMan) {
  const o = state.k.officiating;
  const p = state.players[tackler];
  let logit = o.card.y0 + o.card.y1 * severity + o.card.y2 * n(getEffectiveAttribute(p, 'aggression', state.k));
  if (!lastMan) {
    // Match-clock minute (first-half stoppage reads as 45+, the second half starts at 45), capped at 95.
    const minute = ((state.clock.half - 1) * 2700 + state.clock.halfTick * DT) / 60; // as clockSeconds, inlined (MatchClock imports this file)
    logit += (o.card.yMinute * (Math.min(minute, 95) - 45)) / 45 + o.card.yRepeat * Math.min(p.fouls, o.card.repeatCap);
  }
  return sigmoid(logit);
}

/**
 * Judges a foul that `tackleOutcome` has flagged: severity, card, penalty and
 * advantage (§9b).
 *  - severity: +0.4 from behind, +0.3 above 6 m/s, +0.5 for the last attacker past the last defender, clamped to [0, 1]
 *  - pCard = sigmoid(y0 + y1 severity + y2 n(aggression)), plus for a non-last-man foul the minute escalation and
 *    the repeat-offender term (`cardProbability`); red when severity >= redMin and u < r0 + r1 severity, unscaled
 *  - the tackler's `fouls` count goes up after the card is judged
 *  - a foul by a defender in their own box is a penalty
 *  - advantage: no card, no penalty, mild severity, and the fouled player is free of other opponents
 * @param {{state: import('../state/MatchState.js').MatchState, tackler: number, fouled: number, fromBehind: boolean, tacklerSpeed: number, lastMan: boolean, inBox: boolean, otherOpponentDist: number}} ctx
 * @returns {{foul: boolean, card: number, penalty: boolean, advantage: boolean, severity: number}} a shared result object
 */
export function judgeContact(ctx) {
  const state = ctx.state;
  const o = state.k.officiating;
  let severity = 0;
  if (ctx.fromBehind) severity += o.severity.fromBehind;
  if (ctx.tacklerSpeed > o.severity.fastTackleSpeed) severity += o.severity.fastTackle;
  if (ctx.lastMan) severity += o.severity.lastMan;
  const taker = state.players[ctx.tackler];
  // Tackling instruction: a harder (or more careful) challenge reads as a more (or less) severe foul.
  const severityAdd = state.teams[taker.team].knobs.severityAdd;
  if (severityAdd !== 0) severity = severity + severityAdd < 0 ? 0 : severity + severityAdd;
  severity = severity > 1 ? 1 : severity;
  const pCard = cardProbability(state, ctx.tackler, severity, ctx.lastMan);
  taker.fouls++;
  let card = 0;
  if (severity >= o.severity.redMin && nextFloat(state.rng) < o.red.r0 + o.red.r1 * severity) card = 2;
  else if (nextFloat(state.rng) < pCard) card = 1;
  verdict.severity = severity;
  verdict.card = card;
  verdict.penalty = ctx.inBox;
  verdict.advantage = !ctx.inBox && card === 0 && severity < 0.5 && ctx.otherOpponentDist >= 2.5;
  return verdict;
}

/**
 * Offside geometry at the moment a forward pass is played, for the intended
 * receiver only: in the opponent half, strictly ahead of the ball and of the
 * second-last defender (level is onside, within `tolerance`). No offside from a
 * throw-in, goal kick, corner or kick-off.
 * @param {{receiverAlong: number, ballAlong: number, secondLastAlong: number, tolerance: number, restartKind: string}} ctx
 *   all positions in the passer's frame (metres toward the goal they attack)
 * @returns {boolean}
 */
export function judgeOffside(ctx) {
  if (ctx.restartKind === 'THROW_IN' || ctx.restartKind === 'GOAL_KICK' || ctx.restartKind === 'CORNER' || ctx.restartKind === 'KICK_OFF') return false;
  return (
    ctx.receiverAlong > 52.5 &&
    ctx.receiverAlong > ctx.ballAlong + ctx.tolerance &&
    ctx.receiverAlong > ctx.secondLastAlong + ctx.tolerance
  );
}

/**
 * Whole minutes of added time for the current half: the clock's accumulator rounded up.
 * @param {import('../state/MatchState.js').MatchState} state
 * @returns {number}
 */
export function computeAddedTime(state) {
  return Math.ceil(state.clock.addedSeconds / 60);
}

/**
 * Shows a card. A second yellow is a red. A red removes the player for good:
 * the team takes its reduced shape, and a sent-off goalkeeper raises a forced
 * decision (or a stand-in keeper) through `raiseForced`.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} playerIndex
 * @param {number} card 1 yellow, 2 red
 * @param {number} fouledIndex the fouled player, or -1
 */
export function showCard(state, playerIndex, card, fouledIndex) {
  const p = state.players[playerIndex];
  const x = p.x;
  const y = p.y;
  let red = card === 2;
  let secondYellow = false;
  if (card === 1) {
    state.emit('YELLOW_CARD', { teamIndex: p.team, actorIndex: playerIndex, secondaryIndices: fouledIndex >= 0 ? [fouledIndex] : [], x, y });
    if (p.card === 1) {
      red = true;
      secondYellow = true;
    }
    p.card = 1;
  }
  if (!red) return;
  p.card = 2;
  state.emit('RED_CARD', { teamIndex: p.team, actorIndex: playerIndex, x, y, meta: { secondYellow } });
  onRedCard(state, p.team);
  const wasKeeper = p.isKeeper === 1;
  p.onPitch = 0;
  p.slot = -1;
  p.isKeeper = 0;
  p.out = 1;
  if (state.ball.owner === playerIndex) state.ball.owner = -1;
  state.rebuildOnPitchList();
  const team = state.teams[p.team];
  if (wasKeeper) raiseForced(state, team, 2, playerIndex);
  else reduce(state, team);
}

/**
 * Starts playing an advantage after a foul.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} fouledIndex
 * @param {number} foulerIndex
 */
export function startAdvantage(state, fouledIndex, foulerIndex) {
  const fouled = state.players[fouledIndex];
  state.advantage = {
    team: fouled.team,
    startTick: state.tick,
    startAlong: along(state, fouled.team, state.ball.x),
    x: fouled.x,
    y: fouled.y,
    fouler: foulerIndex,
    fouled: fouledIndex,
  };
}

/**
 * Tick step 6 helper: follows an advantage. Play goes on while the fouled team
 * keeps the ball for `advSeconds` and gains at least `advMin` metres; otherwise
 * play is called back for the free kick.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function updateAdvantage(state) {
  const adv = state.advantage;
  if (adv === null) return;
  if (state.restart.state !== 'IN_PLAY') {
    state.advantage = null;
    return;
  }
  const b = state.ball;
  const holder = b.owner >= 0 ? state.players[b.owner].team : b.pass !== null ? state.players[b.pass.passer].team : -1;
  const a = state.k.officiating.advantage;
  const expired = state.tick - adv.startTick >= a.advSeconds * 20;
  const gain = along(state, adv.team, b.x) - adv.startAlong;
  if (holder !== adv.team || (expired && gain < a.advMin)) {
    state.advantage = null;
    callBackFoul(state, adv);
  } else if (expired) {
    state.advantage = null;
  }
}

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {NonNullable<import('../state/MatchState.js').MatchState['advantage']>} adv
 */
function callBackFoul(state, adv) {
  startRestart(state, 'FREE_KICK', adv.team, adv.x, adv.y, { direct: true });
}

/**
 * Reassigns slots after a stand-in keeper or a substitution changed who plays where.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 */
export function refreshShape(state, team) {
  setFormation(state, team, team.formationId);
}

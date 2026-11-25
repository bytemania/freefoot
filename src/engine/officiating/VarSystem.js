/**
 * Video Assistant Referee (docs/designs/var.md, config/var.yaml).
 *
 * Four incidents can be checked: a goal (a tight offside in the move, or a routine look at the build-up), a
 * penalty given on the field, a defender's box challenge that play went on after, and a yellow card for a
 * severe foul. A check is one RNG draw at the incident. The review then holds play: `VAR_CHECK` comes
 * `checkDelayTicks` after the incident and `VAR_DECISION` `reviewTicks` after that, when one more draw settles
 * the call. The ruling is applied (goal disallowed and the score reverted, penalty awarded or cancelled,
 * yellow upgraded to red), added time goes onto the half, and both squads and the key player take the outcome's
 * morale swing. On an overturn, `VAR_DECISION.secondaryIndices` lists the players who react: the side that
 * gained first (`meta.positive` of them), then the side that lost.
 *
 * Zero regression: `state.var` is null unless the match input has `var: true` and `config.var.enabled`; then
 * no hook runs, no number is drawn and nothing is serialized, so golden and calibration matches are untouched.
 */
import { nextFloat } from '../rng/sfc32.js';
import { shiftMorale, shiftPlayerMorale } from '../morale/Morale.js';
import { startFoulRestart, startRestart } from '../restarts/RestartMachine.js';
import { showCard } from './Referee.js';

/** Incidents VAR checks (VAR_CHECK / VAR_DECISION `meta.incident`). */
export const VAR_INCIDENTS = Object.freeze(['GOAL', 'PENALTY', 'POSSIBLE_PENALTY', 'RED_CARD']);

/** Decisions (VAR_DECISION `meta.outcome`; the keys of `config.var.morale`). */
export const VAR_OUTCOMES = Object.freeze([
  'goalConfirmed',
  'goalDisallowed',
  'penaltyConfirmed',
  'penaltyOverturned',
  'penaltyAwarded',
  'noPenalty',
  'redCardUpgraded',
  'yellowStands',
]);

/** The outcome when the call is overturned / stands, by incident. */
const OUTCOME_OF = Object.freeze({
  GOAL: { overturned: 'goalDisallowed', stands: 'goalConfirmed' },
  PENALTY: { overturned: 'penaltyOverturned', stands: 'penaltyConfirmed' },
  POSSIBLE_PENALTY: { overturned: 'penaltyAwarded', stands: 'noPenalty' },
  RED_CARD: { overturned: 'redCardUpgraded', stands: 'yellowStands' },
});

/** HUD label of each incident under review. */
const CHECK_LABEL = Object.freeze({ GOAL: 'checkGoal', PENALTY: 'checkPenalty', POSSIBLE_PENALTY: 'checkPossiblePenalty', RED_CARD: 'checkRedCard' });

/** UI strings every locale needs in its `var` group (the HUD banner). */
export const VAR_STRING_KEYS = Object.freeze([
  'check',
  'checkGoal',
  'checkPenalty',
  'checkPossiblePenalty',
  'checkRedCard',
  'checkComplete',
  'overturned',
  ...VAR_OUTCOMES,
]);

/**
 * @typedef {'GOAL' | 'PENALTY' | 'POSSIBLE_PENALTY' | 'RED_CARD'} VarIncident
 * @typedef {object} VarReview
 * @property {VarIncident} incident
 * @property {number} team the subject's team
 * @property {number} subject the scorer, the fouler or the booked player
 * @property {number} other the assister or the fouled player, or -1
 * @property {number} x where it happened
 * @property {number} y
 * @property {number} fx free kick spot if a goal is disallowed
 * @property {number} fy
 * @property {boolean} direct whether that free kick is direct (no: an offside)
 * @property {number} overturnP
 * @property {number} checkTick
 * @property {boolean} checked VAR_CHECK was emitted
 * @property {number} decideTick
 * @typedef {{team: number, margin: number, x: number, y: number, tick: number}} VarMove
 *   the tightest onside forward pass of the current move
 * @typedef {{review: VarReview | null, move: VarMove | null}} VarState
 */

/**
 * Whether VAR holds play (a check is pending or under way).
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function varHoldsPlay(state) {
  return state.var !== null && state.var.review !== null;
}

/**
 * Whether a VAR review is on screen (VAR_CHECK emitted, VAR_DECISION not yet).
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function varReviewing(state) {
  return state.var !== null && state.var.review !== null && state.var.review.checked;
}

/**
 * HUD strings for an event: the `var.*` keys of its headline and its line below, or null.
 * @param {{type: string, meta?: Record<string, any>}} event VAR_CHECK or VAR_DECISION
 * @returns {{headline: string, detail: string, tone: 'check' | 'overturned' | 'stands'} | null}
 */
export function varBanner(event) {
  const m = event.meta ?? {};
  if (event.type === 'VAR_CHECK') return { headline: 'check', detail: /** @type {Record<string, string>} */ (CHECK_LABEL)[m.incident] ?? 'check', tone: 'check' };
  if (event.type !== 'VAR_DECISION') return null;
  return m.overturned ? { headline: String(m.outcome), detail: 'overturned', tone: 'overturned' } : { headline: 'checkComplete', detail: String(m.outcome), tone: 'stands' };
}

/**
 * Starts a review unless one is already running.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {Omit<VarReview, 'checkTick' | 'checked' | 'decideTick'>} r
 */
function open(state, r) {
  const cfg = state.config.var;
  const checkTick = state.tick + cfg.checkDelayTicks;
  /** @type {VarState} */ (state.var).review = { ...r, checkTick, checked: false, decideTick: checkTick + cfg.reviewTicks };
}

/**
 * A forward pass to `receiver` that was judged onside (Actions.launchPass): records how tight it was when the
 * receiver is in the opponent's half, keeping the tightest pass of the team's current move.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team the passing team
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} receiver
 * @param {number} receiverAlong
 * @param {number} line the offside line the receiver had to stay behind (ball or second-last defender)
 */
export function varTrackPass(state, team, receiver, receiverAlong, line) {
  const vs = /** @type {VarState} */ (state.var);
  if (receiverAlong <= 52.5) return;
  const margin = line - receiverAlong;
  if (margin < 0) return;
  const m = vs.move;
  if (m !== null && m.team === team && state.tick - m.tick <= state.config.var.goalCheck.windowTicks && m.margin <= margin) return;
  vs.move = { team, margin, x: receiver.x, y: receiver.y, tick: state.tick };
}

/**
 * A goal was given (Actions.awardGoal): VAR may check it.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} scorer
 * @param {number} team the scoring team
 * @param {string} kind
 * @param {number} x
 * @param {number} y
 * @param {number} assister the assisting player, or -1
 */
export function varOnGoal(state, scorer, team, kind, x, y, assister) {
  const vs = /** @type {VarState} */ (state.var);
  const gc = state.config.var.goalCheck;
  const m = vs.move;
  vs.move = null;
  if (vs.review !== null || scorer < 0 || !gc.kinds.includes(kind)) return;
  const tight = m !== null && m.team === team && state.tick - m.tick <= gc.windowTicks && m.margin < gc.offsideMarginM;
  const c = tight ? gc.tight : gc.routine;
  if (nextFloat(state.rng) >= c.checkP) return;
  open(state, {
    incident: 'GOAL', team, subject: scorer, other: assister, x, y,
    fx: tight ? /** @type {VarMove} */ (m).x : x, fy: tight ? /** @type {VarMove} */ (m).y : y, direct: !tight, overturnP: c.overturnP,
  });
}

/**
 * A foul was judged and its card shown (contacts.foul): a penalty given, or a yellow for a severe foul, may be
 * checked. Called after the restart has started, so play is already dead.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} fouler
 * @param {number} fouled
 * @param {number} card the card the referee gave (0, 1 yellow, 2 red)
 * @param {number} severity
 * @param {boolean} penalty
 * @param {number} x
 * @param {number} y
 */
export function varOnFoul(state, fouler, fouled, card, severity, penalty, x, y) {
  const vs = /** @type {VarState} */ (state.var);
  if (vs.review !== null || state.restart.state !== 'DEAD_BALL') return;
  const cfg = state.config.var;
  const team = state.players[fouler].team;
  const base = { team, subject: fouler, other: fouled, x, y, fx: x, fy: y, direct: true };
  if (penalty) {
    const c = cfg.penaltyCheck.given;
    if (nextFloat(state.rng) < c.checkP) open(state, { ...base, incident: 'PENALTY', overturnP: c.overturnP });
    return;
  }
  // A plain yellow (a second yellow is already a red) for a foul at the severity threshold.
  const p = state.players[fouler];
  if (card !== 1 || p.card !== 1 || p.onPitch !== 1 || severity < cfg.redCardCheck.minSeverity) return;
  if (nextFloat(state.rng) < cfg.redCardCheck.checkP) open(state, { ...base, incident: 'RED_CARD', overturnP: cfg.redCardCheck.upgradeP });
}

/**
 * A defender's challenge in their own box was not given as a foul (contacts): VAR may stop play to look at it.
 * The ball goes dead at once (a drop ball for the defending side, unless a penalty is awarded).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} tackler
 * @param {number} carrier
 * @param {number} x
 * @param {number} y
 */
export function varOnBoxChallenge(state, tackler, carrier, x, y) {
  const vs = /** @type {VarState} */ (state.var);
  if (vs.review !== null || state.restart.state !== 'IN_PLAY') return;
  const c = state.config.var.penaltyCheck.missed;
  if (nextFloat(state.rng) >= c.checkP) return;
  const team = state.players[tackler].team;
  startRestart(state, 'DROP_BALL', team, x, y);
  open(state, { incident: 'POSSIBLE_PENALTY', team, subject: tackler, other: carrier, x, y, fx: x, fy: y, direct: true, overturnP: c.awardP });
}

/**
 * Tick step 6 (before the restart machine): emits VAR_CHECK when the check starts and settles the review when
 * it is over. Does nothing for a match without VAR or without a review.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function updateVar(state) {
  const r = state.var?.review ?? null;
  if (r === null) return;
  if (!r.checked) {
    if (state.tick < r.checkTick) return;
    r.checked = true;
    state.emit('VAR_CHECK', { teamIndex: r.team, actorIndex: r.subject, secondaryIndices: r.other >= 0 ? [r.other] : [], x: r.x, y: r.y, meta: { incident: r.incident } });
    return;
  }
  if (state.tick >= r.decideTick) decide(state, r);
}

/**
 * Settles a review: the call, the ruling, added time, morale and the reacting players.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {VarReview} r
 */
function decide(state, r) {
  const cfg = state.config.var;
  /** @type {VarState} */ (state.var).review = null;
  let overturned = nextFloat(state.rng) < r.overturnP;
  const span = cfg.addedSeconds.max - cfg.addedSeconds.min;
  const addedSeconds = cfg.addedSeconds.min + Math.floor(nextFloat(state.rng) * (span + 1));
  // The review time goes onto the half now (before the clock runs this tick, so a half that was held for the
  // review plays it): onto the accumulator, and onto the time still to play once added time is announced.
  state.clock.addedSeconds += addedSeconds;
  if (state.clock.announced) state.clock.addedTicks += addedSeconds * 20;
  const subject = state.players[r.subject];
  // A booked player who has already gone off cannot be sent off.
  if (r.incident === 'RED_CARD' && subject.onPitch !== 1) overturned = false;
  const outcome = OUTCOME_OF[r.incident][overturned ? 'overturned' : 'stands'];
  // Who the decision favours: a goal or penalty that stands, or a penalty VAR awards, favours the attack.
  const attack = r.incident === 'GOAL' ? r.team : 1 - r.team;
  const favoursAttack = r.incident === 'RED_CARD' ? overturned : r.incident === 'POSSIBLE_PENALTY' ? overturned : !overturned;
  const benefiting = r.incident === 'RED_CARD' ? (overturned ? 1 - r.team : r.team) : favoursAttack ? attack : 1 - attack;

  // The ruling that changes the match comes before the event (the score, the restart); the red card after it.
  if (overturned) applyRuling(state, r);
  const swing = cfg.morale[outcome];
  shiftMorale(state, benefiting, swing.benefiting);
  shiftMorale(state, 1 - benefiting, swing.penalized);
  shiftPlayerMorale(state, r.subject, swing.individual);

  /** @type {number[]} */
  const positive = [];
  /** @type {number[]} */
  const negative = [];
  if (overturned) {
    for (const i of state.onPitchList) (state.players[i].team === benefiting ? positive : negative).push(i);
  }
  state.emit('VAR_DECISION', {
    teamIndex: r.team,
    actorIndex: r.subject,
    secondaryIndices: [...positive, ...negative],
    x: r.x,
    y: r.y,
    meta: { incident: r.incident, outcome, overturned, addedSeconds, positive: positive.length, negative: negative.length, assist: r.incident === 'GOAL' ? r.other : -1 },
  });
  // Events that follow from the ruling come after the decision.
  if (overturned) followUp(state, r);
  // The call is seen before play goes on.
  const rs = state.restart;
  if (rs.state === 'DEAD_BALL' && rs.resumeTick < state.tick + cfg.resumeTicks) rs.resumeTick = state.tick + cfg.resumeTicks;
}

/**
 * The part of an overturn that changes the match before VAR_DECISION is emitted.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {VarReview} r
 */
function applyRuling(state, r) {
  switch (r.incident) {
    case 'GOAL':
      // No goal: the score goes back and the defending side restarts where the offence was.
      state.teams[r.team].score--;
      startRestart(state, 'FREE_KICK', 1 - r.team, r.fx, r.fy, { direct: r.direct });
      break;
    case 'PENALTY':
      // No penalty: a drop ball for the defending side (in the box, to their keeper).
      startRestart(state, 'DROP_BALL', r.team, r.x, r.y);
      break;
    default:
  }
}

/**
 * The part of an overturn whose own events follow VAR_DECISION (the penalty award, the red card).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {VarReview} r
 */
function followUp(state, r) {
  if (r.incident === 'POSSIBLE_PENALTY') {
    state.players[r.subject].fouls++;
    startFoulRestart(state, 1 - r.team, r.x, r.y, true, r.subject, r.other);
  } else if (r.incident === 'RED_CARD') {
    showCard(state, r.subject, 2, r.other);
  }
}

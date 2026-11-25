/**
 * Live match performance rating (0.0 - 10.0, 6.0 at kick-off), FM style.
 *
 * Every player carries `ratingPoints` (saved state): the signed sum of the
 * points their actions earned, from `weights.rating` (goals, assists, key
 * passes, shots on target, completed and failed passes, tackles,
 * interceptions, blocks, saves, goals conceded, errors and cards). The rating
 * maps the points onto 0-10 with diminishing returns, so it moves quickly
 * around 6 and only world-class matches approach 10:
 *
 *   points >= 0: 6 + 4 x points / (points + posScale)
 *   points <  0: 6 + 6 x points / (|points| + negScale)
 *
 * The rating never feeds back into play: it is a read-out, recorded at tick
 * step 9 from the tick's events.
 */

export const RATING_BASE = 6;
export const RATING_MAX = 10;

/** Built-in points, used when `weights.rating` is missing (old configs, fixtures). */
export const DEFAULT_RATING_WEIGHTS = Object.freeze({
  posScale: 3,
  negScale: 4,
  goal: 1.1,
  ownGoal: -1,
  assist: 0.7,
  keyPass: 0.25,
  shotOnTarget: 0.15,
  shotOffTarget: -0.04,
  bigChanceMissed: -0.3,
  passCompleted: 0.012,
  passFailed: -0.035,
  crossCompleted: 0.08,
  dribbleWon: 0.06,
  dribbledPast: -0.05,
  tackleWon: 0.12,
  tackleLost: -0.03,
  interception: 0.1,
  block: 0.12,
  clearance: 0.03,
  aerialWon: 0.04,
  save: 0.3,
  claim: 0.04,
  smother: 0.15,
  concededKeeper: -0.35,
  concededDefender: -0.15,
  possessionLost: -0.05,
  miscontrol: -0.06,
  foul: -0.05,
  penaltyConceded: -0.5,
  yellowCard: -0.4,
  redCard: -1.5,
});

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @returns {Record<string, number>}
 */
function weightsOf(state) {
  return /** @type {Record<string, number>} */ (state.k.weights.rating ?? DEFAULT_RATING_WEIGHTS);
}

/**
 * The 0-10 rating for a points total.
 * @param {number} points
 * @param {{posScale: number, negScale: number}} [rw]
 * @returns {number}
 */
export function ratingFromPoints(points, rw = DEFAULT_RATING_WEIGHTS) {
  if (points >= 0) return RATING_BASE + ((RATING_MAX - RATING_BASE) * points) / (points + rw.posScale);
  return RATING_BASE + (RATING_BASE * points) / (-points + rw.negScale);
}

/**
 * Adds points to a player and refreshes their rating.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} index
 * @param {number} pts
 */
function award(state, index, pts) {
  if (index < 0 || pts === 0) return;
  const p = state.players[index];
  p.ratingPoints += pts;
  const w = weightsOf(state);
  p.rating = ratingFromPoints(p.ratingPoints, { posScale: w.posScale, negScale: w.negScale });
}

/**
 * Records one tick's events into the players' ratings (tick step 9). A big
 * chance is missed when its shooter did not score on the same tick.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../events/MatchEvent.js').MatchEvent[]} events
 */
export function rateEvents(state, events) {
  const w = weightsOf(state);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const a = e.actorIndex;
    switch (e.type) {
      case 'GOAL': {
        const own = e.meta.kind === 'OWN_GOAL';
        award(state, a, own ? w.ownGoal : w.goal);
        concede(state, own ? e.teamIndex : 1 - e.teamIndex, w);
        break;
      }
      case 'ASSIST':
        award(state, a, w.assist);
        break;
      case 'KEY_PASS':
        award(state, a, w.keyPass);
        break;
      case 'SHOT':
        award(state, a, e.meta.result === 'ON_TARGET' || e.meta.result === 'WOODWORK' ? w.shotOnTarget : w.shotOffTarget);
        break;
      case 'BIG_CHANCE':
        if (!scoredThisTick(events, a)) award(state, a, w.bigChanceMissed);
        break;
      case 'PASS':
        award(state, a, e.meta.completed ? w.passCompleted : w.passFailed);
        break;
      case 'CROSS':
        if (e.meta.completed) award(state, a, w.crossCompleted);
        break;
      case 'DRIBBLE':
        if (e.meta.won) {
          award(state, a, w.dribbleWon);
          if (e.secondaryIndices.length > 0) award(state, e.secondaryIndices[0], w.dribbledPast);
        }
        break;
      case 'TACKLE':
        award(state, a, e.meta.won ? w.tackleWon : w.tackleLost);
        break;
      case 'INTERCEPTION':
        award(state, a, w.interception);
        break;
      case 'BLOCK':
        award(state, a, w.block);
        break;
      case 'CLEARANCE':
        award(state, a, w.clearance);
        break;
      case 'AERIAL_DUEL':
        if (e.meta.won) award(state, a, w.aerialWon);
        break;
      case 'SAVE':
        award(state, a, w.save);
        break;
      case 'CLAIM':
      case 'PUNCH':
        award(state, a, w.claim);
        break;
      case 'SMOTHER':
        award(state, a, w.smother);
        break;
      case 'POSSESSION_LOST':
        award(state, a, w.possessionLost);
        break;
      case 'MISCONTROL':
        award(state, a, w.miscontrol);
        break;
      case 'FOUL':
        award(state, a, w.foul);
        break;
      case 'PENALTY_AWARDED':
        award(state, a, w.penaltyConceded);
        break;
      case 'YELLOW_CARD':
        award(state, a, w.yellowCard);
        break;
      case 'RED_CARD':
        award(state, a, w.redCard);
        break;
      case 'VAR_DECISION':
        // A disallowed goal takes back the scorer's, the assister's and the conceding side's points; a penalty
        // VAR cancels takes back the fouler's (an awarded one and an upgrade come with their own events).
        if (e.meta.outcome === 'goalDisallowed') {
          award(state, a, -w.goal);
          if (typeof e.meta.assist === 'number') award(state, e.meta.assist, -w.assist);
          concede(state, 1 - e.teamIndex, w, -1);
        } else if (e.meta.outcome === 'penaltyOverturned') {
          award(state, a, -w.penaltyConceded);
        }
        break;
      default:
    }
  }
}

/**
 * @param {import('../events/MatchEvent.js').MatchEvent[]} events
 * @param {number} actor
 * @returns {boolean}
 */
function scoredThisTick(events, actor) {
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'GOAL' && events[i].actorIndex === actor && events[i].meta.kind !== 'OWN_GOAL') return true;
  }
  return false;
}

/**
 * A goal against: the keeper and the defenders on the pitch lose points.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} team the conceding team
 * @param {Record<string, number>} w
 * @param {number} [sign] -1 takes a conceded goal back (VAR disallowed it)
 */
function concede(state, team, w, sign = 1) {
  if (team !== 0 && team !== 1) return;
  for (let i = 0; i < state.onPitchList.length; i++) {
    const p = state.players[state.onPitchList[i]];
    if (p.team !== team) continue;
    if (p.isKeeper === 1) award(state, p.index, sign * w.concededKeeper);
    else if (p.cold.role === 'CB' || p.cold.role === 'FB') award(state, p.index, sign * w.concededDefender);
  }
}

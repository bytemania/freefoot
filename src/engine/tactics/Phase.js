/**
 * Team tactical phase (design: phase 2 audit, slice 14). One canonical label per team, refreshed every 5 ticks
 * before the anchors are computed, so formation shape and off-ball decisions read the same thing:
 *
 *  - with the ball: BUILD_UP (own third and a half), PROGRESSION (the middle), FINAL_THIRD (from `overlapAlong`),
 *    each by where the ball is in the team's own frame;
 *  - without it: DEFEND;
 *  - for `offBall.transitionTicks` after the ball changes hands: TRANSITION_ATT (won it) or TRANSITION_DEF (lost it).
 *
 * A loose ball or a pass in flight keeps the passer's side in possession; a dead ball leaves the phase alone.
 */
import { PHASE } from '../state/TeamState.js';
import { along } from '../decisions/Perception.js';

/** Own-frame x below which the team is still building up. */
const BUILD_UP_ALONG = 35;

/** Ticks between phase refreshes. */
export const PHASE_EVERY = 5;

/** @param {number} phase @returns {boolean} whether the phase is one of the team having the ball */
export function isAttackingPhase(phase) {
  return phase === PHASE.BUILD_UP || phase === PHASE.PROGRESSION || phase === PHASE.FINAL_THIRD || phase === PHASE.TRANSITION_ATT;
}

/**
 * The team in possession: the owner's, else the passer's, else -1.
 * @param {import('../state/MatchState.js').MatchState} state
 * @returns {number}
 */
function possessionTeam(state) {
  const b = state.ball;
  if (b.owner >= 0) return state.players[b.owner].team;
  if (b.pass !== null) return state.players[b.pass.passer].team;
  return -1;
}

/**
 * Refreshes both teams' phase (call every `PHASE_EVERY` ticks).
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function updatePhases(state) {
  const poss = possessionTeam(state);
  const ob = state.k.weights.offBall;
  const transition = ob?.transitionTicks ?? 40;
  const b = state.ball;
  for (let t = 0; t < 2; t++) {
    const team = state.teams[t];
    if (poss < 0) {
      team.phaseTick += PHASE_EVERY;
      continue;
    }
    const was = team.phase;
    let next;
    if (poss === t) {
      const a = along(state, t, b.x);
      const open = a < BUILD_UP_ALONG ? PHASE.BUILD_UP : a < (ob?.overlapAlong ?? 68) ? PHASE.PROGRESSION : PHASE.FINAL_THIRD;
      // Just won it: counter-attack for a spell, whatever the ball's depth.
      const justWon = was === PHASE.DEFEND || was === PHASE.TRANSITION_DEF || (was === PHASE.TRANSITION_ATT && team.phaseTick < transition);
      next = justWon ? PHASE.TRANSITION_ATT : open;
    } else {
      const justLost = isAttackingPhase(was) || (was === PHASE.TRANSITION_DEF && team.phaseTick < transition);
      next = justLost ? PHASE.TRANSITION_DEF : PHASE.DEFEND;
    }
    // A transition runs its course before it can end, and re-entering the same phase keeps its clock.
    if (next === was) {
      team.phaseTick += PHASE_EVERY;
      if ((was === PHASE.TRANSITION_ATT || was === PHASE.TRANSITION_DEF) && team.phaseTick >= transition) {
        team.phase = was === PHASE.TRANSITION_ATT ? (along(state, t, b.x) < BUILD_UP_ALONG ? PHASE.BUILD_UP : along(state, t, b.x) < (ob?.overlapAlong ?? 68) ? PHASE.PROGRESSION : PHASE.FINAL_THIRD) : PHASE.DEFEND;
        team.phaseTick = 0;
      }
    } else {
      team.phase = next;
      team.phaseTick = 0;
    }
  }
}

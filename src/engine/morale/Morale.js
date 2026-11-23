/**
 * Morale and psychological momentum.
 *
 * Every player carries a morale rating 0-100 (75 is neutral). It starts at the
 * player's own `morale`, else the team's, else `weights.morale.neutral`, and
 * moves during the match with the team's momentum shift: a goal for lifts it,
 * a goal against or a red card dents it, and the shift decays back toward 0.
 * How far a player's morale follows the shift is tempered by composure and
 * determination (the leadership proxy): steady players swing less.
 *
 * The engine never reads morale directly: `moraleLevel(p)` maps it onto a
 * signed level (0 at neutral, +1 at `highRef`, -1 at `lowRef`, clamped to
 * +-`maxLevel`), and the resolvers scale small, bounded coefficients by it:
 * pass completion, shot error, decision noise, tackles, interceptions and
 * pressing speed. Raw attributes are never changed, so morale cannot
 * overpower technical or physical quality.
 */
import { n } from '../resolve/passing.js';

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Starting morale for a player: player value, else team value, else neutral.
 * @param {{morale?: number}} coldPlayer
 * @param {{morale?: number}} coldTeam
 * @param {number} neutral
 * @returns {number}
 */
export function initialMorale(coldPlayer, coldTeam, neutral) {
  const v = coldPlayer.morale ?? coldTeam.morale ?? neutral;
  return clamp(v, 0, 100);
}

/**
 * Signed morale level: 0 at neutral, +1 at highRef, -1 at lowRef, linear in
 * between and clamped to +-maxLevel.
 * @param {number} morale 0-100
 * @param {any} mw `weights.morale` (unwrapped)
 * @returns {number}
 */
export function levelOf(morale, mw) {
  const d = morale - mw.neutral;
  const lv = d >= 0 ? d / (mw.highRef - mw.neutral) : d / (mw.neutral - mw.lowRef);
  return clamp(lv, -mw.maxLevel, mw.maxLevel);
}

/**
 * The player's current signed morale level (cached on the player).
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @returns {number}
 */
export function moraleLevel(p) {
  return p.moraleLevel;
}

/**
 * How strongly a player follows the team's momentum shift: 1 - temper x the
 * mean of n(composure) and n(determination), in about [1 - temper, 1 + 0.9 temper].
 * Uses base attributes (it is a trait, not a match condition).
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @param {any} mw
 * @returns {number}
 */
export function susceptibility(p, mw) {
  const a = /** @type {Record<string, number>} */ (p.cold.attributes);
  return 1 - (mw.temper * (n(a.composure) + n(a.determination))) / 2;
}

/**
 * Recomputes every player's morale and level from their base and the team shift.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 */
export function refreshTeamMorale(state, teamIndex) {
  const mw = state.k.weights.morale;
  const shift = state.teams[teamIndex].moraleShift;
  const base = teamIndex * 18;
  for (let i = base; i < base + 18; i++) {
    const p = state.players[i];
    p.morale = clamp(p.baseMorale + shift * susceptibility(p, mw), 0, 100);
    p.moraleLevel = levelOf(p.morale, mw);
  }
}

/**
 * Moves a team's momentum shift by `delta` morale points (bounded by maxShift).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 * @param {number} delta
 */
export function shiftMorale(state, teamIndex, delta) {
  const mw = state.k.weights.morale;
  const team = state.teams[teamIndex];
  team.moraleShift = clamp(team.moraleShift + delta, -mw.maxShift, mw.maxShift);
  refreshTeamMorale(state, teamIndex);
}

/**
 * A goal: the scoring team gains confidence, the conceding team loses some.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} scoringTeam
 */
export function onGoal(state, scoringTeam) {
  const ev = state.k.weights.morale.events;
  shiftMorale(state, scoringTeam, ev.goalFor);
  shiftMorale(state, 1 - scoringTeam, -ev.goalAgainst);
}

/**
 * A red card: the punished team is dented, the opponent lifted a little.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex team of the sent-off player
 */
export function onRedCard(state, teamIndex) {
  const ev = state.k.weights.morale.events;
  shiftMorale(state, teamIndex, -ev.redCardOwn);
  shiftMorale(state, 1 - teamIndex, ev.redCardOpponent);
}

/**
 * Once per match second: each team's shift decays toward 0 by `decay` (per second).
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function updateMorale(state) {
  if (state.tick % 20 !== 0) return;
  const decay = state.k.weights.morale.decay;
  for (let t = 0; t < 2; t++) {
    const team = state.teams[t];
    if (team.moraleShift === 0) continue;
    const next = team.moraleShift * (1 - decay);
    team.moraleShift = next > -0.01 && next < 0.01 ? 0 : next;
    refreshTeamMorale(state, t);
  }
}

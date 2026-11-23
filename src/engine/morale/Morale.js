/**
 * Morale and psychological momentum.
 *
 * Every player carries a morale rating 0-100 (75 is neutral). It starts at the
 * player's own `morale`, else the team's, else `weights.morale.neutral`, and
 * moves during the match with two shifts, both decaying back toward 0:
 *  - the team's momentum shift: a goal for lifts it, a goal against or a red
 *    card dents it;
 *  - the player's own `personalShift`, from their own actions (scoring,
 *    assisting, key passes, saves and tackles lift it; missing a big chance,
 *    conceding as a keeper or defender, a booking, an own goal, conceding a
 *    penalty and turnovers lower it), from `weights.morale.personal`.
 * How far a player's morale follows either shift is tempered by composure and
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

/** Built-in personal morale points, used when `weights.morale.personal` is missing. */
export const DEFAULT_PERSONAL_MORALE = Object.freeze({
  goal: 6,
  ownGoal: -6,
  assist: 4,
  keyPass: 0.8,
  shotOnTarget: 0.5,
  bigChanceMissed: -3,
  save: 1.5,
  concededKeeper: -3,
  concededDefender: -1.5,
  yellowCard: -2.5,
  penaltyConceded: -3,
  possessionLost: -0.4,
  miscontrol: -0.5,
  tackleWon: 0.4,
  interception: 0.3,
  maxShift: 20,
  decay: 0.002,
});

/**
 * @param {any} mw `weights.morale`
 * @returns {Record<string, number>}
 */
function personalOf(mw) {
  return mw.personal ?? DEFAULT_PERSONAL_MORALE;
}

/**
 * Recomputes one player's morale and level from their base, the team shift
 * and their personal shift.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 */
export function refreshPlayerMorale(state, p) {
  const mw = state.k.weights.morale;
  const shift = state.teams[p.team].moraleShift + p.personalShift;
  p.morale = clamp(p.baseMorale + shift * susceptibility(p, mw), 0, 100);
  p.moraleLevel = levelOf(p.morale, mw);
}

/**
 * Recomputes every player's morale and level from their base and the shifts.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 */
export function refreshTeamMorale(state, teamIndex) {
  const base = teamIndex * 18;
  for (let i = base; i < base + 18; i++) refreshPlayerMorale(state, state.players[i]);
}

/**
 * Moves one player's personal shift by `delta` morale points (bounded).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} index
 * @param {number} delta
 */
export function shiftPlayerMorale(state, index, delta) {
  if (index < 0 || delta === 0) return;
  const pm = personalOf(state.k.weights.morale);
  const p = state.players[index];
  p.personalShift = clamp(p.personalShift + delta, -pm.maxShift, pm.maxShift);
  refreshPlayerMorale(state, p);
}

/**
 * Tick step 9: each player's own actions this tick move their personal
 * morale. A big chance is missed when its shooter did not score on the same tick.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../events/MatchEvent.js').MatchEvent[]} events
 */
export function onPlayerEvents(state, events) {
  const pm = personalOf(state.k.weights.morale);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const a = e.actorIndex;
    switch (e.type) {
      case 'GOAL': {
        const own = e.meta.kind === 'OWN_GOAL';
        shiftPlayerMorale(state, a, own ? pm.ownGoal : pm.goal);
        const conceding = own ? e.teamIndex : 1 - e.teamIndex;
        if (conceding !== 0 && conceding !== 1) break;
        for (let j = 0; j < state.onPitchList.length; j++) {
          const q = state.players[state.onPitchList[j]];
          if (q.team !== conceding) continue;
          if (q.isKeeper === 1) shiftPlayerMorale(state, q.index, pm.concededKeeper);
          else if (q.cold.role === 'CB' || q.cold.role === 'FB') shiftPlayerMorale(state, q.index, pm.concededDefender);
        }
        break;
      }
      case 'ASSIST':
        shiftPlayerMorale(state, a, pm.assist);
        break;
      case 'KEY_PASS':
        shiftPlayerMorale(state, a, pm.keyPass);
        break;
      case 'SHOT':
        if (e.meta.result === 'ON_TARGET' || e.meta.result === 'WOODWORK') shiftPlayerMorale(state, a, pm.shotOnTarget);
        break;
      case 'BIG_CHANCE': {
        let scored = false;
        for (let j = 0; j < events.length; j++) {
          if (events[j].type === 'GOAL' && events[j].actorIndex === a && events[j].meta.kind !== 'OWN_GOAL') scored = true;
        }
        if (!scored) shiftPlayerMorale(state, a, pm.bigChanceMissed);
        break;
      }
      case 'SAVE':
        shiftPlayerMorale(state, a, pm.save);
        break;
      case 'YELLOW_CARD':
        shiftPlayerMorale(state, a, pm.yellowCard);
        break;
      case 'PENALTY_AWARDED':
        shiftPlayerMorale(state, a, pm.penaltyConceded);
        break;
      case 'POSSESSION_LOST':
        shiftPlayerMorale(state, a, pm.possessionLost);
        break;
      case 'MISCONTROL':
        shiftPlayerMorale(state, a, pm.miscontrol);
        break;
      case 'TACKLE':
        if (e.meta.won) shiftPlayerMorale(state, a, pm.tackleWon);
        break;
      case 'INTERCEPTION':
        shiftPlayerMorale(state, a, pm.interception);
        break;
      default:
    }
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
 * Once per match second: each team's shift decays toward 0 by `decay`, and
 * each player's personal shift by `personal.decay` (both per second).
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function updateMorale(state) {
  if (state.tick % 20 !== 0) return;
  const mw = state.k.weights.morale;
  const decay = mw.decay;
  for (let t = 0; t < 2; t++) {
    const team = state.teams[t];
    if (team.moraleShift === 0) continue;
    const next = team.moraleShift * (1 - decay);
    team.moraleShift = next > -0.01 && next < 0.01 ? 0 : next;
    refreshTeamMorale(state, t);
  }
  const pDecay = personalOf(mw).decay;
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p.personalShift === 0) continue;
    const next = p.personalShift * (1 - pDecay);
    p.personalShift = next > -0.01 && next < 0.01 ? 0 : next;
    refreshPlayerMorale(state, p);
  }
}

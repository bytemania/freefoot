/**
 * Forced decisions (design §11, §12): a HIGH injury or a goalkeeper sent off.
 * A decision is raised only when the team can act on it: it has a substitution
 * left and a suitable bench player. Otherwise the player simply leaves and the
 * team takes its reduced shape, and a sent-off goalkeeper is replaced in goal by
 * the outfield player with the highest Reflexes + Positioning.
 */
import { PLAYERS_PER_TEAM } from '../state/MatchState.js';
import { reduce } from '../tactics/Formation.js';
import { resolveForced as aiResolveForced } from '../ai/AiCoach.js';

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 * @returns {number} substitutions the team can still make (5 minus used and pending)
 */
export function substitutionsLeft(state, team) {
  let pending = 0;
  for (const s of state.pendingSubs) if (s.teamIndex === team.index) pending++;
  return 5 - team.subsUsed - pending;
}

/**
 * Whether a substitution asked for now would fall in a new stoppage window the team no longer has:
 * the Laws allow three in-play windows (half-time is free). Forced replacements are not refused.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 * @returns {boolean}
 */
export function substitutionWindowsExhausted(state, team) {
  if (state.restart.state === 'HALF_TIME' || team.inSubWindow) return false;
  if (state.pendingSubs.some((s) => s.teamIndex === team.index)) return false;
  return team.subWindows >= state.config.aiCoach.substitutionPlan.maxWindows;
}

/**
 * Bench players who can still come on: not on the pitch, never played and left,
 * not sent off.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 * @returns {number[]}
 */
export function benchOf(state, teamIndex) {
  /** @type {number[]} */
  const out = [];
  const base = teamIndex * PLAYERS_PER_TEAM;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const p = state.players[i];
    if (p.onPitch === 0 && p.out === 0 && p.card !== 2) out.push(i);
  }
  return out;
}

/**
 * Takes a player off for good (an injured player with no replacement).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} playerIndex
 */
export function leavePitch(state, playerIndex) {
  const p = state.players[playerIndex];
  p.onPitch = 0;
  p.slot = -1;
  p.out = 1;
  p.isKeeper = 0;
  if (state.ball.owner === playerIndex) state.ball.owner = -1;
  state.rebuildOnPitchList();
}

/**
 * Puts the on-pitch outfield player with the highest Reflexes + Positioning in
 * goal (ties go to the lower index).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 */
export function standInKeeper(state, team) {
  let best = -1;
  let bestScore = -1;
  const base = team.index * PLAYERS_PER_TEAM;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const p = state.players[i];
    if (p.onPitch !== 1 || p.isKeeper === 1) continue;
    const a = /** @type {Record<string, number>} */ (p.cold.attributes);
    const score = a.reflexes + a.positioning;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best >= 0) state.players[best].isKeeper = 1;
}

/**
 * Raises a forced decision for a team, or applies the automatic outcome when
 * there is nothing to decide. For an AI team the coach resolves it at once.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 * @param {1 | 2} kind 1 HIGH injury, 2 goalkeeper sent off
 * @param {number} playerIndex the injured or sent-off player
 */
export function raiseForced(state, team, kind, playerIndex) {
  const bench = benchOf(state, team.index);
  // A HIGH injury needs a free substitution window too; a sent-off keeper is always replaced when a keeper is on the bench.
  const canAct = substitutionsLeft(state, team) > 0 && (kind === 2 || !substitutionWindowsExhausted(state, team)) && (kind === 1 ? bench.length > 0 : bench.some((i) => state.players[i].cold.role === 'GK'));
  if (!canAct) {
    if (kind === 1) leavePitch(state, playerIndex);
    else standInKeeper(state, team);
    reduce(state, team);
    return;
  }
  team.forcedDecision = true;
  team.forcedKind = kind;
  team.forcedPlayer = playerIndex;
  state.awaitingDecision = true;
  state.emit('FORCED_DECISION_REQUIRED', {
    teamIndex: team.index,
    actorIndex: playerIndex,
    meta: { reason: kind === 1 ? 'HIGH_INJURY' : 'GK_SENT_OFF' },
  });
  if (team.controlledBy === 'ai') aiResolveForced(state, team);
}

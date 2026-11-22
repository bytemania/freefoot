/**
 * AI coach (design §12, item 49). For a team with `controlledBy: 'ai'` it
 * reads exact state every `evalIntervalTicks` ticks and issues commands through
 * `applyCommand` with `issuer: 'ai'`, so the same limits apply and the commands
 * go in the log. Forced decisions are resolved at once, outside the interval.
 */
import { PLAYERS_PER_TEAM } from '../state/MatchState.js';
import { roleRating } from '../state/PlayerMatchState.js';
import { clockSeconds } from '../clock/MatchClock.js';
import { applyCommand } from '../commands/Commands.js';
import { benchOf, substitutionsLeft } from '../commands/Forced.js';

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 * @param {number} slotRole role the replacement should fill
 * @param {number[]} exclude bench players already chosen
 * @param {boolean} keeperOnly
 * @returns {number} the bench player with the best role rating, or -1
 */
function bestBench(state, team, slotRole, exclude, keeperOnly) {
  let best = -1;
  let bestRating = -Infinity;
  for (const i of benchOf(state, team.index)) {
    if (exclude.includes(i)) continue;
    const isGk = state.players[i].cold.role === 'GK';
    if (keeperOnly !== isGk) continue;
    const r = roleRating(state.players[i], state.config.roles, /** @type {any} */ (slotRole));
    if (r > bestRating) {
      bestRating = r;
      best = i;
    }
  }
  return best;
}

/**
 * Role of the formation slot a player fills (their own role when they have none).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/PlayerMatchState.js').PlayerMatchState} p
 * @returns {string}
 */
function slotRoleOf(state, p) {
  const slots = state.config.tactics.formations[state.teams[p.team].formationId].slots;
  return p.slot >= 0 && p.slot < slots.length ? slots[p.slot].role : p.cold.role;
}

/**
 * The AI's periodic evaluation (called when `tick % evalIntervalTicks === 0`).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 */
export function evaluate(state, team) {
  if (team.forcedDecision) return;
  const rules = state.config.aiCoach;
  const minute = clockSeconds(state) / 60;
  const opponent = state.teams[1 - team.index];

  // Tired or hurt players come off, after the earliest minute.
  if (minute >= rules.tiredSubstitution.earliestMinute && substitutionsLeft(state, team) > 0) {
    const levels = rules.tiredSubstitution.injuryLevels.map((/** @type {string} */ l) => ['NONE', 'LIGHT', 'MEDIUM', 'HIGH'].indexOf(l));
    let issued = 0;
    /** @type {number[]} */
    const chosen = [];
    const base = team.index * PLAYERS_PER_TEAM;
    for (let i = base; i < base + PLAYERS_PER_TEAM && issued < rules.maxSubstitutionsPerCheck; i++) {
      const p = state.players[i];
      if (p.onPitch !== 1 || state.pendingSubs.some((s) => s.outIndex === i)) continue;
      if (p.fitness >= rules.tiredSubstitution.fitnessThreshold && !levels.includes(p.injury)) continue;
      const incoming = bestBench(state, team, /** @type {any} */ (slotRoleOf(state, p)), chosen, p.isKeeper === 1);
      if (incoming < 0) continue;
      if (applyCommand(state, { issuer: 'ai', type: 'SUBSTITUTE', teamIndex: team.index, payload: { outIndex: i, inIndex: incoming } }, state.commandLog).ok) {
        chosen.push(incoming);
        issued++;
        if (substitutionsLeft(state, team) <= 0) break;
      }
    }
  }

  // Losing late: switch formation once.
  if (minute >= rules.losingLate.minute && team.score < opponent.score && !team.aiFired.includes('LOSING_LATE')) {
    team.aiFired.push('LOSING_LATE');
    if (team.formationId !== rules.losingLate.formationId) {
      applyCommand(state, { issuer: 'ai', type: 'SET_FORMATION', teamIndex: team.index, payload: { formationId: rules.losingLate.formationId } }, state.commandLog);
    }
  }

  // After a red card: switch formation once per card.
  const base = team.index * PLAYERS_PER_TEAM;
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const tag = `RED:${i}`;
    if (state.players[i].card === 2 && !team.aiFired.includes(tag)) {
      team.aiFired.push(tag);
      if (team.formationId !== rules.redCard.formationId) {
        applyCommand(state, { issuer: 'ai', type: 'SET_FORMATION', teamIndex: team.index, payload: { formationId: rules.redCard.formationId } }, state.commandLog);
      }
    }
  }
}

/**
 * Resolves a forced decision for an AI team on the same tick: the best bench
 * replacement by role rating, or play on short-handed when there is none.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 */
export function resolveForced(state, team) {
  const player = state.players[team.forcedPlayer];
  if (team.forcedKind === 2) {
    const keeper = bestBench(state, team, /** @type {any} */ ('GK'), [], true);
    /** @type {{inIndex: number | null, outIndex: number | null}} */
    const payload = { inIndex: null, outIndex: null };
    if (keeper >= 0) {
      // The outfield player of least value makes way.
      let worst = -1;
      let worstRating = Infinity;
      const base = team.index * PLAYERS_PER_TEAM;
      for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
        const p = state.players[i];
        if (p.onPitch !== 1) continue;
        const r = roleRating(p, state.config.roles);
        if (r < worstRating) {
          worstRating = r;
          worst = i;
        }
      }
      payload.inIndex = keeper;
      payload.outIndex = worst;
    }
    applyCommand(state, { issuer: 'ai', type: 'RESOLVE_FORCED', teamIndex: team.index, payload }, state.commandLog);
    return;
  }
  const incoming = bestBench(state, team, /** @type {any} */ (slotRoleOf(state, player)), [], false);
  applyCommand(state, { issuer: 'ai', type: 'RESOLVE_FORCED', teamIndex: team.index, payload: { inIndex: incoming >= 0 ? incoming : null, outIndex: null } }, state.commandLog);
}

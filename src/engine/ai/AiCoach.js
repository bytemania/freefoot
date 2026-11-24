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
 * Stateless deterministic value in [0, 1) from the match seed, the team and a salt: the AI's
 * substitution plan needs no stored state beyond the `SUBWIN:n` tags in `aiFired`.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} teamIndex
 * @param {number} salt
 * @returns {number}
 */
function planNoise(state, teamIndex, salt) {
  let h = (state.seed ^ Math.imul(teamIndex + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * How many substitutions the team plans to use: 3, 4 or 5.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 * @returns {number}
 */
export function plannedSubstitutions(state, team) {
  const plan = state.config.aiCoach.substitutionPlan;
  const u = planNoise(state, team.index, 0);
  const n = u < plan.plannedThree ? 3 : u < plan.plannedThree + plan.plannedFour ? 4 : 5;
  return Math.min(n, plan.maxSubstitutions);
}

/**
 * Substitutions, in three parts: injured players come off at any time; a sent-off outfield
 * player is answered at once by swapping an attacker for a defender; and the planned
 * substitutions go in up to three in-play windows late in the match, earlier when behind and
 * later when ahead. Tired players, yellow cards and the score decide who comes off.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../state/TeamState.js').TeamState} team
 * @param {number} minute
 * @param {any} rules
 */
function planSubstitutions(state, team, minute, rules) {
  const plan = rules.substitutionPlan;
  const opponent = state.teams[1 - team.index];
  const base = team.index * PLAYERS_PER_TEAM;
  const issue = (/** @type {number} */ out, /** @type {number} */ incoming) =>
    applyCommand(state, { issuer: 'ai', type: 'SUBSTITUTE', teamIndex: team.index, payload: { outIndex: out, inIndex: incoming } }, state.commandLog).ok;
  const pendingOut = (/** @type {number} */ i) => state.pendingSubs.some((p) => p.outIndex === i);

  // 1. Injuries: at any minute.
  if (substitutionsLeft(state, team) > 0) {
    const levels = rules.tiredSubstitution.injuryLevels.map((/** @type {string} */ l) => ['NONE', 'LIGHT', 'MEDIUM', 'HIGH'].indexOf(l));
    let issued = 0;
    /** @type {number[]} */
    const chosen = [];
    for (let i = base; i < base + PLAYERS_PER_TEAM && issued < rules.maxSubstitutionsPerCheck; i++) {
      const p = state.players[i];
      if (p.onPitch !== 1 || pendingOut(i) || !levels.includes(p.injury)) continue;
      const incoming = bestBench(state, team, /** @type {any} */ (slotRoleOf(state, p)), chosen, p.isKeeper === 1);
      if (incoming >= 0 && issue(i, incoming)) {
        chosen.push(incoming);
        issued++;
        if (substitutionsLeft(state, team) <= 0) return;
      }
    }
  }

  // 2. A sent-off outfield player: an attacker makes way for a defender, once per card.
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const p = state.players[i];
    const tag = `REDSUB:${i}`;
    if (p.card !== 2 || p.isKeeper === 1 || team.aiFired.includes(tag)) continue;
    team.aiFired.push(tag);
    if (substitutionsLeft(state, team) <= 0) continue;
    let out = -1;
    let outFitness = Infinity;
    for (let j = base; j < base + PLAYERS_PER_TEAM; j++) {
      const q = state.players[j];
      if (q.onPitch !== 1 || q.isKeeper === 1 || pendingOut(j)) continue;
      const role = slotRoleOf(state, q);
      if ((role === 'ST' || role === 'W') && q.fitness < outFitness) {
        outFitness = q.fitness;
        out = j;
      }
    }
    const incoming = out >= 0 ? bestBench(state, team, /** @type {any} */ ('CB'), [], false) : -1;
    if (incoming >= 0) issue(out, incoming);
  }

  // 3. The plan: late windows, never earlier than earliestMinute.
  if (minute < plan.earliestMinute || substitutionsLeft(state, team) <= 0) return;
  const planned = plannedSubstitutions(state, team);
  const windows = planned >= 5 ? plan.threeWindowMinutes : plan.twoWindowMinutes;
  const fired = team.aiFired.filter((/** @type {string} */ t) => t.startsWith('SUBWIN:')).length;
  if (fired >= windows.length || team.subWindows >= plan.maxWindows) return;
  const diff = team.score - opponent.score;
  const shift = diff < 0 ? plan.chasingShiftMinutes : diff > 0 ? plan.leadingShiftMinutes : 0;
  const jitter = (planNoise(state, team.index, 1 + fired) * 2 - 1) * plan.jitterMinutes;
  const at = Math.min(plan.latestMinute, Math.max(plan.earliestMinute, windows[fired] + jitter + shift));
  if (minute < at) return;
  team.aiFired.push(`SUBWIN:${fired}`);
  const remaining = planned - team.subsUsed - state.pendingSubs.filter((p) => p.teamIndex === team.index).length;
  const count = Math.min(substitutionsLeft(state, team), Math.max(1, Math.floor(remaining / (windows.length - fired))));
  if (remaining <= 0) return;

  /** @type {Array<{i: number, score: number}>} */
  const candidates = [];
  for (let i = base; i < base + PLAYERS_PER_TEAM; i++) {
    const p = state.players[i];
    if (p.onPitch !== 1 || p.isKeeper === 1 || pendingOut(i)) continue;
    const role = slotRoleOf(state, p);
    let score = 1 - p.fitness + (p.injury > 0 ? plan.injuryScore : 0);
    if (p.fitness < rules.tiredSubstitution.fitnessThreshold) score += plan.exhaustedScore;
    if (p.card === 1) score += plan.yellowCardScore; // booked: a second yellow is a risk
    if (diff < 0 && (role === 'CB' || role === 'FB' || role === 'MF')) score += plan.roleScore; // chasing: fresh attackers for tired defenders and midfielders
    if (diff > 0 && (role === 'ST' || role === 'W')) score += plan.roleScore; // protecting: defensive legs for the forwards
    candidates.push({ i, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.i - b.i);
  /** @type {number[]} */
  const chosen = [];
  let made = 0;
  for (const c of candidates) {
    if (made >= count) break;
    const incoming = bestBench(state, team, /** @type {any} */ (slotRoleOf(state, state.players[c.i])), chosen, false);
    if (incoming >= 0 && issue(c.i, incoming)) {
      chosen.push(incoming);
      made++;
    }
  }
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

  planSubstitutions(state, team, minute, rules);

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

/**
 * Pure Post-Match Report projection (docs/designs/matchday_loop_phase1.md).
 * Consumes only `{ input, result, config }` (never mutable `MatchState`) and produces a serializable
 * `MatchReport` contract with VAR-reconciled scorers & timeline, MOTM, player ratings, and
 * continuous tactical familiarity progression.
 */
import { deriveEffectiveFamiliarity } from '../../engine/tactics/Familiarity.js';
import { matchMinuteLabel } from '../../shared/matchMinute.js';

const KEY_EVENT_TYPES = new Set(['GOAL', 'YELLOW_CARD', 'RED_CARD', 'VAR_DECISION', 'SUBSTITUTION', 'FORMATION_CHANGE']);

/**
 * @typedef {object} ScorerEntry
 * @property {number} actorIndex
 * @property {string} name
 * @property {string} shortName
 * @property {string} minute
 * @property {boolean} ownGoal
 * @property {boolean} penalty
 *
 * @typedef {object} KeyEventEntry
 * @property {number} seq
 * @property {number} tick
 * @property {string} minute
 * @property {string} type
 * @property {number} teamIndex
 * @property {number} actorIndex
 * @property {string} actorName
 * @property {string} secondaryName
 * @property {Record<string, any>} meta
 * @property {boolean} overturned
 * @property {boolean} upgradedToRed
 *
 * @typedef {object} ReportPlayerEntry
 * @property {number} index
 * @property {string} id
 * @property {number} teamIndex
 * @property {number} number
 * @property {string} name
 * @property {string} shortName
 * @property {string} role
 * @property {number} minutes
 * @property {number} distanceKm
 * @property {number} fitness
 * @property {number} card
 * @property {number} injury
 * @property {number} goals
 * @property {number} assists
 * @property {number} rating
 *
 * @typedef {object} PlanProgressionEntry
 * @property {'A' | 'B'} plan
 * @property {string} tacticId
 * @property {string} formationId
 * @property {number} minutes
 * @property {number} formBefore
 * @property {number} formAfter
 * @property {number} instrBefore
 * @property {number} instrAfter
 * @property {number} effectiveBefore
 * @property {number} effectiveAfter
 * @property {boolean} fluidUnlocked
 *
 * @typedef {object} MatchReport
 * @property {1} v
 * @property {number} seed
 * @property {{home: string, away: string}} teamNames
 * @property {{home: number, away: number}} score
 * @property {{home: ScorerEntry[], away: ScorerEntry[]}} scorers
 * @property {ReportPlayerEntry | null} motm
 * @property {KeyEventEntry[]} keyEvents
 * @property {Record<string, any>} stats
 * @property {ReportPlayerEntry[]} players
 * @property {{plans: PlanProgressionEntry[], deltas: import('./TacticalFamiliarityStore.js').FamiliarityDeltas} | null} familiarity
 */

/** @param {number} v */
const clamp100 = (v) => (v < 0 ? 0 : v > 100 ? 100 : v);

/**
 * Formats an event's broadcast minute using `htTick` and `htSeq` from the `HALF_TIME` event.
 * @param {any} ev
 * @param {number} htTick
 * @param {number} htSeq
 * @returns {string}
 */
function formatEventMinute(ev, htTick, htSeq) {
  if (ev.tick === htTick && ev.seq > htSeq) return 'HT';
  if (ev.seq < htSeq && ev.tick <= htTick) {
    return matchMinuteLabel(ev.tick / 20, 1);
  }
  return matchMinuteLabel(2700 + (ev.tick - htTick) / 20, 2);
}

/**
 * Computes continuous familiarity progression for the human team's Plan A & Plan B.
 * @param {import('../../engine/contracts/MatchInput.js').TeamTacticalPlans} plans
 * @param {import('../../engine/contracts/MatchResult.js').TeamPlanUsage} usage
 * @param {Record<string, any> | undefined} instrCfg
 * @returns {{plans: PlanProgressionEntry[], deltas: import('./TacticalFamiliarityStore.js').FamiliarityDeltas}}
 */
function computeFamiliarityProgression(plans, usage, instrCfg) {
  const slotA = plans.planA;
  const slotB = plans.planB;
  const minA = usage.A.minutes;
  const modA = usage.A.modifiedMinutes;
  const minB = usage.B.minutes;
  const modB = usage.B.modifiedMinutes;
  const sharedFormation = slotA.formationId === slotB.formationId;

  /** @param {number} minutes @param {number} modifiedMinutes @param {number} currentVal */
  const instrDeltaFor = (minutes, modifiedMinutes, currentVal) => {
    if (minutes >= 10) {
      const effMin = Math.max(0, minutes - modifiedMinutes) + 0.5 * modifiedMinutes;
      return Math.max(1, Math.round(4 * Math.min(1, effMin / 90)));
    }
    return currentVal < 80 ? 1 : 0;
  };

  /** @param {number} minutes @param {number} currentVal */
  const formDeltaFor = (minutes, currentVal) => {
    if (minutes >= 10) return Math.max(1, Math.round(4 * Math.min(1, minutes / 90)));
    return currentVal < 80 ? 1 : 0;
  };

  const instrDeltaA = instrDeltaFor(minA, modA, slotA.instrFam);
  const instrDeltaB = instrDeltaFor(minB, modB, slotB.instrFam);

  /** @type {Record<string, number>} */
  const formDeltas = {};
  if (sharedFormation) {
    const combinedMin = minA + minB;
    formDeltas[slotA.formationId] = formDeltaFor(combinedMin, slotA.formFam);
  } else {
    formDeltas[slotA.formationId] = formDeltaFor(minA, slotA.formFam);
    formDeltas[slotB.formationId] = formDeltaFor(minB, slotB.formFam);
  }

  /** @type {Record<string, number>} */
  const tacticDeltas = {
    [slotA.tacticId]: instrDeltaA,
    [slotB.tacticId]: instrDeltaB,
  };

  /** @param {'A' | 'B'} planKey @param {import('../../engine/contracts/MatchInput.js').TacticalPlanSlot} slot @param {number} minutes */
  const buildEntry = (planKey, slot, minutes) => {
    const formBefore = slot.formFam;
    const instrBefore = slot.instrFam;
    const formAfter = clamp100(formBefore + (formDeltas[slot.formationId] ?? 0));
    const instrAfter = clamp100(instrBefore + (tacticDeltas[slot.tacticId] ?? 0));
    const beforeEff = deriveEffectiveFamiliarity(instrCfg, { formFam: formBefore, instrFam: instrBefore, instructions: slot.instructions }, slot.instructions).effective;
    const afterEff = deriveEffectiveFamiliarity(instrCfg, { formFam: formAfter, instrFam: instrAfter, instructions: slot.instructions }, slot.instructions).effective;
    return {
      plan: planKey,
      tacticId: slot.tacticId,
      formationId: slot.formationId,
      minutes,
      formBefore,
      formAfter,
      instrBefore,
      instrAfter,
      effectiveBefore: beforeEff,
      effectiveAfter: afterEff,
      fluidUnlocked: beforeEff < 80 && afterEff >= 80,
    };
  };

  return {
    plans: [buildEntry('A', slotA, minA), buildEntry('B', slotB, minB)],
    deltas: { formations: formDeltas, tactics: tacticDeltas },
  };
}

/**
 * Projects a completed match's `MatchResult` + `MatchInput` into an immutable `MatchReport`.
 * @param {{input: import('../../engine/contracts/MatchInput.js').MatchInput, result: import('../../engine/contracts/MatchResult.js').MatchResult, config: any}} opts
 * @returns {MatchReport}
 */
export function buildMatchReport({ input, result, config }) {
  const inputPlayers = [...input.home.players, ...input.away.players];
  /** @type {ReportPlayerEntry[]} */
  const players = result.players.map((rp) => {
    const meta = inputPlayers[rp.index];
    return {
      index: rp.index,
      id: rp.id,
      teamIndex: rp.index < 18 ? 0 : 1,
      number: meta?.number ?? 0,
      name: meta?.name ?? rp.id,
      shortName: meta?.shortName || meta?.name || rp.id,
      role: meta?.role ?? 'MF',
      minutes: rp.minutes,
      distanceKm: rp.distanceKm,
      fitness: rp.fitness,
      card: rp.card,
      injury: rp.injury,
      goals: rp.goals,
      assists: rp.assists,
      rating: rp.rating,
    };
  });

  const played = players.filter((p) => p.minutes > 0);
  played.sort(
    (a, b) =>
      b.rating - a.rating ||
      b.goals - a.goals ||
      b.assists - a.assists ||
      b.minutes - a.minutes ||
      a.index - b.index,
  );
  const motm = played[0] ?? null;

  const events = result.events ?? [];
  const htEvent = events.find((e) => e.type === 'HALF_TIME');
  const htTick = htEvent ? htEvent.tick : Infinity;
  const htSeq = htEvent ? htEvent.seq : Infinity;

  // Backward VAR reconciliation: mark disallowed goals and yellows upgraded to red.
  const disallowedGoalSeqs = new Set();
  const upgradedYellowSeqs = new Set();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'VAR_DECISION') continue;
    if (ev.meta?.outcome === 'goalDisallowed') {
      for (let j = i - 1; j >= 0; j--) {
        const prev = events[j];
        if (prev.type === 'GOAL' && prev.actorIndex === ev.actorIndex && prev.teamIndex === ev.teamIndex && !disallowedGoalSeqs.has(prev.seq)) {
          disallowedGoalSeqs.add(prev.seq);
          break;
        }
      }
    } else if (ev.meta?.outcome === 'redCardUpgraded') {
      for (let j = i - 1; j >= 0; j--) {
        const prev = events[j];
        if (prev.type === 'YELLOW_CARD' && prev.actorIndex === ev.actorIndex && !upgradedYellowSeqs.has(prev.seq)) {
          upgradedYellowSeqs.add(prev.seq);
          break;
        }
      }
    }
  }

  /** @type {{home: ScorerEntry[], away: ScorerEntry[]}} */
  const scorers = { home: [], away: [] };
  /** @type {KeyEventEntry[]} */
  const keyEvents = [];

  for (const ev of events) {
    if (!KEY_EVENT_TYPES.has(ev.type)) continue;
    const minute = formatEventMinute(ev, htTick, htSeq);
    const overturned = disallowedGoalSeqs.has(ev.seq);
    const upgradedToRed = upgradedYellowSeqs.has(ev.seq);
    const actor = ev.actorIndex >= 0 ? players[ev.actorIndex] : null;
    const secIdx = ev.secondaryIndices?.[0] ?? -1;
    const secondary = secIdx >= 0 ? players[secIdx] : null;

    if (ev.type === 'GOAL' && !overturned) {
      const ownGoal = ev.meta?.kind === 'OWN_GOAL';
      const scoringSide = ownGoal ? 1 - ev.teamIndex : ev.teamIndex;
      const list = scoringSide === 0 ? scorers.home : scorers.away;
      list.push({
        actorIndex: ev.actorIndex,
        name: actor?.name ?? '',
        shortName: actor?.shortName ?? '',
        minute,
        ownGoal,
        penalty: ev.meta?.kind === 'PENALTY',
      });
    }

    keyEvents.push({
      seq: ev.seq,
      tick: ev.tick,
      minute,
      type: ev.type,
      teamIndex: ev.teamIndex,
      actorIndex: ev.actorIndex,
      actorName: actor?.shortName ?? '',
      secondaryName: secondary?.shortName ?? '',
      meta: ev.meta ? { ...ev.meta } : {},
      overturned,
      upgradedToRed,
    });
  }

  // Locate human side with tacticalPlans (supports home in Phase 1 and away in Phase 2)
  /** @type {'home' | 'away' | null} */
  const humanSide =
    input.home.controlledBy === 'human' && input.home.tacticalPlans
      ? 'home'
      : input.away.controlledBy === 'human' && input.away.tacticalPlans
        ? 'away'
        : null;
  const familiarity =
    humanSide !== null && input[humanSide].tacticalPlans && result.planUsage?.[humanSide]
      ? computeFamiliarityProgression(
          /** @type {import('../../engine/contracts/MatchInput.js').TeamTacticalPlans} */ (input[humanSide].tacticalPlans),
          /** @type {import('../../engine/contracts/MatchResult.js').TeamPlanUsage} */ (result.planUsage[humanSide]),
          config?.tactics?.instructions,
        )
      : null;

  return Object.freeze({
    v: 1,
    seed: result.seed,
    teamNames: { home: input.home.name, away: input.away.name },
    score: { home: result.score.home, away: result.score.away },
    scorers,
    motm,
    keyEvents,
    stats: result.stats,
    players,
    familiarity,
  });
}

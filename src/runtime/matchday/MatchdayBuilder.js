/**
 * Headless MatchInput assembly, Auto-Pick Best XI, starter ordering, and deterministic AI preset selection
 * (docs/designs/matchday_loop_phase1.md).
 */
import { computeOptimalSlotAssignments } from '../../engine/tactics/Formation.js';

/** Deterministic bench role ordering after auto-pick. */
export const BENCH_ROLE_ORDER = Object.freeze(['GK', 'CB', 'FB', 'MF', 'W', 'ST']);

/** @param {any} obj */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Shared default MatchInput factory used by both direct `#match` bypass and `buildMatchdayInput`.
 * Sets common app defaults (`v: 1`, `var: true`, `home.shouts: true`) with no `tacticalPlans` snapshot.
 * @param {{seed: number, configHash: string, homeSquad: any, awaySquad: any}} opts
 * @returns {import('../../engine/contracts/MatchInput.js').MatchInput}
 */
export function createDefaultMatchInput({ seed, configHash, homeSquad, awaySquad }) {
  return /** @type {import('../../engine/contracts/MatchInput.js').MatchInput} */ (
    clone({
      v: 1,
      seed,
      configHash,
      var: true,
      home: { ...homeSquad, shouts: true },
      away: awaySquad,
    })
  );
}

/**
 * Selects the optimal Starting XI (slots 0..10) and 7-player bench from an 18-player squad for `formationSlots`
 * using `computeOptimalSlotAssignments()` (pinning the best GK to slot 0). Bench is sorted by
 * `BENCH_ROLE_ORDER` then original squad index.
 * @param {any[]} players18
 * @param {any[]} formationSlots
 * @param {Record<string, any>} roles
 * @returns {any[]}
 */
export function autoPickBestXI(players18, formationSlots, roles) {
  const assigned = computeOptimalSlotAssignments(players18, formationSlots, roles);
  /** @type {any[]} */
  const starters = new Array(formationSlots.length);
  /** @type {{player: any, origIdx: number}[]} */
  const bench = [];
  players18.forEach((p, idx) => {
    const slot = assigned.get(idx) ?? -1;
    if (slot >= 0 && slot < formationSlots.length && starters[slot] === undefined) {
      starters[slot] = p;
    } else {
      bench.push({ player: p, origIdx: idx });
    }
  });
  // Defensive backfill if any slot stayed unassigned
  for (let s = 0; s < starters.length; s++) {
    if (starters[s] === undefined && bench.length > 0) starters[s] = bench.shift()?.player;
  }
  bench.sort((a, b) => {
    const ra = BENCH_ROLE_ORDER.indexOf(a.player.role);
    const rb = BENCH_ROLE_ORDER.indexOf(b.player.role);
    const ordA = ra < 0 ? 99 : ra;
    const ordB = rb < 0 ? 99 : rb;
    return ordA !== ordB ? ordA - ordB : a.origIdx - b.origIdx;
  });
  return [...starters, ...bench.map((b) => b.player)];
}

/**
 * Reorders `players18[0..10]` to optimally fill `formationSlots[0..10]` (keeping a GK at index 0)
 * while leaving the 7 bench players (`players18[11..17]`) untouched.
 * @param {any[]} players18
 * @param {any[]} formationSlots
 * @param {Record<string, any>} roles
 * @returns {any[]}
 */
export function orderStartersForFormation(players18, formationSlots, roles) {
  const currentStarters = players18.slice(0, 11);
  const bench = players18.slice(11);
  const assigned = computeOptimalSlotAssignments(currentStarters, formationSlots, roles);
  /** @type {any[]} */
  const ordered = new Array(11);
  /** @type {any[]} */
  const overflow = [];
  currentStarters.forEach((p, idx) => {
    const slot = assigned.get(idx) ?? -1;
    if (slot >= 0 && slot < 11 && ordered[slot] === undefined) ordered[slot] = p;
    else overflow.push(p);
  });
  for (let s = 0; s < 11; s++) {
    if (ordered[s] === undefined && overflow.length > 0) ordered[s] = overflow.shift();
  }
  return [...ordered, ...bench];
}

/**
 * Deterministically selects an AI tactical preset from `seed`.
 * @param {number} seed
 * @param {any[]} presets
 * @returns {any}
 */
export function pickAiPreset(seed, presets) {
  return presets[(seed >>> 0) % presets.length];
}

/**
 * Builds a validated Matchday `MatchInput` with human Plan A / Plan B `tacticalPlans` and a
 * deterministically seeded, formation-aligned AI opponent (with `tacticalPlans` omitted).
 * @param {{
 *   seed: number,
 *   config: any,
 *   configHash: string,
 *   homeSquad: any,
 *   awaySquad: any,
 *   homePlayers: any[],
 *   planAId: string,
 *   planBId: string,
 *   familiarity: import('./TacticalFamiliarityStore.js').FamiliarityRecordV1,
 * }} opts
 * @returns {import('../../engine/contracts/MatchInput.js').MatchInput}
 */
export function buildMatchdayInput({
  seed,
  config,
  configHash,
  homeSquad,
  awaySquad,
  homePlayers,
  planAId,
  planBId,
  familiarity,
}) {
  const presets = config.tacticalPresets.presets;
  const presetA = presets.find((/** @type {any} */ p) => p.id === planAId) ?? presets[0];
  const presetB = presets.find((/** @type {any} */ p) => p.id === planBId && p.id !== presetA.id) ?? presets[1];
  const aiPreset = pickAiPreset(seed, presets);
  const aiSlots = config.tactics.formations[aiPreset.formationId].slots;
  const alignedAwayPlayers = autoPickBestXI(awaySquad.players, aiSlots, config.roles);

  const input = createDefaultMatchInput({ seed, configHash, homeSquad, awaySquad });
  input.home.formationId = presetA.formationId;
  input.home.instructions = clone(presetA.instructions ?? {});
  input.home.players = clone(homePlayers);
  input.home.tacticalPlans = {
    planA: {
      tacticId: presetA.id,
      formationId: presetA.formationId,
      instructions: clone(presetA.instructions ?? {}),
      formFam: familiarity.formations[presetA.formationId] ?? 50,
      instrFam: familiarity.tactics[presetA.id] ?? 50,
    },
    planB: {
      tacticId: presetB.id,
      formationId: presetB.formationId,
      instructions: clone(presetB.instructions ?? {}),
      formFam: familiarity.formations[presetB.formationId] ?? 50,
      instrFam: familiarity.tactics[presetB.id] ?? 50,
    },
  };

  input.away.formationId = aiPreset.formationId;
  input.away.instructions = clone(aiPreset.instructions ?? {});
  input.away.players = clone(alignedAwayPlayers);
  return input;
}

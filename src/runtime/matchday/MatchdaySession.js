/**
 * UI-independent Matchday session container (docs/designs/matchday_loop_phase1.md).
 * Hash routing in `src/ui/main.js` remains the sole navigation state machine; this class holds
 * session familiarity, squad ordering, single-use `pendingMatchInput`, `latestReport`, and the
 * idempotent once-at-`FULL_TIME` persistence guard.
 */
import { matchSeedFrom } from '../matchSeed.js';
import {
  TacticalFamiliarityStore,
  applyFamiliarityProgression,
  defaultFamiliarityRecord,
} from './TacticalFamiliarityStore.js';
import {
  autoPickBestXI,
  buildMatchdayInput,
  orderStartersForFormation,
} from './MatchdayBuilder.js';
import { buildMatchReport } from './MatchReport.js';

/**
 * @param {() => number} [randomSeed]
 * @returns {number}
 */
function fallbackRandomSeed(randomSeed) {
  if (randomSeed) return randomSeed();
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return (buf[0] % 999999) + 1;
  }
  return Math.floor(Math.random() * 999999) + 1;
}

export class MatchdaySession {
  /**
   * @param {{
   *   config: any,
   *   configHash: string,
   *   homeSquad: any,
   *   awaySquad: any,
   *   storage?: import('../storage.js').StorageAdapter,
   *   search?: string,
   *   randomSeed?: () => number,
   * }} opts
   */
  constructor({ config, configHash, homeSquad, awaySquad, storage, search = '', randomSeed }) {
    this.config = config;
    this.configHash = configHash;
    this.homeSquad = homeSquad;
    this.awaySquad = awaySquad;
    this.randomSeed = randomSeed;
    this.store = new TacticalFamiliarityStore({ storage, tacticalPresets: config.tacticalPresets });
    this.familiarity = defaultFamiliarityRecord(config.tacticalPresets);
    this.seed = matchSeedFrom(search, () => fallbackRandomSeed(randomSeed));
    /** @type {any[]} */
    this.homePlayers = [];
    /** @type {import('../../engine/contracts/MatchInput.js').MatchInput | null} */
    this.pendingMatchInput = null;
    /** @type {import('./MatchReport.js').MatchReport | null} */
    this.latestReport = null;
    this.familiarityPersisted = false;
    this.#resetHomePlayers();
  }

  /** @param {string} tacticId */
  presetById(tacticId) {
    return this.config.tacticalPresets.presets.find((/** @type {any} */ p) => p.id === tacticId) ?? this.config.tacticalPresets.presets[0];
  }

  #resetHomePlayers() {
    const planA = this.presetById(this.familiarity.planA);
    const slots = this.config.tactics.formations[planA.formationId].slots;
    this.homePlayers = autoPickBestXI(JSON.parse(JSON.stringify(this.homeSquad.players)), slots, this.config.roles);
  }

  /** Loads persisted familiarity and initializes the Starting XI for Plan A. */
  async init() {
    this.familiarity = await this.store.load();
    this.#resetHomePlayers();
    return this.familiarity;
  }

  /**
   * Assigns `tacticId` to Plan A or Plan B (enforcing `planA !== planB`).
   * Changing Plan A's formation reorders starters via `orderStartersForFormation()`.
   * @param {'A' | 'B'} slot
   * @param {string} tacticId
   * @returns {boolean} true if updated, false if rejected (same tactic as the other slot)
   */
  setPlan(slot, tacticId) {
    const preset = this.config.tacticalPresets.presets.find((/** @type {any} */ p) => p.id === tacticId);
    if (!preset) return false;
    if (slot === 'A') {
      if (tacticId === this.familiarity.planB) return false;
      const prevForm = this.presetById(this.familiarity.planA).formationId;
      this.familiarity = { ...this.familiarity, planA: tacticId };
      if (preset.formationId !== prevForm) {
        const slots = this.config.tactics.formations[preset.formationId].slots;
        this.homePlayers = orderStartersForFormation(this.homePlayers, slots, this.config.roles);
      }
      return true;
    }
    if (tacticId === this.familiarity.planA) return false;
    this.familiarity = { ...this.familiarity, planB: tacticId };
    return true;
  }

  /**
   * Direct index swap in `homePlayers` (enforcing GK swaps strictly between slot 0 and a bench GK).
   * @param {number} i
   * @param {number} j
   * @returns {boolean}
   */
  swapPlayers(i, j) {
    if (i === j || i < 0 || j < 0 || i >= this.homePlayers.length || j >= this.homePlayers.length) return false;
    const pA = this.homePlayers[i];
    const pB = this.homePlayers[j];
    const involvesSlot0 = i === 0 || j === 0;
    const involvesGk = pA.role === 'GK' || pB.role === 'GK';
    if (involvesSlot0 && !(pA.role === 'GK' && pB.role === 'GK')) return false;
    if (involvesGk && !involvesSlot0) {
      // Prevent placing a backup GK in an outfield starter slot (1..10); bench-to-bench is harmless
      const entersOutfield = (pA.role === 'GK' && j >= 1 && j < 11) || (pB.role === 'GK' && i >= 1 && i < 11);
      if (entersOutfield) return false;
    }
    const next = this.homePlayers.slice();
    next[i] = pB;
    next[j] = pA;
    this.homePlayers = next;
    return true;
  }

  /** Runs `autoPickBestXI()` on the current 18 players for Plan A's formation. */
  autoPick() {
    const planA = this.presetById(this.familiarity.planA);
    const slots = this.config.tactics.formations[planA.formationId].slots;
    this.homePlayers = autoPickBestXI(this.homePlayers, slots, this.config.roles);
  }

  /**
   * Builds and stores the single-use `pendingMatchInput` for `#match`, preserving manual squad swaps,
   * and persists Plan A / Plan B selections.
   * @returns {import('../../engine/contracts/MatchInput.js').MatchInput}
   */
  prepareKickOff() {
    this.latestReport = null;
    this.familiarityPersisted = false;
    this.pendingMatchInput = buildMatchdayInput({
      seed: this.seed,
      config: this.config,
      configHash: this.configHash,
      homeSquad: this.homeSquad,
      awaySquad: this.awaySquad,
      homePlayers: this.homePlayers,
      planAId: this.familiarity.planA,
      planBId: this.familiarity.planB,
      familiarity: this.familiarity,
    });
    void this.store.save(this.familiarity);
    return this.pendingMatchInput;
  }

  /**
   * Single-use consumption of `pendingMatchInput` when mounting `#match`.
   * @returns {import('../../engine/contracts/MatchInput.js').MatchInput | null}
   */
  consumeMatchInput() {
    const input = this.pendingMatchInput;
    this.pendingMatchInput = null;
    return input;
  }

  /**
   * Synchronously builds `latestReport`, applies familiarity progression once (idempotent),
   * clears `pendingMatchInput`, and returns the async persistence promise.
   * @param {import('../../engine/contracts/MatchInput.js').MatchInput} input
   * @param {import('../../engine/contracts/MatchResult.js').MatchResult} result
   * @returns {Promise<void>}
   */
  completeMatch(input, result) {
    this.pendingMatchInput = null;
    if (this.familiarityPersisted && this.latestReport !== null) {
      return Promise.resolve();
    }
    this.latestReport = buildMatchReport({ input, result, config: this.config });
    this.familiarityPersisted = true;
    if (this.latestReport.familiarity) {
      this.familiarity = applyFamiliarityProgression(this.familiarity, this.latestReport.familiarity.deltas);
      return this.store.save(this.familiarity);
    }
    return Promise.resolve();
  }

  /** Resets match/report state, clones fresh squads, rolls a fresh seed, and keeps familiarity + Plan A/B. */
  resetForNextMatch() {
    this.latestReport = null;
    this.pendingMatchInput = null;
    this.familiarityPersisted = false;
    this.seed = fallbackRandomSeed(this.randomSeed);
    this.#resetHomePlayers();
  }
}

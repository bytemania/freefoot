/**
 * Versioned persistence repository for tactical familiarity and Plan A/B selection
 * (docs/designs/matchday_loop_phase1.md). Wraps an injected async `StorageAdapter`
 * (`src/runtime/storage.js`) and recovers cleanly from corrupt or unknown-version payloads.
 */
import { capacitorStorage } from '../storage.js';

export const FAMILIARITY_STORAGE_KEY = 'freefoot.tacticalFamiliarity.v1';

/**
 * @typedef {object} FamiliarityRecordV1
 * @property {1} schemaVersion
 * @property {'default'} scopeId
 * @property {string} planA
 * @property {string} planB
 * @property {Record<string, number>} formations
 * @property {Record<string, number>} tactics
 *
 * @typedef {object} FamiliarityDeltas
 * @property {Record<string, number>} formations
 * @property {Record<string, number>} tactics
 */

/** @param {unknown} v @param {number} fallback */
function clampFam(v, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const rounded = Math.round(v);
  return rounded < 0 ? 0 : rounded > 100 ? 100 : rounded;
}

/**
 * Builds the first-launch familiarity record from compiled `config.tacticalPresets`.
 * @param {any} tacticalPresets
 * @returns {FamiliarityRecordV1}
 */
export function defaultFamiliarityRecord(tacticalPresets) {
  /** @type {Record<string, number>} */
  const formations = {};
  for (const [id, val] of Object.entries(tacticalPresets.defaultFormations)) {
    formations[id] = clampFam(val, 50);
  }
  /** @type {Record<string, number>} */
  const tactics = {};
  for (const p of tacticalPresets.presets) {
    tactics[p.id] = clampFam(p.defaultInstrFam, 50);
  }
  return {
    schemaVersion: 1,
    scopeId: 'default',
    planA: tacticalPresets.defaultSlots.planA,
    planB: tacticalPresets.defaultSlots.planB,
    formations,
    tactics,
  };
}

/**
 * Validates, backfills, and clamps a raw parsed record against `tacticalPresets`.
 * Falls back to defaults on unknown schemaVersion or malformed structures.
 * @param {any} raw
 * @param {any} tacticalPresets
 * @returns {FamiliarityRecordV1}
 */
export function sanitizeFamiliarityRecord(raw, tacticalPresets) {
  const defaults = defaultFamiliarityRecord(tacticalPresets);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1) {
    return defaults;
  }
  const presetIds = new Set(tacticalPresets.presets.map((/** @type {any} */ p) => p.id));
  const formations = { ...defaults.formations };
  if (raw.formations && typeof raw.formations === 'object' && !Array.isArray(raw.formations)) {
    for (const id of Object.keys(defaults.formations)) {
      if (id in raw.formations) formations[id] = clampFam(raw.formations[id], defaults.formations[id]);
    }
  }
  const tactics = { ...defaults.tactics };
  if (raw.tactics && typeof raw.tactics === 'object' && !Array.isArray(raw.tactics)) {
    for (const id of Object.keys(defaults.tactics)) {
      if (id in raw.tactics) tactics[id] = clampFam(raw.tactics[id], defaults.tactics[id]);
    }
  }
  let planA = typeof raw.planA === 'string' && presetIds.has(raw.planA) ? raw.planA : defaults.planA;
  let planB = typeof raw.planB === 'string' && presetIds.has(raw.planB) ? raw.planB : defaults.planB;
  if (planA === planB) {
    planB = tacticalPresets.presets.find((/** @type {any} */ p) => p.id !== planA)?.id ?? defaults.planB;
  }
  return { schemaVersion: 1, scopeId: 'default', planA, planB, formations, tactics };
}

/**
 * Pure reducer applying non-negative post-match familiarity deltas, clamped to `0..100`.
 * @param {FamiliarityRecordV1} record
 * @param {FamiliarityDeltas} deltas
 * @returns {FamiliarityRecordV1}
 */
export function applyFamiliarityProgression(record, deltas) {
  const formations = { ...record.formations };
  for (const [id, delta] of Object.entries(deltas.formations ?? {})) {
    if (id in formations && typeof delta === 'number' && Number.isFinite(delta) && delta > 0) {
      formations[id] = clampFam(formations[id] + delta, formations[id]);
    }
  }
  const tactics = { ...record.tactics };
  for (const [id, delta] of Object.entries(deltas.tactics ?? {})) {
    if (id in tactics && typeof delta === 'number' && Number.isFinite(delta) && delta > 0) {
      tactics[id] = clampFam(tactics[id] + delta, tactics[id]);
    }
  }
  return { ...record, formations, tactics };
}

export class TacticalFamiliarityStore {
  /**
   * @param {{storage?: import('../storage.js').StorageAdapter, tacticalPresets: any, key?: string}} opts
   */
  constructor({ storage = capacitorStorage(), tacticalPresets, key = FAMILIARITY_STORAGE_KEY }) {
    this.storage = storage;
    this.tacticalPresets = tacticalPresets;
    this.key = key;
  }

  /** @returns {Promise<FamiliarityRecordV1>} */
  async load() {
    try {
      const rawText = await this.storage.get(this.key);
      if (!rawText) return defaultFamiliarityRecord(this.tacticalPresets);
      const parsed = JSON.parse(rawText);
      return sanitizeFamiliarityRecord(parsed, this.tacticalPresets);
    } catch {
      return defaultFamiliarityRecord(this.tacticalPresets);
    }
  }

  /**
   * @param {FamiliarityRecordV1} record
   * @returns {Promise<void>}
   */
  async save(record) {
    const clean = sanitizeFamiliarityRecord(record, this.tacticalPresets);
    await this.storage.set(this.key, JSON.stringify(clean));
  }
}

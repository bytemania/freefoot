/**
 * Tactical familiarity (docs/designs/matchday_loop_phase1.md): pure, deterministic helpers shared by
 * `src/engine/`, `src/runtime/matchday/`, and `TacticsView`. Deliberately imports nothing from
 * `Instructions.js` so the module graph stays strictly acyclic (`Instructions.js -> Familiarity.js`).
 */

/** @typedef {'fluid' | 'competent' | 'unfamiliar'} FamiliarityTier */

/**
 * @typedef {object} FamiliarityBreakdown
 * @property {number} formFam
 * @property {number} instrFam
 * @property {number} instrFamLive
 * @property {number} changed
 * @property {boolean} modified
 * @property {number} raw
 * @property {boolean} capped
 * @property {number} effective
 * @property {FamiliarityTier} tier
 */

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Counts how many instructions in `instrCfg` differ between `activeInstructions` and `trainedInstructions`.
 * Omitted keys default to `instrCfg[id].default`.
 * @param {Record<string, any> | undefined} instrCfg `config.tactics.instructions`
 * @param {Record<string, string> | undefined | null} activeInstructions
 * @param {Record<string, string> | undefined | null} trainedInstructions
 * @returns {number}
 */
export function countInstructionDeviations(instrCfg, activeInstructions, trainedInstructions) {
  if (!instrCfg) return 0;
  let changed = 0;
  for (const id of Object.keys(instrCfg)) {
    const def = instrCfg[id].default;
    const active = typeof activeInstructions?.[id] === 'string' ? activeInstructions[id] : def;
    const trained = typeof trainedInstructions?.[id] === 'string' ? trainedInstructions[id] : def;
    if (active !== trained) changed++;
  }
  return changed;
}

/**
 * Derives effective familiarity from a plan slot's formation/instruction familiarity and the team's active
 * instructions: 60% formation + 40% live instruction familiarity (`-12` per deviated instruction), capped at
 * `79` (Competent) whenever `min(formFam, instrFamLive) < 65`.
 * @param {Record<string, any> | undefined} instrCfg
 * @param {{formFam: number, instrFam: number, instructions?: Record<string, string>}} plan
 * @param {Record<string, string> | undefined | null} activeInstructions
 * @returns {FamiliarityBreakdown}
 */
export function deriveEffectiveFamiliarity(instrCfg, plan, activeInstructions) {
  const formFam = clamp(plan.formFam, 0, 100);
  const instrFam = clamp(plan.instrFam, 0, 100);
  const changed = countInstructionDeviations(instrCfg, activeInstructions, plan.instructions);
  const instrFamLive = Math.max(0, instrFam - 12 * changed);
  const raw = clamp(Math.round(0.6 * formFam + 0.4 * instrFamLive), 0, 100);
  const capped = Math.min(formFam, instrFamLive) < 65 && raw > 79;
  const effective = capped ? 79 : raw;
  const modified = changed > 0;
  /** @type {FamiliarityTier} */
  const tier = effective >= 80 ? 'fluid' : effective >= 50 ? 'competent' : 'unfamiliar';
  return { formFam, instrFam, instrFamLive, changed, modified, raw, capped, effective, tier };
}

/**
 * Returns the knob modifiers for an effective familiarity score, or `null` when Fluid (`>= 80`, exact no-op).
 * - `80..100`: `null`
 * - `50..79`: linear `noiseMul` ramp from `1.00` (at 80) to `1.06` (at 50)
 * - `0..49`: linear `noiseMul` ramp from `1.06` (at 50) to `1.12` (at 0) and `drainMul` from `1.00` (at 50) to `1.05` (at 0)
 * @param {number} effective
 * @returns {Readonly<Record<string, number>> | null}
 */
export function familiarityKnobsFor(effective) {
  const eff = clamp(effective, 0, 100);
  if (eff >= 80) return null;
  if (eff >= 50) {
    return Object.freeze({ noiseMul: 1 + 0.06 * ((80 - eff) / 30) });
  }
  return Object.freeze({
    noiseMul: 1.06 + 0.06 * ((50 - eff) / 50),
    drainMul: 1 + 0.05 * ((50 - eff) / 50),
  });
}

/**
 * Team instructions (docs/designs/tactics_instructions.md). Eight instructions (tempo, directness, ...) each pick
 * one option from `config.tactics.instructions`; an option is a set of knob values. This module is the only place
 * where option names become numbers: `resolveKnobs` folds the chosen options into one flat, frozen knob object per
 * team (`TeamState.knobs`), and engine code reads only those numbers.
 *
 * Every knob has an identity value at which it is an exact no-op (`x * 1`, `x + 0`, or a threshold never reached),
 * and every default option is `{}` (build-config enforces it), so an all-default team is bit-identical to an engine
 * without instructions.
 */

/** A threshold that is never reached (identity of `min` knobs). */
export const NEVER = 1e9;

/**
 * The knob catalogue: identity value and how values from several instructions combine.
 * @type {Readonly<Record<string, {identity: number, compose: 'mul' | 'add' | 'min'}>>}
 */
export const KNOBS = Object.freeze({
  // Tempo.
  settleMul: { identity: 1, compose: 'mul' }, // the new carrier's settle time before deciding
  holdAdd: { identity: 0, compose: 'add' }, // carrier's hold score
  noiseMul: { identity: 1, compose: 'mul' }, // decision noise scale
  drainMul: { identity: 1, compose: 'mul' }, // fitness drain (shared by several instructions)
  // Passing directness.
  progressMul: { identity: 1, compose: 'mul' }, // weight of a pass's progress
  shortPassAdd: { identity: 0, compose: 'add' },
  longPassAdd: { identity: 0, compose: 'add' }, // LONG and SWITCH
  throughPassAdd: { identity: 0, compose: 'add' },
  // Read by the opponent's passScore: a high line invites balls in behind it (a low one does not).
  invitesThroughAdd: { identity: 0, compose: 'add' },
  // Attacking corridor.
  widePassBias: { identity: 0, compose: 'add' }, // pass score toward a target in a wide channel
  centerPassBias: { identity: 0, compose: 'add' }, // pass score toward a target in the central channel
  widthMul: { identity: 1, compose: 'mul' }, // in-possession width of wingers and full-backs (distance from the centre line)
  // Attacking transition.
  transitionAttMul: { identity: 1, compose: 'mul' }, // length of TRANSITION_ATT
  transitionPushAdd: { identity: 0, compose: 'add' }, // metres forwards and wingers push in TRANSITION_ATT
  transitionMfPushAdd: { identity: 0, compose: 'add' }, // metres midfielders and full-backs push in TRANSITION_ATT
  transitionProgressMul: { identity: 1, compose: 'mul' }, // progress weight in TRANSITION_ATT
  // Time-wasting (only while leading).
  wasteFromMinute: { identity: NEVER, compose: 'min' },
  wasteHoldMul: { identity: 1, compose: 'mul' }, // own restart hold
  wasteCardP: { identity: 0, compose: 'add' }, // booking chance for the taker per wasted restart
  wasteAddedShare: { identity: 0, compose: 'add' }, // share of the extra seconds added to the half's added time
  // Defensive line.
  lineBackM: { identity: 0, compose: 'add' }, // metres the back line's out-of-possession depth moves up the pitch
  lineMidM: { identity: 0, compose: 'add' }, // the same for the midfield line
  // Marking.
  markZoneMul: { identity: 1, compose: 'mul' }, // marking radius
  markFromSelf: { identity: 0, compose: 'add' }, // 0: look for a man around the anchor, 1: around the player
  markStick: { identity: 0, compose: 'add' }, // 1: keep the previous man while he stays within the radius
  markGapMul: { identity: 1, compose: 'mul' }, // goal-side marking gap
  screenMul: { identity: 1, compose: 'mul' }, // back-line screening radius
  dribbledLogit: { identity: 0, compose: 'add' }, // logit on an opponent's chance to dribble past one of the team
  // Defensive transition.
  cpTicksMul: { identity: 1, compose: 'mul' }, // counter-press length
  cpFromAdd: { identity: 0, compose: 'add' }, // metres: how far up the pitch a loss must be to trigger it
  cpCountAdd: { identity: 0, compose: 'add' }, // players who counter-press
  cpZoneMul: { identity: 1, compose: 'mul' }, // counter-press reach
  transitionDropM: { identity: 0, compose: 'add' }, // metres the shape drops in TRANSITION_DEF
  // Tackling.
  tackleAttemptMul: { identity: 1, compose: 'mul' },
  tackleWinLogit: { identity: 0, compose: 'add' },
  tackleFoulLogit: { identity: 0, compose: 'add' },
  severityAdd: { identity: 0, compose: 'add' }, // foul severity (cards)
});

/** @typedef {Readonly<Record<string, number>>} Knobs */

/** The all-identity knobs, shared by every all-default team. */
export const IDENTITY_KNOBS = /** @type {Knobs} */ (Object.freeze(Object.fromEntries(Object.entries(KNOBS).map(([k, v]) => [k, v.identity]))));

/**
 * @param {any} cfg `config.tactics.instructions` (may be undefined)
 * @returns {Record<string, string>} every instruction at its default option
 */
export function defaultInstructions(cfg) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const id of Object.keys(cfg ?? {})) out[id] = cfg[id].default;
  return out;
}

/**
 * Checks an instructions map (instruction -> option; missing instructions mean their default).
 * @param {any} cfg
 * @param {any} value
 * @returns {null | 'BAD_INSTRUCTIONS' | 'UNKNOWN_INSTRUCTION' | 'UNKNOWN_OPTION'}
 */
export function validateInstructions(cfg, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'BAD_INSTRUCTIONS';
  for (const [id, option] of Object.entries(value)) {
    if (!cfg || !Object.hasOwn(cfg, id)) return 'UNKNOWN_INSTRUCTION';
    if (typeof option !== 'string' || !Object.hasOwn(cfg[id].options, option)) return 'UNKNOWN_OPTION';
  }
  return null;
}

/**
 * A full instructions map: `value`'s options over the defaults, in config order. Assumes `value` is valid
 * (or undefined).
 * @param {any} cfg
 * @param {Record<string, string> | undefined | null} value
 * @returns {Record<string, string>}
 */
export function normalizeInstructions(cfg, value) {
  const out = defaultInstructions(cfg);
  if (value) for (const id of Object.keys(out)) if (typeof value[id] === 'string') out[id] = value[id];
  return out;
}

/**
 * @param {any} cfg
 * @param {Record<string, string>} value
 * @returns {boolean} whether every instruction is at its default
 */
export function isDefaultInstructions(cfg, value) {
  for (const id of Object.keys(cfg ?? {})) if ((value[id] ?? cfg[id].default) !== cfg[id].default) return false;
  return true;
}

/**
 * Folds the chosen options into one flat knob object, starting from every knob's identity.
 * All-default instructions return the shared `IDENTITY_KNOBS`.
 * @param {any} cfg
 * @param {Record<string, string>} value a full instructions map
 * @returns {Knobs}
 */
export function resolveKnobs(cfg, value) {
  if (isDefaultInstructions(cfg, value)) return IDENTITY_KNOBS;
  /** @type {Record<string, number>} */
  const out = { ...IDENTITY_KNOBS };
  for (const id of Object.keys(cfg)) {
    const knobs = cfg[id].options[value[id] ?? cfg[id].default]?.knobs ?? {};
    for (const [name, v] of Object.entries(knobs)) {
      const def = KNOBS[name];
      if (def === undefined) throw new Error(`instructions: unknown knob "${name}" in ${id}`);
      if (def.compose === 'mul') out[name] *= v;
      else if (def.compose === 'add') out[name] += v;
      else out[name] = v < out[name] ? v : out[name];
    }
  }
  return Object.freeze(out);
}

/**
 * Sets a team's instructions and its resolved knobs.
 * @param {any} cfg
 * @param {import('../state/TeamState.js').TeamState} team
 * @param {Record<string, string> | undefined | null} value
 */
export function setInstructions(cfg, team, value) {
  team.instructions = normalizeInstructions(cfg, value);
  team.knobs = resolveKnobs(cfg, team.instructions);
}

/**
 * Per-tick view of the config (design §3). `create` builds it once: rates
 * (coefficients flagged `rate: true`) are multiplied by `dt`, and the
 * `{value, initial, rate}` wrappers are dropped so engine code reads plain
 * numbers. `configHash` is computed over the raw config, so the tick rate is
 * a single constant here.
 */

export const TICKS_PER_SECOND = 20;
export const DT = 1 / TICKS_PER_SECOND;
export const HALF_TICKS = 45 * 60 * TICKS_PER_SECOND;

/**
 * @param {any} node
 * @returns {any}
 */
function unwrap(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
  if ('value' in node && 'initial' in node) {
    return node.rate === true ? node.value * DT : node.value;
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(node)) out[key] = unwrap(node[key]);
  return out;
}

/**
 * @param {any} value
 * @returns {any} the same value, deeply frozen
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * @typedef {object} TickConfig
 * @property {number} dt seconds per tick
 * @property {number} halfTicks
 * @property {any} weights unwrapped weights.yaml, rates per tick
 * @property {any} injuries unwrapped injuries.yaml
 * @property {any} officiating unwrapped officiating.yaml
 * @property {number} evalIntervalTicks
 */

/**
 * @param {any} config compiled config (generated/config.js)
 * @returns {TickConfig}
 */
export function buildTickConfig(config) {
  return deepFreeze({
    dt: DT,
    halfTicks: HALF_TICKS,
    weights: unwrap(config.weights),
    injuries: unwrap(config.injuries),
    officiating: unwrap(config.officiating),
    evalIntervalTicks: config.aiCoach.evalIntervalTicks,
  });
}

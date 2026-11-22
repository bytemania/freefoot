/**
 * Shared statistical helpers (design item 26d). Used by both the calibration
 * reporter and the StatsBomb reference extractor so engine percentiles and
 * reference percentiles use the exact same method.
 */

/**
 * Arithmetic mean of a numeric array (0 for an empty array).
 * @param {number[]} values
 * @returns {number}
 */
export function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

/**
 * Percentile on a pre-sorted ascending array using linear interpolation
 * between closest ranks (Hyndman-Fan type 7, default in R and NumPy).
 * @param {number[]} sorted ascending numeric array
 * @param {number} p probability in [0, 1] (for example 0.1 for p10, 0.9 for p90)
 * @returns {number}
 */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1 || p <= 0) return sorted[0];
  if (p >= 1) return sorted[n - 1];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Returns mean, p10 and p90 of an unsorted numeric array.
 * @param {number[]} values
 * @returns {{mean: number, p10: number, p90: number}}
 */
export function summarize(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    mean: mean(values),
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
  };
}

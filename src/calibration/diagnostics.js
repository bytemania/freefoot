// Report-only match diagnostics for the cohort profiler (never gate pass / fail).
// One match's events become a small raw-count record (`matchDiagnostics`); many records become
// per-match means and pooled percentages (`summarizeDiagnostics`), and `outlierSeeds` names the
// seeds that sit furthest from the cohort mean, for a quick look in the `#seed` viewer.
import { metricsFromEvents } from './metrics.js';

/** Raw per-team counters kept for every match (pooled later, so percentages are not averaged twice). */
const RAW = Object.freeze([
  'shots',
  'shotsOnTarget',
  'shotsInBox',
  'xG',
  'passes',
  'passesCompleted',
  'progressivePasses',
  'interceptions',
  'finalThirdPasses',
  'oppPassesInOpp60',
  'defActionsInOpp60',
]);

/**
 * @typedef {Record<string, number>} TeamDiag raw counters of one team in one match, plus throwIns and miscontrols
 * @typedef {{home: TeamDiag, away: TeamDiag}} MatchDiag
 */

/**
 * @param {Array<{type: string, teamIndex: number, x: number, y: number, zone: number, meta?: Record<string, any>}>} events
 * @returns {MatchDiag}
 */
export function matchDiagnostics(events) {
  const m = metricsFromEvents(events);
  /** @type {MatchDiag} */
  const out = { home: {}, away: {} };
  for (const [side, t] of /** @type {const} */ ([['home', 0], ['away', 1]])) {
    for (const k of RAW) out[side][k] = m[side][k] ?? 0;
    out[side].throwIns = 0;
    out[side].miscontrols = 0;
    for (const e of events) {
      if (e.teamIndex !== t) continue;
      if (e.type === 'THROW_IN') out[side].throwIns++;
      else if (e.type === 'MISCONTROL') out[side].miscontrols++;
    }
  }
  return out;
}

/** @param {number} num @param {number} den @param {number} [fallback] */
function ratio(num, den, fallback = 0) {
  return den > 0 ? num / den : fallback;
}

/**
 * Per-match means (both teams combined) and pooled percentages of the diagnostic rows, plus the
 * favourite / home side's own shots and shots on target (the Heavy-tier rows).
 * @param {Array<{diag?: MatchDiag}>} rows
 * @returns {null | {matches: number, rows: Record<string, number>, home: {shots: number, shotsOnTarget: number}, away: {shots: number, shotsOnTarget: number}}}
 */
export function summarizeDiagnostics(rows) {
  const withDiag = rows.filter((r) => r.diag !== undefined);
  const n = withDiag.length;
  if (n === 0) return null;
  /** @type {Record<string, number>} */
  const sum = {};
  /** @type {Record<string, number>} */
  const homeSum = {};
  /** @type {Record<string, number>} */
  const awaySum = {};
  const keys = [...RAW, 'throwIns', 'miscontrols'];
  for (const k of keys) {
    sum[k] = 0;
    homeSum[k] = 0;
    awaySum[k] = 0;
  }
  for (const r of withDiag) {
    const d = /** @type {MatchDiag} */ (r.diag);
    for (const k of keys) {
      homeSum[k] += d.home[k] ?? 0;
      awaySum[k] += d.away[k] ?? 0;
      sum[k] += (d.home[k] ?? 0) + (d.away[k] ?? 0);
    }
  }
  const perMatch = (/** @type {string} */ k) => sum[k] / n;
  return {
    matches: n,
    rows: {
      throwIns: perMatch('throwIns'),
      passes: perMatch('passes'),
      passCompletionPct: 100 * ratio(sum.passesCompleted, sum.passes),
      progressivePasses: perMatch('progressivePasses'),
      interceptions: perMatch('interceptions'),
      miscontrols: perMatch('miscontrols'),
      xG: perMatch('xG'),
      shotsInBoxPct: 100 * ratio(sum.shotsInBox, sum.shots),
      // The home side's share of final-third passes; the away side's is the complement.
      fieldTiltPct: 100 * ratio(homeSum.finalThirdPasses, sum.finalThirdPasses, 0.5),
      // Opponent passes in their own 60% per defensive action, pooled over both sides.
      ppda: ratio(sum.oppPassesInOpp60, sum.defActionsInOpp60),
    },
    home: { shots: homeSum.shots / n, shotsOnTarget: homeSum.shotsOnTarget / n },
    away: { shots: awaySum.shots / n, shotsOnTarget: awaySum.shotsOnTarget / n },
  };
}

/**
 * The `count` seeds furthest from the cohort mean, ranked by the sum of the absolute z-scores of
 * total goals and total shots.
 * @param {Array<{seed: number, total: Record<string, number>}>} rows
 * @param {number} [count]
 * @returns {Array<{seed: number, goals: number, shots: number, z: number}>}
 */
export function outlierSeeds(rows, count = 3) {
  if (rows.length < 2) return [];
  const stat = (/** @type {(r: any) => number} */ f) => {
    const xs = rows.map(f);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (xs.length - 1));
    return { mean, sd: sd > 0 ? sd : 1 };
  };
  const g = stat((r) => r.total.goals);
  const s = stat((r) => r.total.shots);
  return rows
    .map((r) => ({
      seed: r.seed,
      goals: r.total.goals,
      shots: r.total.shots,
      z: Math.abs(r.total.goals - g.mean) / g.sd + Math.abs(r.total.shots - s.mean) / s.sd,
    }))
    .sort((a, b) => b.z - a.z || a.seed - b.seed)
    .slice(0, count);
}

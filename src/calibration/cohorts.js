/**
 * Strength- and morale-aware cohort calibration (scripts/calibrate.mjs).
 *
 * Four cohorts of AI-v-AI matches are checked against the Big-5 benchmarks in
 * `config/benchmarks/top5-10yr.json` (written by
 * scripts/fetch-league-benchmarks.mjs):
 *
 *  - even:     80 OVR v 80 OVR, morale 75 - the ten per-match event
 *              frequencies, the draw rate of evenly priced matches, and
 *              home/away symmetry (the engine has no home advantage);
 *  - moderate: 83 v 74 (~9 OVR gap) - favourite win / draw / underdog win,
 *              goal difference and shot share of the 0.50-0.60 closing-odds tier;
 *  - heavy:    88 v 68 (~20 OVR gap) - the same for the 0.65-0.78 tier;
 *  - morale:   80 @ 92 v 80 @ 35 - a bounded edge for the confident side
 *              (win rate, goal difference, goals per shot on target) with the
 *              event frequencies still inside their bands.
 *
 * Everything here is pure (no Node APIs) so it can be unit tested; the runner
 * plays the matches and loads the benchmark file.
 */

import { outlierSeeds, summarizeDiagnostics } from './diagnostics.js';

/** The ten gated per-match event frequencies (both teams combined). */
export const EVENT_METRICS = Object.freeze([
  'goals',
  'shots',
  'shotsOnTarget',
  'corners',
  'fouls',
  'offsides',
  'yellowCards',
  'redCards',
  'penalties',
  'injuries',
]);

/** Engine event type counted for each metric (goals come from the score). */
const EVENT_TYPE = Object.freeze({
  corners: 'CORNER',
  fouls: 'FOUL',
  offsides: 'OFFSIDE',
  yellowCards: 'YELLOW_CARD',
  redCards: 'RED_CARD',
  penalties: 'PENALTY_AWARDED',
  injuries: 'INJURY',
});

/**
 * @typedef {{ovr: number, morale: number}} CohortSide
 * @typedef {{id: string, label: string, home: CohortSide, away: CohortSide, tier: 'even' | 'moderate' | 'heavy' | null, eventBands: boolean, morale: boolean}} Cohort
 */

/** @type {readonly Cohort[]} */
export const COHORTS = Object.freeze([
  { id: 'even', label: 'Evenly matched: 80 OVR v 80 OVR, morale 75', home: { ovr: 80, morale: 75 }, away: { ovr: 80, morale: 75 }, tier: 'even', eventBands: true, morale: false },
  { id: 'moderate', label: 'Moderate favourite: 83 OVR v 74 OVR', home: { ovr: 83, morale: 75 }, away: { ovr: 74, morale: 75 }, tier: 'moderate', eventBands: false, morale: false },
  { id: 'heavy', label: 'Heavy favourite: 88 OVR v 68 OVR', home: { ovr: 88, morale: 75 }, away: { ovr: 68, morale: 75 }, tier: 'heavy', eventBands: false, morale: false },
  { id: 'morale', label: 'Morale differential: 80 OVR @ 92 v 80 OVR @ 35', home: { ovr: 80, morale: 92 }, away: { ovr: 80, morale: 35 }, tier: null, eventBands: true, morale: true },
]);

/**
 * Offline fallback: the values the benchmark script produced on 2026-11-22
 * (football-data.co.uk 2016/17-2025/26, 17,937 matches; StatsBomb 2015/16
 * Big-5, 1,551 matches). Used when config/benchmarks/top5-10yr.json is
 * missing, e.g. in CI without network access.
 */
export const FALLBACK_BENCHMARKS = Object.freeze({
  fallback: true,
  eventFrequencies: {
    goals: { mean: 2.7934, sd: 1.6747, band: [2.4582, 3.1286] },
    shots: { mean: 24.6612, sd: 5.8463, band: [20.962, 28.3604] },
    shotsOnTarget: { mean: 8.8456, sd: 3.2383, band: [7.5188, 10.1724] },
    corners: { mean: 9.7892, sd: 3.3938, band: [7.8314, 11.747] },
    fouls: { mean: 24.5807, sd: 6.0666, band: [20.8936, 28.2678] },
    yellowCards: { mean: 4.0598, sd: 2.1461, band: [3.0449, 5.0748] },
    redCards: { mean: 0.1933, sd: 0.4591, band: [0.0967, 0.29] },
    offsides: { mean: 4.4784, sd: 2.4727, band: [3.1349, 5.8219] },
    penalties: { mean: 0.2643, sd: 0.5215, band: [0.1454, 0.3832] },
    injuries: { mean: 2.4629, sd: 1.8128, band: [1.3546, 3.5712] },
  },
  strengthTiers: {
    even: { favWin: 0.406, draw: 0.2993, dogWin: 0.2947, goalDiff: 0.2203, favShotShare: 0.5247, matches: 6182 },
    moderate: { favWin: 0.5566, draw: 0.2532, dogWin: 0.1902, goalDiff: 0.7722, favShotShare: 0.5839, matches: 4096 },
    heavy: { favWin: 0.7301, draw: 0.1701, dogWin: 0.0998, goalDiff: 1.4851, favShotShare: 0.6528, matches: 2645 },
  },
  formEffect: {
    rawWinRateDelta: 0.2763,
    rawConversionDelta: 0.0538,
    matchedStrength: { winRateDelta: -0.0113, conversionDelta: 0.0209 },
  },
});

/** Minimum half-widths of the result-probability, goal-difference and shot-share bands. */
export const BAND_FLOORS = Object.freeze({ probability: 0.06, goalDiff: 0.3, shotShare: 0.07, symmetry: 0.15 });

/** Morale edge bounds (see moraleBands). */
export const MORALE_LIMITS = Object.freeze({ minWinEdge: 0.02, maxWinEdge: 0.2, minGoalDiff: 0.05, maxGoalDiff: 0.6 });

/**
 * Checks a parsed benchmark file has what the evaluation reads; returns it, or
 * the fallback (with `fallback: true`) when it is missing or malformed.
 * @param {any} data
 * @returns {any}
 */
export function resolveBenchmarks(data) {
  const ok =
    data &&
    typeof data === 'object' &&
    EVENT_METRICS.every((id) => Array.isArray(data.eventFrequencies?.[id]?.band)) &&
    ['even', 'moderate', 'heavy'].every((t) => typeof data.strengthTiers?.[t]?.favWin === 'number') &&
    typeof data.formEffect?.rawWinRateDelta === 'number';
  return ok ? data : FALLBACK_BENCHMARKS;
}

/**
 * Per-match counts from an engine event log and the final score.
 * @param {Array<{type: string, teamIndex: number, meta?: Record<string, any>}>} events
 * @param {[number, number]} score
 * @returns {{total: Record<string, number>, home: {goals: number, shots: number, shotsOnTarget: number}, away: {goals: number, shots: number, shotsOnTarget: number}}}
 */
export function matchCounts(events, score) {
  /** @type {Record<string, number>} */
  const total = {};
  for (const id of EVENT_METRICS) total[id] = 0;
  const side = [
    { goals: score[0], shots: 0, shotsOnTarget: 0 },
    { goals: score[1], shots: 0, shotsOnTarget: 0 },
  ];
  /** @type {Record<string, string>} */
  const byType = {};
  for (const [id, type] of Object.entries(EVENT_TYPE)) byType[type] = id;
  for (const ev of events) {
    const t = ev.teamIndex;
    if (ev.type === 'SHOT') {
      total.shots++;
      if (t === 0 || t === 1) side[t].shots++;
      if (ev.meta?.result === 'ON_TARGET') {
        total.shotsOnTarget++;
        if (t === 0 || t === 1) side[t].shotsOnTarget++;
      }
    } else if (ev.type in byType) {
      total[byType[ev.type]]++;
    }
  }
  total.goals = score[0] + score[1];
  return { total, home: side[0], away: side[1] };
}

/** @param {number[]} xs */
function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** @param {number[]} xs */
function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

/**
 * Standard errors of the simulated statistic a check allows for (see `check`): a check fails only when its value is
 * further outside the band than this many standard errors of the value itself (measured from the cohort's own
 * matches). A value the size of the band edge sits within normal seed-window variance of a run, so it passes; an
 * engine whose true mean drifted clearly out of the band still fails.
 */
export const SAMPLING_Z = 3;

/**
 * Band for a simulated rate around an empirical one: the empirical rate +- `floor` (the deviation accepted). The
 * run's own sampling error is allowed for by the check (`SAMPLING_Z`), not by the band.
 * @param {number} target
 * @param {number} [floor]
 * @returns {[number, number]}
 */
export function probabilityBand(target, floor = BAND_FLOORS.probability) {
  return [Math.max(0, target - floor), Math.min(1, target + floor)];
}

/** Standard error of a mean. @param {number[]} xs */
function meanSe(xs) {
  return xs.length < 2 ? 0 : sd(xs) / Math.sqrt(xs.length);
}

/** Standard error of a rate. @param {number} p @param {number} n */
function rateSe(p, n) {
  return Math.sqrt(Math.max(0, p * (1 - p)) / Math.max(1, n));
}

/**
 * Standard error of `homeWin - awayWin` (a per-match +1 / 0 / -1 outcome).
 * @param {number} homeWin
 * @param {number} awayWin
 * @param {number} n
 */
function edgeSe(homeWin, awayWin, n) {
  const d = homeWin - awayWin;
  return Math.sqrt(Math.max(0, homeWin + awayWin - d * d) / Math.max(1, n));
}

/**
 * Standard error of the difference of two ratio estimates, `sum(gH)/sum(sH) - sum(gL)/sum(sL)` (goals per shot on
 * target of each side), by linearisation per match (so the two sides' correlation is kept).
 * @param {Array<{gH: number, sH: number, gL: number, sL: number}>} xs
 */
function ratioDiffSe(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const sum = (/** @type {(x: (typeof xs)[number]) => number} */ f) => xs.reduce((t, x) => t + f(x), 0);
  const sH = sum((x) => x.sH) / n;
  const sL = sum((x) => x.sL) / n;
  if (sH <= 0 || sL <= 0) return 0;
  const rH = sum((x) => x.gH) / (sH * n);
  const rL = sum((x) => x.gL) / (sL * n);
  return meanSe(xs.map((x) => (x.gH - rH * x.sH) / sH - (x.gL - rL * x.sL) / sL));
}

/**
 * Morale bands, derived from the form ("morale") effect in the benchmark file:
 *  - win edge (P(confident side wins) - P(low-morale side wins)): at least
 *    MORALE_LIMITS.minWinEdge, so morale matters, and at most the smaller of
 *    MORALE_LIMITS.maxWinEdge and the raw hot-run-v-slump delta, which also
 *    contains the strength gap that form correlates with (equal ratings here);
 *  - goals per shot on target: from 0 up to twice the raw hot-v-slump
 *    conversion delta (the matched-strength delta sits inside);
 *  - goal difference: MORALE_LIMITS.minGoalDiff to MORALE_LIMITS.maxGoalDiff.
 * @param {any} bench resolved benchmarks
 */
export function moraleBands(bench) {
  const form = bench.formEffect;
  return {
    winEdge: /** @type {[number, number]} */ ([MORALE_LIMITS.minWinEdge, Math.min(MORALE_LIMITS.maxWinEdge, form.rawWinRateDelta)]),
    goalDiff: /** @type {[number, number]} */ ([MORALE_LIMITS.minGoalDiff, MORALE_LIMITS.maxGoalDiff]),
    conversionDelta: /** @type {[number, number]} */ ([0, 2 * form.rawConversionDelta]),
  };
}

/**
 * @param {string} id
 * @param {string} label
 * @param {number} value
 * @param {[number, number]} band
 * @param {string} [target] what the band is built around, for the report
 * @param {number} [se] standard error of `value` over the cohort's matches: the check allows `SAMPLING_Z` of them
 *   outside the band (`inBand` says whether the value is inside the band itself)
 */
function check(id, label, value, band, target = '', se = 0) {
  const tolerance = SAMPLING_Z * se;
  const inBand = value >= band[0] && value <= band[1];
  return { id, label, value, band, target, se, tolerance, inBand, pass: value >= band[0] - tolerance && value <= band[1] + tolerance };
}

/**
 * Evaluates one cohort. `rows` are per-match `matchCounts` results; home is the
 * favourite (strength cohorts) or the high-morale side (morale cohort).
 * @param {Cohort} cohort
 * @param {Array<ReturnType<typeof matchCounts>>} rows
 * @param {any} bench resolved benchmarks
 */
export function evaluateCohort(cohort, rows, bench) {
  const n = rows.length;
  const checks = [];
  const homeWin = mean(rows.map((r) => (r.home.goals > r.away.goals ? 1 : 0)));
  const draw = mean(rows.map((r) => (r.home.goals === r.away.goals ? 1 : 0)));
  const awayWin = 1 - homeWin - draw;
  const gd = rows.map((r) => r.home.goals - r.away.goals);
  const shotShares = rows.filter((r) => r.home.shots + r.away.shots > 0).map((r) => r.home.shots / (r.home.shots + r.away.shots));

  /** @type {Record<string, number>} */
  const eventMeans = {};
  for (const id of EVENT_METRICS) eventMeans[id] = mean(rows.map((r) => r.total[id]));

  if (cohort.eventBands) {
    for (const id of EVENT_METRICS) {
      const ref = bench.eventFrequencies[id];
      checks.push(check(`events.${id}`, `${id} per match`, eventMeans[id], ref.band, `Big-5 mean ${ref.mean}`, meanSe(rows.map((r) => r.total[id]))));
    }
  }

  if (cohort.tier === 'even') {
    const t = bench.strengthTiers.even;
    checks.push(check('result.draw', 'draw rate', draw, probabilityBand(t.draw), `even-odds tier draw ${t.draw}`, rateSe(draw, n)));
    const symHalf = BAND_FLOORS.symmetry;
    checks.push(check('result.symmetry', 'home win - away win', homeWin - awayWin, [-symHalf, symHalf], 'no structural home or away edge', edgeSe(homeWin, awayWin, n)));
  } else if (cohort.tier !== null) {
    const t = bench.strengthTiers[cohort.tier];
    checks.push(check('result.favWin', 'favourite win', homeWin, probabilityBand(t.favWin), `${cohort.tier} tier ${t.favWin}`, rateSe(homeWin, n)));
    checks.push(check('result.draw', 'draw', draw, probabilityBand(t.draw), `${cohort.tier} tier ${t.draw}`, rateSe(draw, n)));
    checks.push(check('result.dogWin', 'underdog (upset) win', awayWin, probabilityBand(t.dogWin), `${cohort.tier} tier ${t.dogWin}`, rateSe(awayWin, n)));
    const gdHalf = BAND_FLOORS.goalDiff;
    checks.push(check('result.goalDiff', 'favourite goal difference', mean(gd), [t.goalDiff - gdHalf, t.goalDiff + gdHalf], `${cohort.tier} tier ${t.goalDiff}`, meanSe(gd)));
    checks.push(check('result.shotShare', 'favourite shot share', mean(shotShares), [t.favShotShare - BAND_FLOORS.shotShare, t.favShotShare + BAND_FLOORS.shotShare], `${cohort.tier} tier ${t.favShotShare}`, meanSe(shotShares)));
  }

  if (cohort.morale) {
    const b = moraleBands(bench);
    const sum = (/** @type {(r: ReturnType<typeof matchCounts>) => number} */ f) => rows.reduce((s, r) => s + f(r), 0);
    const convHigh = sum((r) => r.home.goals) / Math.max(1, sum((r) => r.home.shotsOnTarget));
    const convLow = sum((r) => r.away.goals) / Math.max(1, sum((r) => r.away.shotsOnTarget));
    const convSe = ratioDiffSe(rows.map((r) => ({ gH: r.home.goals, sH: r.home.shotsOnTarget, gL: r.away.goals, sL: r.away.shotsOnTarget })));
    checks.push(check('morale.winEdge', 'win edge (high - low morale)', homeWin - awayWin, b.winEdge, `raw hot-v-slump ${bench.formEffect.rawWinRateDelta}`, edgeSe(homeWin, awayWin, n)));
    checks.push(check('morale.goalDiff', 'goal difference (high - low)', mean(gd), b.goalDiff, 'bounded edge', meanSe(gd)));
    checks.push(check('morale.conversion', 'goals per shot on target (high - low)', convHigh - convLow, b.conversionDelta, `matched-strength ${bench.formEffect.matchedStrength.conversionDelta}`, convSe));
  }

  return {
    id: cohort.id,
    label: cohort.label,
    matches: n,
    results: { homeWin, draw, awayWin, goalDiff: mean(gd), shotShare: mean(shotShares) },
    eventMeans,
    // Report only: never part of `pass`.
    diagnostics: summarizeDiagnostics(/** @type {any} */ (rows)),
    outliers: outlierSeeds(/** @type {any} */ (rows.filter((r) => /** @type {any} */ (r).seed !== undefined))),
    checks,
    pass: checks.every((c) => c.pass),
  };
}

/**
 * @param {Array<ReturnType<typeof evaluateCohort>>} cohorts
 * @param {Record<string, any>} [meta]
 */
export function summarizeSuite(cohorts, meta = {}) {
  const ok = cohorts.every((c) => c.pass);
  return { ok, exitCode: ok ? 0 : 1, meta, cohorts };
}

/** @param {number} v @param {number} [d] */
function fmt(v, d = 3) {
  return Number.isFinite(v) ? v.toFixed(d) : '-';
}

/**
 * Report-only diagnostic rows (never gate the exit code): throw-ins, passing, tilt, pressing, each side's
 * shots, and the three seeds furthest from the cohort mean.
 * @param {ReturnType<typeof evaluateCohort>} c
 * @returns {string[]}
 */
export function formatDiagnostics(c) {
  const d = c.diagnostics;
  if (!d) return [];
  const r = d.rows;
  const lines = ['Diagnostics (reported, not gated):', '', '| Diagnostic | Per match |', '| :--- | ---: |'];
  const rowsOut = /** @type {Array<[string, string]>} */ ([
    ['throw-ins', fmt(r.throwIns, 2)],
    ['shots, favourite / home', fmt(d.home.shots, 2)],
    ['shots on target, favourite / home', fmt(d.home.shotsOnTarget, 2)],
    ['shots, other side', fmt(d.away.shots, 2)],
    ['shots on target, other side', fmt(d.away.shotsOnTarget, 2)],
    ['xG (both sides)', fmt(r.xG, 2)],
    ['passes (both sides)', fmt(r.passes, 1)],
    ['pass completion %', fmt(r.passCompletionPct, 1)],
    ['progressive passes', fmt(r.progressivePasses, 1)],
    ['interceptions', fmt(r.interceptions, 2)],
    ['miscontrols', fmt(r.miscontrols, 2)],
    ['shots in box %', fmt(r.shotsInBoxPct, 1)],
    ['field tilt % (home)', fmt(r.fieldTiltPct, 1)],
    ['PPDA', fmt(r.ppda, 2)],
  ]);
  for (const [k, v] of rowsOut) lines.push(`| ${k} | ${v} |`);
  if (c.outliers.length > 0) {
    lines.push('');
    lines.push(`Outlier seeds (goals and shots furthest from the mean): ${c.outliers.map((o) => `#${o.seed} (${o.goals} goals, ${o.shots} shots)`).join(', ')}`);
  }
  lines.push('');
  return lines;
}

/**
 * @param {ReturnType<typeof summarizeSuite>} report
 * @returns {string}
 */
export function formatCohortReport(report) {
  const m = report.meta ?? {};
  const lines = [];
  lines.push(`# freefoot Cohort Calibration (${report.ok ? 'PASS' : 'FAIL'})`);
  lines.push('');
  lines.push(`- **Engine version:** ${m.engineVersion ?? 'unknown'}`);
  lines.push(`- **Config hash:** \`${m.configHash ?? 'unknown'}\``);
  lines.push(`- **Seeds:** ${m.seedStart ?? '?'}..${m.seedEnd ?? '?'} (${m.matches ?? '?'} matches per cohort)`);
  lines.push(`- **Benchmarks:** ${m.benchmarks ?? 'unknown'}`);
  lines.push(
    `- **Gate:** a check fails when its value is outside its band by more than ${SAMPLING_Z} standard errors of the value over this run's matches (its sampling allowance); PASS* marks a value outside the band but within that allowance.`,
  );
  lines.push('');
  for (const c of report.cohorts) {
    lines.push(`## ${c.label} — ${c.pass ? 'PASS' : 'FAIL'}`);
    lines.push('');
    const r = c.results;
    lines.push(`Home ${fmt(r.homeWin)} · draw ${fmt(r.draw)} · away ${fmt(r.awayWin)} · goal difference ${fmt(r.goalDiff, 2)} · home shot share ${fmt(r.shotShare)}`);
    lines.push('');
    lines.push(`| Check | Value | Band | Sampling allowance (${SAMPLING_Z} SE) | Reference | Status |`);
    lines.push('| :--- | ---: | :---: | ---: | :--- | :---: |');
    for (const k of c.checks) {
      // PASS*: outside the band, but within the run's sampling error of it (watch it; a drift would fail).
      const status = !k.pass ? 'FAIL' : k.inBand ? 'PASS' : 'PASS*';
      lines.push(`| ${k.label} | ${fmt(k.value)} | ${fmt(k.band[0])}–${fmt(k.band[1])} | ±${fmt(k.tolerance)} | ${k.target} | ${status} |`);
    }
    if (!c.checks.some((k) => k.id.startsWith('events.'))) {
      lines.push('');
      lines.push(`Event frequencies (reported, not gated): ${EVENT_METRICS.map((id) => `${id} ${fmt(c.eventMeans[id], 2)}`).join(', ')}`);
    }
    lines.push('');
    lines.push(...formatDiagnostics(c));
  }
  lines.push('---');
  lines.push('_Benchmarks: football-data.co.uk (results, statistics, closing odds) and StatsBomb Open Data (offsides, penalties, injuries)._');
  return lines.join('\n') + '\n';
}

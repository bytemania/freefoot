// Offline StatsBomb reference extractor (design item 26a, §18a).
//
// Usage: node scripts/build-reference.mjs [<statsbomb-dir>]
// Reads the 2015/16 top-five European league seasons, computes per-team
// metrics with our own config/xg.yaml model and open-play pass share
// possession definition, derives Scenario A (all teams) and Scenario B
// (top-4 vs bottom-4) statistics plus bootstrap 90% CIs, warns if any
// reference mean falls outside bandA, and updates only the `reference` fields
// of config/calibration/targets.yaml.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { nextUint32 } from '../src/engine/rng/sfc32.js';
import { seedSfc32 } from '../src/engine/rng/streams.js';
import { mean, percentile, summarize } from '../src/shared/stats.js';
import {
  computeStandings,
  extractMatchMetrics,
  loadAllowListCompetitions,
  loadMatchEvents,
  loadSeasonMatches,
} from './lib/statsbomb.mjs';

const EXTRACTOR_VERSION = '1.0.0';
const BOOTSTRAP_RESAMPLES = 2000;
const HARD_TEAM_METRICS = [
  'goals',
  'xG',
  'shots',
  'shotsOnTarget',
  'possessionPct',
  'passes',
  'passCompletionPct',
  'foulsCommitted',
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sbDir = path.resolve(process.argv[2] ?? path.join(repoRoot, '.cache', 'statsbomb-open-data'));

const xgDoc = parseDocument(readFileSync(path.join(repoRoot, 'config', 'xg.yaml'), 'utf8'));
const xgConfig = xgDoc.toJS();

const { found, missing } = loadAllowListCompetitions(sbDir);
for (const c of found) {
  console.log(`reference: found ${c.competition_name} ${c.season_name} (comp ${c.competition_id}, season ${c.season_id})`);
}
for (const c of missing) {
  console.warn(`reference: WARNING missing ${c.label} (comp ${c.competition_id}, season ${c.season_id})`);
}
if (found.length === 0) {
  console.error(`reference: no allow-list competitions found in ${sbDir}`);
  process.exit(1);
}

/** @type {Record<string, number>[]} */
const rowsA = [];
/** @type {Record<string, number>[]} */
const rowsBStrong = [];
/** @type {Record<string, number>[]} */
const rowsBWeak = [];
/** @type {number[]} */
const bXgShares = [];
/** @type {number[]} */
const bStrongWins = [];

for (const comp of found) {
  const matches = loadSeasonMatches(sbDir, comp.competition_id, comp.season_id);
  const standings = computeStandings(matches);
  const top4 = new Set(standings.slice(0, 4).map((s) => s.teamId));
  const bottom4 = new Set(standings.slice(-4).map((s) => s.teamId));

  let compRows = 0;
  let compBMatches = 0;
  for (const m of matches) {
    const events = loadMatchEvents(sbDir, m.match_id);
    if (!events) continue;
    const homeId = m.home_team.home_team_id;
    const awayId = m.away_team.away_team_id;
    const { home, away } = extractMatchMetrics(events, homeId, awayId, xgConfig);
    rowsA.push(home, away);
    compRows += 2;

    const homeTop = top4.has(homeId);
    const awayTop = top4.has(awayId);
    const homeBot = bottom4.has(homeId);
    const awayBot = bottom4.has(awayId);
    if ((homeTop && awayBot) || (awayTop && homeBot)) {
      const strong = homeTop ? home : away;
      const weak = homeTop ? away : home;
      rowsBStrong.push(strong);
      rowsBWeak.push(weak);
      const totalXg = strong.xG + weak.xG;
      bXgShares.push(totalXg > 0 ? strong.xG / totalXg : 0.5);
      bStrongWins.push(strong.goals > weak.goals ? 1 : 0);
      compBMatches++;
    }
  }
  console.log(`reference: ${comp.label}: ${compRows / 2} matches (${compRows} team rows, ${compBMatches} top-4 vs bottom-4 matches)`);
}

/**
 * Bootstrap 90% confidence intervals for mean, p10 and p90 using sfc32 seeded
 * with 1 (design item 26a).
 * @param {number[]} values
 * @param {Uint32Array} rng
 * @returns {{meanCi: [number, number], p10Ci: [number, number], p90Ci: [number, number]}}
 */
function bootstrapCi90(values, rng) {
  const n = values.length;
  if (n === 0) return { meanCi: [0, 0], p10Ci: [0, 0], p90Ci: [0, 0] };
  const sample = new Array(n);
  const means = new Array(BOOTSTRAP_RESAMPLES);
  const p10s = new Array(BOOTSTRAP_RESAMPLES);
  const p90s = new Array(BOOTSTRAP_RESAMPLES);
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = values[nextUint32(rng) % n];
      sample[i] = v;
      sum += v;
    }
    sample.sort((a, c) => a - c);
    means[b] = sum / n;
    p10s[b] = percentile(sample, 0.1);
    p90s[b] = percentile(sample, 0.9);
  }
  means.sort((a, c) => a - c);
  p10s.sort((a, c) => a - c);
  p90s.sort((a, c) => a - c);
  return {
    meanCi: [percentile(means, 0.05), percentile(means, 0.95)],
    p10Ci: [percentile(p10s, 0.05), percentile(p10s, 0.95)],
    p90Ci: [percentile(p90s, 0.05), percentile(p90s, 0.95)],
  };
}

/** @param {number} v */
const r = (v) => Number(v.toFixed(4));

const rng = seedSfc32(new Uint32Array(4), 1);

const targetsPath = path.join(repoRoot, 'config', 'calibration', 'targets.yaml');
const targetsDoc = parseDocument(readFileSync(targetsPath, 'utf8'));
const targetsData = targetsDoc.toJS();

console.log(`\n=== Scenario A reference (${rowsA.length} team rows, ${rowsA.length / 2} matches) ===`);
for (const id of HARD_TEAM_METRICS) {
  const values = rowsA.map((row) => row[id]);
  const s = summarize(values);
  const ci = bootstrapCi90(values, rng);
  console.log(
    `  ${id.padEnd(18)} mean=${r(s.mean)} (90% CI [${r(ci.meanCi[0])}, ${r(ci.meanCi[1])}]) ` +
      `p10=${r(s.p10)} [${r(ci.p10Ci[0])}, ${r(ci.p10Ci[1])}] ` +
      `p90=${r(s.p90)} [${r(ci.p90Ci[0])}, ${r(ci.p90Ci[1])}]`,
  );

  const idx = targetsData.metrics.findIndex((/** @type {any} */ m) => m.id === id);
  if (idx >= 0) {
    const bandA = targetsData.metrics[idx].bandA;
    if (Array.isArray(bandA) && (s.mean < bandA[0] || s.mean > bandA[1])) {
      console.warn(`  WARNING: ${id} reference mean ${r(s.mean)} falls outside bandA [${bandA[0]}, ${bandA[1]}]!`);
    }
    targetsDoc.setIn(['metrics', idx, 'reference'], {
      mean: r(s.mean),
      p10: r(s.p10),
      p90: r(s.p90),
      ci90: [r(ci.meanCi[0]), r(ci.meanCi[1])],
      source: 'statsbomb-2015-16-top5',
      extractorVersion: EXTRACTOR_VERSION,
      rows: rowsA.length,
    });
  }
}

console.log(`\n=== Scenario B reference (top-4 vs bottom-4: ${rowsBStrong.length} matches) ===`);
const bPossStrong = summarize(rowsBStrong.map((row) => row.possessionPct));
const bXgStrong = summarize(rowsBStrong.map((row) => row.xG));
const bXgWeak = summarize(rowsBWeak.map((row) => row.xG));
const bShareMean = mean(bXgShares);
const bWinRate = mean(bStrongWins);
const bWinCi = bootstrapCi90(bStrongWins, rng);

console.log(`  strong possessionPct: mean=${r(bPossStrong.mean)} p10=${r(bPossStrong.p10)} p90=${r(bPossStrong.p90)}`);
console.log(`  strong xG:            mean=${r(bXgStrong.mean)} p10=${r(bXgStrong.p10)} p90=${r(bXgStrong.p90)}`);
console.log(`  weak xG:              mean=${r(bXgWeak.mean)} p10=${r(bXgWeak.p10)} p90=${r(bXgWeak.p90)}`);
console.log(`  strong xG share:      mean=${r(bShareMean)}`);
console.log(`  strong win rate:      mean=${r(bWinRate)} (90% CI [${r(bWinCi.meanCi[0])}, ${r(bWinCi.meanCi[1])}])`);

const winIdx = targetsData.metrics.findIndex((/** @type {any} */ m) => m.id === 'strongWinRate');
if (winIdx >= 0) {
  targetsDoc.setIn(['metrics', winIdx, 'reference'], {
    mean: r(bWinRate),
    p10: 0,
    p90: 1,
    ci90: [r(bWinCi.meanCi[0]), r(bWinCi.meanCi[1])],
    source: 'statsbomb-2015-16-top5-top4-vs-bottom4',
    extractorVersion: EXTRACTOR_VERSION,
    rows: rowsBStrong.length,
  });
}

writeFileSync(targetsPath, String(targetsDoc));
console.log(`\nreference: updated ${path.relative(repoRoot, targetsPath)}`);

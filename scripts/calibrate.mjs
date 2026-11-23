#!/usr/bin/env node
// Strength- and morale-aware cohort calibration against the Big-5 benchmarks.
//
// Usage: node scripts/calibrate.mjs [--matches 200] [--cohort all|even|moderate|heavy|morale]
//          [--seed-start 1] [--benchmarks config/benchmarks/top5-10yr.json] [--no-write]
//
// Plays each cohort (src/calibration/cohorts.js) across a worker_threads pool,
// checks the ten event frequencies, the closing-odds win / draw / upset curves
// and the morale edge, writes reports/cohorts-<date>-<configHash8>.{json,md},
// prints the Markdown report and exits 1 when any check fails. When the
// benchmark file is missing (CI without network), the built-in fallback
// bounds are used. Run `node scripts/fetch-league-benchmarks.mjs` to refresh it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { configHash, configHash8 } from '#generated/config.js';
import { ENGINE_VERSION } from '../src/engine/MatchEngine.js';
import { COHORTS, evaluateCohort, formatCohortReport, resolveBenchmarks, summarizeSuite } from '../src/calibration/cohorts.js';
import { TIMING_BUCKETS, TIMING_KINDS, blankTiming, formatTimingTable } from '../src/calibration/timing.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerUrl = new URL('../src/calibration/cohort-worker.js', import.meta.url);

const { values: args } = parseArgs({
  options: {
    matches: { type: 'string', default: '200' },
    cohort: { type: 'string', default: 'all' },
    'seed-start': { type: 'string', default: '1' },
    benchmarks: { type: 'string', default: path.join('config', 'benchmarks', 'top5-10yr.json') },
    'no-write': { type: 'boolean', default: false },
  },
});

const matchCount = Number(args.matches);
const seedStart = Number(args['seed-start']);
if (!Number.isInteger(matchCount) || matchCount < 1) {
  console.error(`calibrate: --matches must be a positive integer (got "${args.matches}")`);
  process.exit(2);
}
const chosen = args.cohort === 'all' ? COHORTS : COHORTS.filter((c) => c.id === args.cohort);
if (chosen.length === 0) {
  console.error(`calibrate: --cohort must be all or one of ${COHORTS.map((c) => c.id).join(', ')} (got "${args.cohort}")`);
  process.exit(2);
}

const benchPath = path.resolve(repoRoot, args.benchmarks);
let raw = null;
if (existsSync(benchPath)) {
  try {
    raw = JSON.parse(readFileSync(benchPath, 'utf8'));
  } catch (err) {
    console.warn(`calibrate: cannot parse ${args.benchmarks}: ${/** @type {Error} */ (err).message}`);
  }
}
const bench = resolveBenchmarks(raw);
const benchLabel = bench.fallback
  ? 'built-in fallback bounds (benchmark file missing or invalid)'
  : `${path.relative(repoRoot, benchPath)} (${bench.sources?.footballData?.matches ?? '?'} football-data matches, ${bench.sources?.statsbomb?.matches ?? '?'} StatsBomb matches)`;
if (bench.fallback) console.warn(`calibrate: using ${benchLabel}`);

/**
 * @param {import('../src/calibration/cohorts.js').Cohort} cohort
 * @param {number[]} seeds
 * @returns {Promise<any[]>}
 */
function runCohort(cohort, seeds) {
  const workers = Math.min(os.availableParallelism(), seeds.length);
  /** @type {number[][]} */
  const chunks = Array.from({ length: workers }, () => []);
  seeds.forEach((s, i) => chunks[i % workers].push(s));
  return Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          const w = new Worker(workerUrl, { workerData: { cohort, seeds: chunk } });
          w.on('message', resolve);
          w.on('error', reject);
          w.on('exit', (code) => {
            if (code !== 0) reject(new Error(`worker exited with code ${code}`));
          });
        }),
    ),
  ).then((parts) => parts.flat().sort((a, b) => a.seed - b.seed));
}

const seeds = Array.from({ length: matchCount }, (_, i) => seedStart + i);
const t0 = performance.now();
const evaluated = [];
const timing = blankTiming();
let timingMatches = 0;
for (const cohort of chosen) {
  const rows = await runCohort(cohort, seeds);
  for (const row of rows) {
    for (const kind of TIMING_KINDS) for (const b of TIMING_BUCKETS) timing[kind][b] += row.timing?.[kind]?.[b] ?? 0;
    timingMatches++;
  }
  evaluated.push(evaluateCohort(cohort, rows, bench));
  console.log(`calibrate: ${cohort.id} done (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

const report = summarizeSuite(evaluated, {
  engineVersion: ENGINE_VERSION,
  configHash,
  configHash8,
  seedStart,
  seedEnd: seedStart + matchCount - 1,
  matches: matchCount,
  benchmarks: benchLabel,
  date: new Date().toISOString().slice(0, 10),
  elapsedSeconds: Math.round((performance.now() - t0) / 100) / 10,
});

// Report only: the timing table never changes the exit code.
const tb = bench.timing;
const timingText = formatTimingTable(
  timing,
  timingMatches,
  tb
    ? {
        goals: { matches: tb.league.matches, counts: tb.league.goals.counts },
        shots: { matches: tb.league.matches, counts: tb.league.shots.counts },
        yellowCards: { matches: tb.league.matches, counts: tb.league.yellowCards.counts },
        redCards: { matches: tb.league.matches, counts: tb.league.redCards.counts },
        substitutions: { matches: tb.fiveSubEra.matches, counts: tb.fiveSubEra.substitutions.counts },
      }
    : null,
);

if (!args['no-write']) {
  const dir = path.join(repoRoot, 'reports');
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `cohorts-${report.meta.date}-${configHash8}`);
  writeFileSync(`${base}.json`, JSON.stringify({ ...report, timing: { matches: timingMatches, counts: timing } }, null, 2) + '\n');
  writeFileSync(`${base}.md`, `${formatCohortReport(report)}\n${timingText}\n`);
  console.log(`calibrate: wrote ${path.relative(repoRoot, base)}.md and .json`);
}
console.log('');
console.log(formatCohortReport(report));
console.log('');
console.log(timingText);
process.exit(report.exitCode);

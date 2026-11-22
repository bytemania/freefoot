/**
 * Calibration runner (design §18, item 72, CUJ 4).
 *
 * Usage: node src/calibration/run.js [--scenario A|B|all] [--matches N] [--seed-start S]
 * Splits seeds across `os.availableParallelism()` worker threads, merges
 * per-match metric rows, writes JSON + Markdown reports under `reports/`,
 * prints a concise summary, and exits non-zero on any hard gate failure.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { config, configHash, configHash8 } from '#generated/config.js';
import { ENGINE_VERSION } from '../engine/MatchEngine.js';
import { evaluateCalibration, formatMarkdownReport, writeReports } from './report.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workerUrl = new URL('./worker.js', import.meta.url);

const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'all' },
    matches: { type: 'string' },
    'seed-start': { type: 'string' },
    'no-write': { type: 'boolean', default: false },
  },
});

const scenarioArg = args.scenario;
if (scenarioArg !== 'A' && scenarioArg !== 'B' && scenarioArg !== 'all') {
  console.error(`calibrate: --scenario must be A, B, or all (got "${scenarioArg}")`);
  process.exit(2);
}

const seedRange = config.calibration.scenarios.seedRange;
const matchCount = args.matches ? Number(args.matches) : seedRange.count;
const seedStart = args['seed-start'] ? Number(args['seed-start']) : seedRange.start;
if (!Number.isInteger(matchCount) || matchCount < 1) {
  console.error(`calibrate: --matches must be a positive integer (got "${args.matches}")`);
  process.exit(2);
}

/**
 * Runs one scenario across a worker_threads pool.
 * @param {'A' | 'B'} scenario
 * @param {number[]} seeds
 * @returns {Promise<any[]>}
 */
function runScenario(scenario, seeds) {
  const numWorkers = Math.min(os.availableParallelism(), seeds.length);
  /** @type {number[][]} */
  const chunks = Array.from({ length: numWorkers }, () => []);
  for (let i = 0; i < seeds.length; i++) chunks[i % numWorkers].push(seeds[i]);

  return Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(workerUrl, { workerData: { scenario, seeds: chunk } });
          worker.on('message', resolve);
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`worker exited with code ${code}`));
          });
        }),
    ),
  ).then((parts) => parts.flat().sort((a, b) => a.seed - b.seed));
}

const seeds = Array.from({ length: matchCount }, (_, i) => seedStart + i);
const t0 = performance.now();

const scenarioA = scenarioArg === 'A' || scenarioArg === 'all' ? await runScenario('A', seeds) : null;
const scenarioB = scenarioArg === 'B' || scenarioArg === 'all' ? await runScenario('B', seeds) : null;

const elapsedS = ((performance.now() - t0) / 1000).toFixed(1);
const date = new Date().toISOString().slice(0, 10);

const report = evaluateCalibration({
  scenarioA,
  scenarioB,
  targets: config.calibration.targets,
  meta: {
    engineVersion: ENGINE_VERSION,
    configHash,
    configHash8,
    seedStart,
    seedEnd: seedStart + matchCount - 1,
    matches: matchCount,
    scenario: scenarioArg,
    date,
    elapsedSeconds: Number(elapsedS),
  },
});

if (!args['no-write']) {
  const { jsonPath, mdPath } = writeReports(report, path.join(repoRoot, 'reports'));
  console.log(`calibrate: wrote ${path.relative(repoRoot, mdPath)} and ${path.relative(repoRoot, jsonPath)} (${elapsedS}s)`);
}

console.log('');
console.log(formatMarkdownReport(report));
process.exit(report.exitCode);

#!/usr/bin/env node
// Instructions calibration cohort (docs/designs/tactics_instructions.md, src/calibration/instructions.js).
//
// Usage: node scripts/calibrate-instructions.mjs [--seeds 300] [--seed-start 1] [--only tempo|tempo.fast,marking] [--no-write]
//
// For every non-default option of every team instruction in config/tactics.yaml, plays --seeds seeds twice (the
// option at home, then away; 80 v 80 OVR AI matches) across a worker_threads pool, and checks that the mean goal
// difference stays within +-0.15 per match and that the declared upside and downside each move the declared way
// (paired z >= 2). Writes reports/instructions-<date>-<configHash8>.{json,md}, prints the Markdown report and exits
// 1 when any check fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { config, configHash, configHash8 } from '#generated/config.js';
import { ENGINE_VERSION } from '../src/engine/MatchEngine.js';
import { evaluateVariant, formatInstructionsReport, instructionVariants } from '../src/calibration/instructions.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerUrl = new URL('../src/calibration/instructions-worker.js', import.meta.url);

const { values: args } = parseArgs({
  options: {
    seeds: { type: 'string', default: '300' },
    'seed-start': { type: 'string', default: '1' },
    only: { type: 'string', default: '' },
    'no-write': { type: 'boolean', default: false },
  },
});

const seedCount = Number(args.seeds);
const seedStart = Number(args['seed-start']);
if (!Number.isInteger(seedCount) || seedCount < 2) {
  console.error(`calibrate-instructions: --seeds must be an integer >= 2 (got "${args.seeds}")`);
  process.exit(2);
}
const all = instructionVariants(config.tactics.instructions);
const only = args.only ? args.only.split(',') : [];
const variants = only.length > 0 ? all.filter((v) => only.includes(v.id) || only.includes(v.instruction)) : all;
if (variants.length === 0) {
  console.error(`calibrate-instructions: --only must name instructions or options, comma-separated (${all.map((v) => v.id).join(', ')})`);
  process.exit(2);
}

const seeds = Array.from({ length: seedCount }, (_, i) => seedStart + i);
const CHUNK = 5;
/** @type {Array<{variant: (typeof variants)[number], seeds: number[]}>} */
const tasks = [];
for (const variant of variants) for (let i = 0; i < seeds.length; i += CHUNK) tasks.push({ variant, seeds: seeds.slice(i, i + CHUNK) });

/** @type {Map<string, any[]>} */
const rowsByVariant = new Map(variants.map((v) => [v.id, []]));
const t0 = performance.now();
let next = 0;
let done = 0;

/** Runs tasks one after another on one worker thread at a time. */
async function lane() {
  while (next < tasks.length) {
    const task = tasks[next++];
    const rows = await new Promise((resolve, reject) => {
      const w = new Worker(workerUrl, { workerData: { instruction: task.variant.instruction, option: task.variant.option, seeds: task.seeds } });
      w.on('message', resolve);
      w.on('error', reject);
      w.on('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exited with code ${code}`));
      });
    });
    rowsByVariant.get(task.variant.id)?.push(...rows);
    done++;
    if (done % 10 === 0 || done === tasks.length) console.log(`calibrate-instructions: ${done}/${tasks.length} tasks (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
  }
}

await Promise.all(Array.from({ length: Math.min(os.availableParallelism(), tasks.length) }, lane));

const results = variants.map((v) => evaluateVariant(v, (rowsByVariant.get(v.id) ?? []).sort((a, b) => a.seed - b.seed || a.optionSide - b.optionSide)));
const meta = {
  engineVersion: ENGINE_VERSION,
  configHash,
  configHash8,
  seedStart,
  seedEnd: seedStart + seedCount - 1,
  matches: seedCount * 2,
  date: new Date().toISOString().slice(0, 10),
  elapsedSeconds: Math.round((performance.now() - t0) / 100) / 10,
};
const text = formatInstructionsReport(results, meta);
const ok = results.every((r) => r.pass);

if (!args['no-write']) {
  const dir = path.join(repoRoot, 'reports');
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `instructions-${meta.date}-${configHash8}`);
  writeFileSync(`${base}.json`, JSON.stringify({ ok, meta, results }, null, 2) + '\n');
  writeFileSync(`${base}.md`, `${text}\n`);
  console.log(`calibrate-instructions: wrote ${path.relative(repoRoot, base)}.md and .json`);
}
console.log('');
console.log(text);
process.exit(ok ? 0 : 1);

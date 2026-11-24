#!/usr/bin/env node
// Same-seed A/B diff: plays one seed with the shipped config and again with weight overrides.
//
// Usage: node scripts/ab-diff.mjs --seed 42 --override w.shot.boxFree=0.0 [--override ...] [--ticks N]
//
// A path may start at the config (`weights.decision.w.shot.boxFree`), the weights file
// (`decision.w.shot.boxFree`) or its decision section (`w.shot.boxFree`). The config is deep-cloned
// before the engine builds its tick config, so the shipped config is never changed.
import { parseArgs } from 'node:util';
import { config, configHash } from '#generated/config.js';
import { abDiff, formatAbDiff, parseOverride } from '../src/calibration/abdiff.js';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '1' },
    override: { type: 'string', multiple: true, default: [] },
    ticks: { type: 'string' },
  },
});
const seed = Number(values.seed);
if (!Number.isInteger(seed)) {
  console.error(`ab-diff: --seed must be an integer (got "${values.seed}")`);
  process.exit(2);
}
try {
  const overrides = (values.override ?? []).map(parseOverride);
  const result = abDiff({ config, configHash, seed, overrides, maxTicks: values.ticks === undefined ? undefined : Number(values.ticks) });
  console.log(formatAbDiff(result));
} catch (err) {
  console.error(`ab-diff: ${/** @type {Error} */ (err).message}`);
  process.exit(2);
}

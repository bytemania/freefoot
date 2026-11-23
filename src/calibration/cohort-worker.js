/**
 * Cohort calibration worker (scripts/calibrate.mjs). Plays the assigned seeds
 * of one cohort headless (both teams AI) and posts back per-match counts.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { config, configHash } from '#generated/config.js';
import { MatchEngine } from '../engine/MatchEngine.js';
import { generateRatedSquad } from '../shared/squadgen.js';
import { matchCounts } from './cohorts.js';

const { cohort, seeds } = /** @type {{cohort: import('./cohorts.js').Cohort, seeds: number[]}} */ (workerData);

/**
 * @param {number} seed
 */
function playMatch(seed) {
  const home = generateRatedSquad(cohort.home.ovr, (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', morale: cohort.home.morale });
  const away = generateRatedSquad(cohort.away.ovr, (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', morale: cohort.away.morale });
  const engine = MatchEngine.create({ v: 1, seed, configHash, home, away }, config);
  while (true) {
    const r = engine.step(200);
    if (r.stoppedFor === 'FULL_TIME' || r.stoppedFor === 'FORCED_DECISION') break;
  }
  const s = engine.state;
  return { seed, ...matchCounts(engine.eventLog, [s.teams[0].score, s.teams[1].score]) };
}

parentPort?.postMessage(seeds.map(playMatch));

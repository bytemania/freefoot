/**
 * Node performance benchmark (design §18b, item 74, G4).
 *
 * Runs 20 full matches (Scenario A) and reports:
 * - mean engine ms per 20-tick window (compared against the 0.33 ms estimate)
 * - mean time to re-simulate a full match (ms)
 * Exits non-zero only when mean engine ms per 20 ticks exceeds 1.0 ms (CI ceiling).
 */
import { config, configHash, configHash8 } from '#generated/config.js';
import { ENGINE_VERSION, MatchEngine } from '../engine/MatchEngine.js';
import { generateSquad } from '../shared/squadgen.js';

const MATCHES = 20;
const WINDOW_TICKS = 20;
const CI_CEILING_MS = 1.0;
const TARGET_ESTIMATE_MS = 0.33;

let totalTicks = 0;
let totalMs = 0;

for (let i = 0; i < MATCHES; i++) {
  const seed = i + 1;
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  const input = { v: /** @type {const} */ (1), seed, configHash, home, away };
  const engine = MatchEngine.create(input, config);

  const t0 = performance.now();
  while (true) {
    const r = engine.step(WINDOW_TICKS);
    totalTicks += r.ticksRun;
    if (r.stoppedFor === 'FULL_TIME' || r.stoppedFor === 'FORCED_DECISION') break;
  }
  totalMs += performance.now() - t0;
}

const windows = totalTicks / WINDOW_TICKS;
const msPer20Ticks = windows > 0 ? totalMs / windows : 0;
const msPerMatch = totalMs / MATCHES;
const pass = msPer20Ticks <= CI_CEILING_MS;

console.log(
  `bench: engine ${ENGINE_VERSION} config ${configHash8} | ${MATCHES} matches, ${totalTicks} ticks`,
);
console.log(
  `bench: mean ${msPer20Ticks.toFixed(4)} ms / 20 ticks ` +
    `(estimate <= ${TARGET_ESTIMATE_MS} ms, CI ceiling ${CI_CEILING_MS.toFixed(1)} ms) | ` +
    `full match ${msPerMatch.toFixed(1)} ms -> ${pass ? 'PASS' : 'FAIL'}`,
);

process.exit(pass ? 0 : 1);

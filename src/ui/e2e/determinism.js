/**
 * Dev-only cross-engine determinism harness (design item 85b).
 * Exposes `window.runGolden(goldenData)` for Playwright to verify that
 * Chromium produces the exact same per-tick state hashes as Node.
 */
import { config, configHash } from '#generated/config.js';
import { MatchEngine } from '../../engine/MatchEngine.js';

/**
 * Runs one golden seed to FULL_TIME, matching `tests/engine/helpers.js` `runMatch`.
 * @param {any} input
 * @param {any[]} log
 * @param {number} every
 */
function runMatch(input, log, every) {
  const engine = MatchEngine.create(input, config);
  /** @type {string[]} */
  const hashes = [];
  const human = log.filter((e) => e.issuer === 'human').sort((a, b) => a.seq - b.seq);
  let next = 0;
  for (;;) {
    while (next < human.length && human[next].tick <= engine.tick) {
      const e = human[next++];
      engine.applyCommand({ issuer: 'human', type: e.type, teamIndex: e.teamIndex, payload: e.payload });
    }
    const target = Math.min(1000, every - (engine.tick % every));
    const r = engine.step(target);
    if (r.ticksRun > 0 && engine.tick % every === 0) {
      hashes.push(engine.hash().toString(16).padStart(8, '0'));
    }
    if (r.stoppedFor === 'FULL_TIME') break;
    if (r.stoppedFor === 'FORCED_DECISION') {
      for (let t = 0; t < 2; t++) {
        if (engine.state.teams[t].forcedDecision) {
          engine.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: t, payload: { inIndex: null, outIndex: null } });
        }
      }
    }
  }
  return { hashes, final: engine.hash().toString(16).padStart(8, '0') };
}

/** @param {any} goldenData */
// @ts-expect-error browser test global
window.runGolden = function runGolden(goldenData) {
  const every = goldenData.everyTicks;
  const log = goldenData.commandLog ?? [];
  return goldenData.seeds.map((/** @type {any} */ entry) => {
    const input = {
      v: /** @type {const} */ (1),
      seed: entry.seed,
      configHash,
      home: goldenData.squads.home,
      away: goldenData.squads.away,
    };
    const res = runMatch(input, log, every);
    return { seed: entry.seed, hashes: res.hashes, final: res.final };
  });
};

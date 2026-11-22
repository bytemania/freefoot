/**
 * Calibration worker thread (design item 72, §18).
 * Plays assigned headless matches (both teams AI-controlled) and posts back
 * per-match metric rows.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { config, configHash } from '#generated/config.js';
import { MatchEngine } from '../engine/MatchEngine.js';
import { generateSquad } from '../shared/squadgen.js';
import { metricsFromEvents } from './metrics.js';

const { scenario, seeds } = /** @type {{scenario: 'A' | 'B', seeds: number[]}} */ (workerData);

/**
 * Plays one match to FULL_TIME and returns its metric row.
 * @param {'A' | 'B'} scen
 * @param {number} seed
 */
function playMatch(scen, seed) {
  const homeSide = scen === 'A' ? 'A' : 'B_strong';
  const awaySide = scen === 'A' ? 'A' : 'B_weak';
  const home = generateSquad(homeSide, (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad(awaySide, (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  const input = { v: /** @type {const} */ (1), seed, configHash, home, away };
  const engine = MatchEngine.create(input, config);

  // Track absurd states: any on-pitch player >30 m from their anchor for >20 s (400 ticks).
  const farTicks = new Int32Array(36);
  let absurdTicks = 0;

  while (true) {
    const r = engine.step(20);
    if (engine.state.restart.state === 'IN_PLAY') {
      const list = engine.state.onPitchList;
      for (let i = 0; i < list.length; i++) {
        const idx = list[i];
        const p = engine.state.players[idx];
        const dx = p.x - p.tx;
        const dy = p.y - p.ty;
        if (dx * dx + dy * dy > 900) {
          farTicks[idx] += 20;
          if (farTicks[idx] > 400) absurdTicks += 20;
        } else {
          farTicks[idx] = 0;
        }
      }
    }
    if (r.stoppedFor === 'FULL_TIME') break;
    if (r.stoppedFor === 'FORCED_DECISION') break;
  }

  const s = engine.state;
  const dist = [0, 0];
  const sprints = [0, 0];
  for (const p of s.players) {
    dist[p.team] += p.distance;
    sprints[p.team] += p.sprints;
  }
  const derived = metricsFromEvents(engine.eventLog, {
    home: { ticks: s.tick, timeOnBallTicks: s.stats.timeOnBallTicks[0], distanceM: dist[0], sprints: sprints[0] },
    away: { ticks: s.tick, timeOnBallTicks: s.stats.timeOnBallTicks[1], distanceM: dist[1], sprints: sprints[1] },
  });

  if (scen === 'A') {
    return { seed, home: derived.home, away: derived.away, absurdTicks };
  }
  return { seed, strong: derived.home, weak: derived.away, absurdTicks };
}

const results = seeds.map((seed) => playMatch(scenario, seed));
parentPort?.postMessage(results);

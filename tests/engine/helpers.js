import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { config, configHash } from '../../generated/config.js';
import home from '../../generated/squads/sample-home.js';
import away from '../../generated/squads/sample-away.js';

export { config, configHash };

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_PATH = path.join(here, '..', 'golden', 'seeds.json');

/**
 * A MatchInput from the sample squads. Both teams human-controlled by default,
 * so only an explicit command log acts.
 * @param {number} seed
 * @param {{homeControl?: 'human' | 'ai', awayControl?: 'human' | 'ai'}} [options]
 * @returns {import('../../src/engine/contracts/MatchInput.js').MatchInput}
 */
export function sampleInput(seed, { homeControl = 'human', awayControl = 'human' } = {}) {
  return /** @type {any} */ (JSON.parse(JSON.stringify({
    v: 1,
    seed,
    configHash,
    home: { ...home, controlledBy: homeControl },
    away: { ...away, controlledBy: awayControl },
  })));
}

/** @returns {any} */
export function readGolden() {
  return existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) : null;
}

/**
 * Runs a full match in batches of at most `batch` ticks, applying `log`
 * (human entries) at their ticks, and returns the hash every `every` ticks.
 * @param {import('../../src/engine/contracts/MatchInput.js').MatchInput} input
 * @param {any[]} log
 * @param {{every?: number, batch?: number, debug?: boolean}} [options]
 */
export function runMatch(input, log, { every = 1000, batch = 1000, debug = false } = {}) {
  const engine = MatchEngine.create(input, config, { debug });
  /** @type {string[]} */
  const hashes = [];
  const human = log.filter((e) => e.issuer === 'human').sort((a, b) => a.seq - b.seq);
  let next = 0;
  for (;;) {
    while (next < human.length && human[next].tick <= engine.tick) {
      const e = human[next++];
      engine.applyCommand({ issuer: 'human', type: e.type, teamIndex: e.teamIndex, payload: e.payload });
    }
    const target = Math.min(batch, every - (engine.tick % every));
    const r = engine.step(target);
    if (r.ticksRun > 0 && engine.tick % every === 0) hashes.push(engine.hash().toString(16).padStart(8, '0'));
    if (r.stoppedFor === 'FULL_TIME') break;
    if (r.stoppedFor === 'FORCED_DECISION') {
      for (let t = 0; t < 2; t++) {
        if (engine.state.teams[t].forcedDecision) {
          engine.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: t, payload: { inIndex: null, outIndex: null } });
        }
      }
    }
  }
  return { engine, hashes, final: engine.hash().toString(16).padStart(8, '0') };
}

// --- Scripted play: a stand-in ball driver for build step 3 (no decisions exist yet). ---
import { nextFloat } from '../../src/engine/rng/sfc32.js';
import { seedSfc32 } from '../../src/engine/rng/streams.js';
import { launchGround, launchLofted } from '../../src/engine/ball/BallPhysics.js';

/**
 * Kicks the ball from the on-pitch player nearest to it toward a random point
 * in that player's attacking direction, using the engine's own ball API.
 * Uses its own RNG stream, never the engine's.
 * @param {MatchEngine} engine
 * @param {Uint32Array} rng
 */
export function scriptedKick(engine, rng) {
  const s = engine.state;
  let nearest = -1;
  let best = Infinity;
  for (const i of s.onPitchList) {
    const p = s.players[i];
    const d = (p.x - s.ball.x) ** 2 + (p.y - s.ball.y) ** 2;
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  const p = s.players[nearest];
  const dir = s.attackDir(p.team);
  const lofted = nextFloat(rng) < 0.25;
  const reach = (lofted ? 30 : 12) + nextFloat(rng) * (lofted ? 20 : 25);
  const tx = Math.min(104, Math.max(1, p.x + dir * reach));
  const ty = Math.min(67, Math.max(1, p.y + (nextFloat(rng) - 0.5) * 30));
  if (lofted) launchLofted(s, p.x, p.y, tx, ty, 22, 8, nearest);
  else launchGround(s, p.x, p.y, tx, ty, 12 + nextFloat(rng) * 8, nearest);
}

/**
 * Plays a whole match with scripted kicks every 100-240 ticks (5-12 s, about the pace of real passing).
 * @param {MatchEngine} engine
 * @param {number} seed seed of the driver's own RNG
 */
export function playScripted(engine, seed) {
  const rng = seedSfc32(new Uint32Array(4), seed ^ 0x5eed);
  for (;;) {
    const gap = 100 + Math.floor(nextFloat(rng) * 140);
    const r = engine.step(gap);
    if (r.stoppedFor === 'FULL_TIME') return;
    if (r.stoppedFor === null) scriptedKick(engine, rng);
  }
}

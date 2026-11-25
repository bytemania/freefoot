/**
 * Instructions calibration worker (scripts/calibrate-instructions.mjs). Plays the assigned seeds of one option
 * headless (both teams AI, 80 v 80 OVR, morale 75): each seed twice, with the option on the home side and then on
 * the away side, the other side on defaults. Posts back both teams' trade-off metrics per match.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { config, configHash } from '#generated/config.js';
import { MatchEngine } from '../engine/MatchEngine.js';
import { generateRatedSquad } from '../shared/squadgen.js';
import { teamTradeoffMetrics } from './instructions.js';

const { instruction, option, seeds } = /** @type {{instruction: string, option: string, seeds: number[]}} */ (workerData);

/** Match ticks per step: the sampling grain of the dead-ball-while-leading clock. */
const STEP = 20;

/**
 * @param {number} seed
 * @param {0 | 1} optionSide
 */
function playMatch(seed, optionSide) {
  const home = generateRatedSquad(80, (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', morale: 75 });
  const away = generateRatedSquad(80, (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', morale: 75 });
  const sides = [home, away];
  sides[optionSide] = { ...sides[optionSide], instructions: { [instruction]: option } };
  const engine = MatchEngine.create({ v: 1, seed, configHash, home: sides[0], away: sides[1] }, config);
  const s = engine.state;
  const deadBallLeading = /** @type {[number, number]} */ ([0, 0]);
  const onBall = [0, 0];
  while (true) {
    const before = engine.tick;
    const r = engine.step(STEP);
    const b = s.ball;
    const owner = b.owner >= 0 ? s.players[b.owner].team : b.pass !== null ? s.players[b.pass.passer].team : -1;
    if (s.restart.state === 'IN_PLAY' && owner >= 0) onBall[owner]++;
    const t = s.restart.teamIndex;
    if (s.restart.state === 'DEAD_BALL' && (t === 0 || t === 1) && s.teams[t].score > s.teams[1 - t].score) {
      deadBallLeading[t] += (engine.tick - before) / 20;
    }
    if (r.stoppedFor === 'FULL_TIME' || r.stoppedFor === 'FORCED_DECISION') break;
  }
  const fitness = /** @type {[number, number]} */ ([0, 1].map((team) => {
    let sum = 0;
    let n = 0;
    for (const i of s.onPitchList) {
      if (s.players[i].team !== team) continue;
      sum += s.players[i].fitness;
      n++;
    }
    return n > 0 ? sum / n : 0;
  }));
  const total = onBall[0] + onBall[1];
  const possession = /** @type {[number, number]} */ ([total > 0 ? onBall[0] / total : 0.5, total > 0 ? onBall[1] / total : 0.5]);
  const metrics = teamTradeoffMetrics(engine.eventLog, [s.teams[0].score, s.teams[1].score], { fitness, deadBallLeading, possession });
  return { seed, optionSide, metrics };
}

parentPort?.postMessage(seeds.flatMap((seed) => [playMatch(seed, 0), playMatch(seed, 1)]));

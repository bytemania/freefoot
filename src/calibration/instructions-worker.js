/**
 * Instructions & tactical presets calibration worker (scripts/calibrate-instructions.mjs).
 * Plays assigned seeds headless (both teams AI, 80 v 80 OVR, morale 75), each seed twice
 * (variant on home, then away). Supports both single-instruction mode and `--presets` mode.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { config, configHash } from '#generated/config.js';
import { MatchEngine } from '../engine/MatchEngine.js';
import { autoPickBestXI } from '../runtime/matchday/MatchdayBuilder.js';
import { generateRatedSquad } from '../shared/squadgen.js';
import { teamTradeoffMetrics } from './instructions.js';

const data = /** @type {any} */ (workerData);
const seeds = /** @type {number[]} */ (data.seeds);

/** Match ticks per step: the sampling grain of the dead-ball-while-leading clock. */
const STEP = 20;

/**
 * Builds a symmetric `tacticalPlans` snapshot for the Unfamiliar (30%) vs Fluid (100%) check so
 * `AiCoach` obeys identical `USE_TACTIC_PLAN` formation rules on both sides.
 * @param {number} fam
 */
function makePlanSnapshot(fam) {
  const presets = config.tacticalPresets.presets;
  const planA = presets.find((/** @type {any} */ p) => p.id === 'balanced') ?? presets[0];
  const planB = presets.find((/** @type {any} */ p) => p.id !== planA.id) ?? presets[1];
  return {
    planA: {
      tacticId: planA.id,
      formationId: planA.formationId,
      instructions: { ...planA.instructions },
      formFam: fam,
      instrFam: fam,
    },
    planB: {
      tacticId: planB.id,
      formationId: planB.formationId,
      instructions: { ...planB.instructions },
      formFam: fam,
      instrFam: fam,
    },
  };
}

/**
 * @param {number} seed
 * @param {0 | 1} optionSide
 */
function playMatch(seed, optionSide) {
  const home = generateRatedSquad(80, (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', morale: 75 });
  const away = generateRatedSquad(80, (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', morale: 75 });
  /** @type {any[]} */
  const sides = [home, away];

  if (data.mode === 'preset') {
    const formationId = data.formationId;
    const slots = config.tactics.formations[formationId].slots;
    const balancedSlots = config.tactics.formations['4-3-3'].slots;
    sides[optionSide] = {
      ...sides[optionSide],
      formationId,
      instructions: { ...data.instructions },
      players: autoPickBestXI(sides[optionSide].players, slots, config.roles),
    };
    sides[1 - optionSide] = {
      ...sides[1 - optionSide],
      formationId: '4-3-3',
      instructions: {},
      players: autoPickBestXI(sides[1 - optionSide].players, balancedSlots, config.roles),
    };
    if (data.unfamiliar) {
      sides[optionSide].tacticalPlans = makePlanSnapshot(30);
      sides[1 - optionSide].tacticalPlans = makePlanSnapshot(100);
    }
  } else {
    sides[optionSide] = { ...sides[optionSide], instructions: { [data.instruction]: data.option } };
  }

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

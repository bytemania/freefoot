import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { BestMoments, isHighlightTrigger } from '../../src/runtime/BestMoments.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { generateSquad } from '../../src/shared/squadgen.js';

/**
 * @param {number} [seed]
 * @param {'human' | 'ai'} [homeCtrl]
 * @param {'human' | 'ai'} [awayCtrl]
 */
function makeInput(seed = 1, homeCtrl = 'ai', awayCtrl = 'ai') {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: homeCtrl });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: awayCtrl });
  return { v: /** @type {const} */ (1), seed, configHash, home, away };
}

test('isHighlightTrigger detects goals, big chances, woodwork, penalties, red cards and major saves', () => {
  assert.equal(isHighlightTrigger({ type: 'GOAL', meta: { kind: 'OPEN_PLAY' } }, config), true);
  assert.equal(isHighlightTrigger({ type: 'BIG_CHANCE', meta: { xg: 0.4 } }, config), true);
  assert.equal(isHighlightTrigger({ type: 'SHOT', meta: { result: 'WOODWORK', xg: 0.1 } }, config), true);
  assert.equal(isHighlightTrigger({ type: 'SHOT', meta: { result: 'OFF_TARGET', xg: 0.35 } }, config), true);
  assert.equal(isHighlightTrigger({ type: 'SHOT', meta: { result: 'OFF_TARGET', xg: 0.08 } }, config), false);
  assert.equal(isHighlightTrigger({ type: 'PENALTY_AWARDED', meta: {} }, config), true);
  assert.equal(isHighlightTrigger({ type: 'RED_CARD', meta: { secondYellow: false } }, config), true);
  assert.equal(isHighlightTrigger({ type: 'SAVE', meta: { kind: 'TIPPED', psxg: 0.4 } }, config), true);
  assert.equal(isHighlightTrigger({ type: 'SAVE', meta: { kind: 'HELD', psxg: 0.1 } }, config), false);
  assert.equal(isHighlightTrigger({ type: 'PASS', meta: { kind: 'SHORT', completed: true } }, config), false);
});

test('Best Moments fast-forward caps at ffMaxTicksPerFrame under a fake clock', () => {
  let fakeTime = 0;
  const fakeNow = () => {
    fakeTime += 0.001; // never hits 8 ms slice
    return fakeTime;
  };
  const ctrl = new MatchController({
    input: makeInput(2),
    config,
    mode: 'best_moments',
    now: fakeNow,
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  ctrl.bestMoments.replayCap = 0; // disable replay triggers so we test pure tick cap
  ctrl.play();
  ctrl.tickFrame(1 / 60);
  assert.equal(ctrl.engine.tick, config.playback.fastForward.maxTicksPerFrame);
  ctrl.destroy();
});

test('Best Moments replay leaves live engine hash unchanged, rejects commands during REPLAY, and pauses at replayEndTick', () => {
  let fakeTime = 0;
  const ctrl = new MatchController({
    input: makeInput(1),
    config,
    mode: 'best_moments',
    now: () => (fakeTime += 0.001),
    schedule: () => 1,
    cancelSchedule: () => {},
  });

  ctrl.play();
  // Step fast-forward until a highlight replay starts
  let guard = 0;
  while (ctrl.playbackState === 'FAST_FORWARD' && guard++ < 60) {
    ctrl.tickFrame(1 / 60);
  }
  assert.equal(ctrl.playbackState, 'REPLAY', 'expected a highlight trigger to start a replay');

  const liveHashBeforeReplay = ctrl.engine.hash();
  const liveTickBeforeReplay = ctrl.engine.tick;
  assert.equal(liveTickBeforeReplay, ctrl.bestMoments.replayEndTick);

  // Commands must be rejected during REPLAY (design §14)
  const rej = ctrl.queueCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '4-4-2' } });
  assert.equal(rej.ok, false);
  assert.equal(rej.code, 'REPLAY_ACTIVE');

  // Step through entire replay
  let replaySteps = 0;
  while (ctrl.playbackState === 'REPLAY' && replaySteps++ < 500) {
    ctrl.tickFrame(0.05);
  }
  assert.equal(ctrl.playbackState, 'PAUSED_HIGHLIGHT');
  assert.equal(ctrl.engine.hash(), liveHashBeforeReplay, 'replay must never mutate live engine');
  assert.equal(ctrl.engine.tick, liveTickBeforeReplay);

  // Cancelling countdown keeps it paused; otherwise countdown auto-continues
  ctrl.cancelHighlightCountdown();
  ctrl.tickFrame(10);
  assert.equal(ctrl.playbackState, 'PAUSED_HIGHLIGHT');
  ctrl.destroy();
});

test('Best Moments post-roll extension cap (firstTriggerTick + 160) and forced-decision cut-short', () => {
  const bm = new BestMoments({ config, now: () => 0 });
  const fakeRing = {
    oldestTick: () => 0,
    latestTick: () => 500,
    push: () => {},
    frameAt: () => ({ snapshot: new Float64Array(371), tick: 100, eventStart: 0, eventEnd: 0 }),
  };

  let curTick = 100;
  /** @type {any} */
  const fakeCtrl = {
    engine: {
      get tick() {
        return curTick;
      },
      step() {
        curTick++;
        // Trigger at 101, then keep firing triggers every 20 ticks to test 160-tick cap
        if (curTick === 101 || curTick === 130 || curTick === 160 || curTick === 200 || curTick === 240) {
          return { ticksRun: 1, events: [{ type: 'BIG_CHANCE', tick: curTick, meta: { xg: 0.5 } }], stoppedFor: null };
        }
        return { ticksRun: 1, events: [], stoppedFor: null };
      },
      getSnapshot() {},
    },
    ring: fakeRing,
    snapshot: new Float64Array(371),
    eventLog: [],
  };

  const res = bm.stepFastForward(fakeCtrl);
  assert.equal(res.startedReplay, true);
  assert.equal(bm.firstTriggerTick, 101);
  assert.equal(bm.replayEndTick, 101 + 160, 'extension must cap at firstTriggerTick + 160');

  // Now test forced decision cutting post-roll short -> PAUSED_FORCED
  const bm2 = new BestMoments({ config, now: () => 0 });
  curTick = 200;
  fakeCtrl.engine.step = () => {
    curTick++;
    if (curTick === 201) return { ticksRun: 1, events: [{ type: 'GOAL', tick: curTick, meta: { kind: 'OPEN_PLAY' } }], stoppedFor: null };
    if (curTick === 210) return { ticksRun: 1, events: [], stoppedFor: 'FORCED_DECISION' };
    return { ticksRun: 1, events: [], stoppedFor: null };
  };
  const res2 = bm2.stepFastForward(fakeCtrl);
  assert.equal(res2.startedReplay, true);
  assert.equal(bm2.replayEndTick, 210);
  let repEnd = bm2.stepReplay(0.1, /** @type {any} */ (fakeRing), []);
  while (!repEnd.finished) repEnd = bm2.stepReplay(0.1, /** @type {any} */ (fakeRing), []);
  assert.equal(repEnd.finished, true);
  assert.equal(repEnd.nextState, 'PAUSED_FORCED');
});

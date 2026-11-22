import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { SNAP_LEN } from '../../src/engine/MatchEngine.js';
import { RenderRing } from '../../src/runtime/RenderRing.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { generateSquad } from '../../src/shared/squadgen.js';

function makeInput(seed = 5) {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return { v: /** @type {const} */ (1), seed, configHash, home, away };
}

test('RenderRing stores snapshots up to capacity and evicts oldest ticks', () => {
  const ring = new RenderRing(4);
  const snap = new Float64Array(SNAP_LEN);
  for (let t = 1; t <= 6; t++) {
    snap[0] = t;
    ring.push(snap, t, t - 1, t);
  }
  assert.equal(ring.oldestTick(), 3);
  assert.equal(ring.latestTick(), 6);
  assert.equal(ring.frameAt(2), null);
  const f5 = ring.frameAt(5);
  assert.ok(f5);
  assert.equal(f5.snapshot[0], 5);
  assert.equal(f5.eventStart, 4);
  assert.equal(f5.eventEnd, 5);
});

test('MatchController pull loop caps ticks per frame and keeps alpha in [0, 1]', () => {
  const ctrl = new MatchController({
    input: makeInput(9),
    config,
    mode: 'debug',
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  ctrl.setSpeed(60);
  ctrl.play();
  const frame = ctrl.tickFrame(0.5); // clamped to 0.1s -> 0.1 * 20 * 60 = 120 ticks -> capped at 20
  assert.equal(frame.tick, 20);
  assert.ok(frame.alpha >= 0 && frame.alpha <= 1);
  assert.ok(ctrl.droppedBudget > 0);
  ctrl.destroy();
});

test('MatchController stepTicks and deterministic seekToTick reproduce exact state hash', () => {
  const ctrl = new MatchController({
    input: makeInput(11),
    config,
    mode: 'debug',
    schedule: () => 1,
    cancelSchedule: () => {},
  });

  ctrl.stepTicks(20);
  const hashAt20 = ctrl.engine.hash();
  ctrl.stepTicks(100);
  assert.equal(ctrl.engine.tick, 120);

  // Seeking backwards to tick 20 must reproduce the exact same hash.
  ctrl.seekToTick(20);
  assert.equal(ctrl.engine.tick, 20);
  assert.equal(ctrl.engine.hash(), hashAt20);

  // Seeking forward to tick 120 must also work cleanly.
  ctrl.seekToTick(120);
  assert.equal(ctrl.engine.tick, 120);
  ctrl.destroy();
});

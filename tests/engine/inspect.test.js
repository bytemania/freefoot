import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { inspectCarrierDecision, inspectPitch } from '../../src/engine/debug/inspect.js';
import { generateSquad } from '../../src/shared/squadgen.js';

function makeEngine(seed = 1) {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return MatchEngine.create({ v: 1, seed, configHash, home, away }, config);
}

test('inspectPitch and inspectCarrierDecision are pure and never mutate engine state or RNG', () => {
  const a = makeEngine(42);
  const b = makeEngine(42);

  let carrierSeen = false;
  for (let step = 0; step < 30; step++) {
    a.step(20);
    b.step(20);
    const hashBefore = a.hash();
    const pitch = inspectPitch(a.state);
    const carrier = inspectCarrierDecision(a.state);
    const hashAfter = a.hash();

    assert.equal(hashAfter, hashBefore, 'inspection must not alter state hash');
    assert.equal(a.hash(), b.hash(), 'inspected engine must stay bit-identical to uninspected engine');
    assert.equal(pitch.players.length, 36);
    assert.equal(pitch.teams.length, 2);

    if (carrier !== null) {
      carrierSeen = true;
      assert.equal(carrier.carrierIndex, a.state.ball.owner);
      assert.ok(['PASS', 'DRIBBLE', 'SHOT', 'CROSS', 'CLEARANCE', 'HOLD'].includes(carrier.bestKind));
      assert.ok(Number.isFinite(carrier.shot.distance));
      assert.ok(Array.isArray(carrier.passes));
      assert.equal(carrier.dribbles.length, 3);
    }
  }
  assert.equal(carrierSeen, true, 'should observe at least one ball carrier in 600 ticks');
});

test('inspectCarrierDecision returns null when no player owns the ball', () => {
  const engine = makeEngine(7);
  engine.state.ball.owner = -1;
  assert.equal(inspectCarrierDecision(engine.state), null);
});

test('inspectPitch computes defensive line height and compactness width for both teams', () => {
  const engine = makeEngine(3);
  engine.step(200);
  const info = inspectPitch(engine.state);
  for (const t of info.teams) {
    assert.ok(t.defensiveLineX >= 0 && t.defensiveLineX <= 105);
    assert.ok(t.compactnessWidth >= 0 && t.compactnessWidth <= 68);
    assert.ok(t.widthMaxY >= t.widthMinY);
  }
});

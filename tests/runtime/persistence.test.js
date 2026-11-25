import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { Persistence, SCHEMA_VERSION } from '../../src/runtime/Persistence.js';
import { buildReproJson } from '../../src/runtime/ReproBundle.js';
import { memoryStorage } from '../../src/runtime/storage.js';
import { generateSquad } from '../../src/shared/squadgen.js';

function makeInput(seed = 12) {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'human' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return { v: /** @type {const} */ (1), seed, configHash, home, away };
}

// The match screen no longer saves mid-match (saving lives between matches in the outer app); the save /
// resume layer itself stays deterministic.
test('Persistence save and resume round-trip reproduces exact hash, score, clock and event list', async () => {
  const storage = memoryStorage();
  const persistence = new Persistence({ storage });
  const ctrl = new MatchController({
    input: makeInput(15),
    config,
    mode: 'full',
    schedule: () => 1,
    cancelSchedule: () => {},
  });

  ctrl.stepTicks(200);
  const cmdRes = ctrl.queueCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '4-4-2' } });
  assert.equal(cmdRes.ok, true);
  ctrl.stepTicks(300);

  const savedFirst = await persistence.save(ctrl);
  assert.equal(savedFirst, true);
  // Two saves at the same tick write only once (design §20)
  const savedSecond = await persistence.save(ctrl);
  assert.equal(savedSecond, false);

  const expectedHash = ctrl.engine.hash();
  const expectedTick = ctrl.engine.tick;
  const expectedEventCount = ctrl.eventLog.length;

  const resumed = await persistence.resume();
  assert.equal(resumed.ok, true);
  if (resumed.ok) {
    assert.equal(resumed.engine.tick, expectedTick);
    assert.equal(resumed.engine.hash(), expectedHash);
    assert.equal(resumed.events.length, expectedEventCount);
    assert.equal(resumed.engine.state.teams[0].formationId, '4-4-2');
  }

  // Repro JSON matches save record structure
  const repro = JSON.parse(buildReproJson(ctrl));
  assert.equal(repro.schemaVersion, SCHEMA_VERSION);
  assert.equal(repro.tick, expectedTick);
  assert.equal(repro.stateHash, expectedHash);
  ctrl.destroy();
});

test('Persistence discards save with typed reason on schemaVersion, engineVersion, configHash, and stateHash mismatch', async () => {
  const storage = memoryStorage();
  const persistence = new Persistence({ storage });
  const ctrl = new MatchController({
    input: makeInput(19),
    config,
    mode: 'full',
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  ctrl.stepTicks(50);
  await persistence.save(ctrl);
  const base = await persistence.loadRaw();

  const r1 = await persistence.resume({ ...base, schemaVersion: 999 });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, 'SCHEMA_MISMATCH');

  const r2 = await persistence.resume({ ...base, engineVersion: '0.0.0-old' });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, 'ENGINE_MISMATCH');

  const r3 = await persistence.resume({ ...base, configHash: '0'.repeat(64) });
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.equal(r3.reason, 'CONFIG_HASH_MISMATCH');

  const r4 = await persistence.resume({ ...base, stateHash: base.stateHash ^ 1 });
  assert.equal(r4.ok, false);
  if (!r4.ok) assert.equal(r4.reason, 'STATE_HASH_MISMATCH');

  // PAUSED_HIGHLIGHT resumes as PAUSED
  const r5 = await persistence.resume({ ...base, playbackState: 'PAUSED_HIGHLIGHT' });
  assert.equal(r5.ok, true);
  if (r5.ok) assert.equal(r5.playbackState, 'PAUSED');

  ctrl.destroy();
});

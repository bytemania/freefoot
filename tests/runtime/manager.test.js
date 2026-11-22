import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { formatCommandError } from '../../src/ui/views/ManagerView.js';
import { generateSquad } from '../../src/shared/squadgen.js';

function makeController(seed = 21) {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'human' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return new MatchController({
    input: { v: 1, seed, configHash, home, away },
    config,
    mode: 'full',
    schedule: () => 1,
    cancelSchedule: () => {},
  });
}

test('Manager command flow: formation switch, substitution queue/cancel, and translated error messages', () => {
  const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const ctrl = makeController();

  // Valid formation switch
  const fOk = ctrl.queueCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '4-4-2' } });
  assert.equal(fOk.ok, true);
  assert.equal(formatCommandError(fOk, loc), null);
  ctrl.stepTicks(1);
  assert.equal(ctrl.engine.state.teams[0].formationId, '4-4-2');

  // Invalid formation returns translated error
  const fBad = ctrl.queueCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '9-0-1' } });
  assert.equal(fBad.ok, false);
  assert.equal(formatCommandError(fBad, loc), 'Unknown formation.');

  // Queue substitution then cancel it
  const subOk = ctrl.queueCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: 9, inIndex: 12 } });
  assert.equal(subOk.ok, true);
  assert.equal(ctrl.engine.state.pendingSubs.length, 1);

  const dup = ctrl.queueCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: 9, inIndex: 13 } });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'ALREADY_PENDING');
  assert.match(formatCommandError(dup, loc) ?? '', /already part of a pending substitution/);

  const cancelOk = ctrl.queueCommand({ issuer: 'human', type: 'CANCEL_SUBSTITUTION', teamIndex: 0, payload: { seq: subOk.seq } });
  assert.equal(cancelOk.ok, true);
  assert.equal(ctrl.engine.state.pendingSubs.length, 0);

  // Portuguese translation of error code
  loc.setLocale('pt-PT');
  const badSub = ctrl.queueCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: 12, inIndex: 13 } });
  assert.equal(badSub.ok, false);
  assert.equal(badSub.code, 'PLAYER_NOT_ON_PITCH');
  assert.equal(formatCommandError(badSub, loc), 'Esse jogador não está em campo.');

  ctrl.destroy();
});

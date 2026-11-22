import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { formatCommandError, ManagerView } from '../../src/ui/views/ManagerView.js';
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

test('slowForManager steps 60x / fast speeds down to 1x when opening Manager, without unpausing when paused', () => {
  const ctrl = makeController(25);
  ctrl.setSpeed(30);
  ctrl.play();
  assert.equal(ctrl.speed, 30);
  ctrl.slowForManager();
  assert.equal(ctrl.speed, 1);
  assert.equal(ctrl.watchSpeed, 1);
  assert.equal(ctrl.playbackState, 'FULL_MATCH');

  // Auto Highlights in FAST (60x) drops immediately to WATCH (1x)
  ctrl.setMode('auto_highlights');
  ctrl.setSpeed(5);
  ctrl.autoPacing = 'FAST';
  ctrl.autoCooldownTicks = 0;
  ctrl.slowForManager();
  assert.equal(ctrl.watchSpeed, 1);
  assert.equal(ctrl.autoPacing, 'WATCH');
  assert.equal(ctrl.getEffectiveSpeed(), 1);

  // Paused state stays paused without unpausing
  ctrl.setSpeed(0);
  assert.equal(ctrl.playbackState, 'PAUSED');
  ctrl.slowForManager();
  assert.equal(ctrl.playbackState, 'PAUSED');
  assert.equal(ctrl.speed, 0);

  // Forced decision stays PAUSED_FORCED
  ctrl.playbackState = 'PAUSED_FORCED';
  ctrl.slowForManager();
  assert.equal(ctrl.playbackState, 'PAUSED_FORCED');

  ctrl.destroy();
});

test('ManagerView stages formation, swap, and substitution drafts without mutating engine until Confirm is pressed', () => {
  const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const ctrl = makeController(31);
  const view = new ManagerView({
    locale: loc,
    teamIndex: 0,
    onCommand: (cmd) => ctrl.queueCommand(cmd),
  });
  view.update({ state: ctrl.engine.state, playbackState: 'PAUSED' });

  // Stage formation, slot swap, and substitution draft
  view.stagedFormation = '4-4-2';
  view.stagedSwaps.push([9, 10]);
  view.stagedSubs.push({ outIndex: 9, inIndex: 12 });

  // Before Confirm: engine state is completely untouched
  assert.equal(ctrl.engine.state.teams[0].formationId, '4-3-3');
  assert.equal(ctrl.engine.state.pendingSubs.length, 0);
  assert.equal(ctrl.engine.state.pendingCommands.length, 0);

  // Confirm commits formation, swap, and substitution commands to engine
  view.confirmDraft();
  assert.equal(ctrl.engine.state.pendingSubs.length, 1);
  assert.equal(view.stagedFormation, null);
  assert.equal(view.stagedSwaps.length, 0);
  assert.equal(view.stagedSubs.length, 0);
  assert.match(view.confirmedMsg, /Confirmed/);

  ctrl.stepTicks(1); // dead-ball kick-off applies formation, swap, and queued substitution
  assert.equal(ctrl.engine.state.teams[0].formationId, '4-4-2');
  assert.equal(ctrl.engine.state.players[9].onPitch, 0);
  assert.equal(ctrl.engine.state.players[12].onPitch, 1);

  // Discard drops drafts without queuing anything
  view.stagedFormation = '4-3-3';
  view.stagedSubs.push({ outIndex: 8, inIndex: 13 });
  view.discardDraft();
  assert.equal(view.stagedFormation, null);
  assert.equal(view.stagedSubs.length, 0);
  assert.equal(ctrl.engine.state.pendingCommands.length, 0);

  ctrl.destroy();
});

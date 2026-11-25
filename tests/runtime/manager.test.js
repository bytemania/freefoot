import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { SNAP_PLAYERS, SNAP_PLAYER_STRIDE } from '../../src/engine/MatchEngine.js';
import { formatCommandError, ManagerView, playerTelemetry, ratingClass } from '../../src/ui/views/ManagerView.js';
import { generateSquad } from '../../src/shared/squadgen.js';
import { startRestart } from '../../src/engine/restarts/RestartMachine.js';
import { fakeElement } from '../ui/fakedom.js';
import { Commentator } from '../../src/i18n/Commentator.js';
import { CommentaryView } from '../../src/ui/views/CommentaryView.js';

/** A CommentaryView over a stub broadcast bar. @param {MatchController} ctrl @param {LocaleManager} locale */
function commentaryFor(ctrl, locale) {
  const bar = { className: '', innerHTML: '', dataset: {}, style: { setProperty() {}, removeProperty() {} } };
  const view = new CommentaryView({ commentator: new Commentator(config.commentary), locale });
  view.root = /** @type {any} */ ({ querySelector: () => bar });
  view.setContext({ matchSeed: ctrl.input.seed, teams: [ctrl.input.home, ctrl.input.away], players: [...ctrl.input.home.players, ...ctrl.input.away.players] });
  return { view, bar };
}

/** Steps the controller until the ball is in play. @param {MatchController} ctrl */
function toOpenPlay(ctrl) {
  for (let i = 0; i < 2000 && ctrl.engine.state.restart.state !== 'IN_PLAY'; i++) ctrl.stepTicks(1);
  assert.equal(ctrl.engine.state.restart.state, 'IN_PLAY');
}

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

  // Queue substitution (in open play it waits for the next stoppage) then cancel it
  toOpenPlay(ctrl);
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

  // Confirm at the opening kick-off (a dead ball): everything is applied at once
  /** @type {any[]} */
  const frames = [];
  ctrl.onFrame = (f) => frames.push(f);
  view.confirmDraft();
  assert.equal(ctrl.engine.state.pendingSubs.length, 0);
  assert.equal(view.stagedFormation, null);
  assert.equal(view.stagedSwaps.length, 0);
  assert.equal(view.stagedSubs.length, 0);
  assert.match(view.confirmedMsg, /Confirmed — substitution made/);
  assert.equal(ctrl.engine.state.teams[0].formationId, '4-4-2');
  assert.equal(ctrl.engine.state.players[9].onPitch, 0);
  assert.equal(ctrl.engine.state.players[12].onPitch, 1);
  const subEvents = frames.flatMap((f) => f.newEvents).filter((e) => e.type === 'SUBSTITUTION');
  assert.deepEqual(subEvents.map((e) => [e.actorIndex, e.secondaryIndices[0]]), [[9, 12]], 'the frame carries the SUBSTITUTION event for commentary');
  assert.ok(ctrl.eventLog.includes(subEvents[0]));
  // The RenderSnapshot is refreshed at once: player 12 is on the pitch in the snapshot.
  assert.equal(frames.at(-1).renderSnapshot[SNAP_PLAYERS + SNAP_PLAYER_STRIDE * 12 + 4], 1);
  assert.equal(frames.at(-1).renderSnapshot[SNAP_PLAYERS + SNAP_PLAYER_STRIDE * 9 + 4], 0);
  // ... and it carries the on-pitch substitution animation cue.
  assert.deepEqual(
    frames.at(-1).animations.map((/** @type {any} */ c) => [c.kind, c.actor, c.incoming]),
    [['SUBSTITUTION', 9, 12]],
  );
  ctrl.onFrame = () => {};

  // Discard drops drafts without queuing anything
  view.stagedFormation = '4-3-3';
  view.stagedSubs.push({ outIndex: 8, inIndex: 13 });
  view.discardDraft();
  assert.equal(view.stagedFormation, null);
  assert.equal(view.stagedSubs.length, 0);
  assert.equal(ctrl.engine.state.pendingCommands.length, 0);

  ctrl.destroy();
});

for (const kind of ['FREE_KICK', 'THROW_IN', 'CORNER', 'GOAL_KICK']) {
  test(`a sub confirmed in ManagerView during open play is made at the very next dead ball (${kind}) with a SUBSTITUTION commentary event`, () => {
    const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
    const ctrl = makeController(41);
    const view = new ManagerView({ locale: loc, teamIndex: 0, onCommand: (cmd) => ctrl.queueCommand(cmd) });
    toOpenPlay(ctrl);
    view.update({ state: ctrl.engine.state, playbackState: 'PAUSED' });
    view.stagedSubs.push({ outIndex: 8, inIndex: 13 });
    view.confirmDraft();
    assert.match(view.confirmedMsg, /queued for the next stoppage/);
    assert.equal(ctrl.engine.state.pendingSubs.length, 1);
    // The ball goes dead (a mid-pitch foul's free kick, a throw-in, a corner, a goal kick).
    startRestart(ctrl.engine.state, kind, 0, kind === 'CORNER' ? 105 : 52.5, kind === 'CORNER' ? 0 : 30, { direct: kind === 'FREE_KICK' });
    const frame = ctrl.stepTicks(1);
    const sub = frame.newEvents.find((e) => e.type === 'SUBSTITUTION');
    assert.ok(sub, 'made on the first dead-ball tick');
    assert.equal(sub.actorIndex, 8);
    assert.equal(sub.secondaryIndices[0], 13);
    assert.equal(ctrl.engine.state.players[13].onPitch, 1);
    assert.equal(ctrl.engine.state.players[13].slot, 8);
    assert.equal(ctrl.engine.state.pendingSubs.length, 0);
    // The broadcast bar shows it as min | icon | comment.
    const { view: comm, bar } = commentaryFor(ctrl, loc);
    comm.update({ newEvents: [sub] });
    const out = ctrl.input.home.players[8];
    const incoming = ctrl.input.home.players[13];
    assert.match(bar.innerHTML, /<span class="comm-min">\d+'<\/span>/);
    assert.match(bar.innerHTML, /comm-icon--sub/);
    assert.ok(bar.innerHTML.includes(`${incoming.shortName}, ${out.shortName}`), bar.innerHTML);
    ctrl.destroy();
  });
}

test('a sub confirmed in ManagerView during open play is made at the next real FOUL (no advantage) in a running match', () => {
  const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  // Find an advantage foul in an untouched run, then confirm a sub the tick before it.
  const probe = makeController(7);
  let foulTick = -1;
  while (foulTick < 0 && probe.playbackState !== 'FULL_TIME') {
    const f = probe.stepTicks(1);
    if (probe.playbackState === 'HALF_TIME') continue;
    if (f.newEvents.some((e) => e.type === 'FOUL') && probe.engine.state.advantage !== null) foulTick = probe.engine.tick;
  }
  probe.destroy();
  assert.ok(foulTick > 0);
  const ctrl = makeController(7);
  while (ctrl.engine.tick < foulTick - 1) ctrl.stepTicks(1);
  const view = new ManagerView({ locale: loc, teamIndex: 0, onCommand: (cmd) => ctrl.queueCommand(cmd) });
  view.update({ state: ctrl.engine.state, playbackState: 'PAUSED' });
  view.stagedSubs.push({ outIndex: 9, inIndex: 12 });
  view.confirmDraft();
  assert.equal(ctrl.engine.state.pendingSubs.length, 1);
  const frame = ctrl.stepTicks(1);
  const types = frame.newEvents.map((e) => e.type);
  assert.ok(types.includes('FOUL'));
  assert.ok(types.includes('SUBSTITUTION'), 'the foul stops play and the sub is made');
  assert.equal(ctrl.engine.state.players[12].onPitch, 1);
  ctrl.destroy();
});

test('ManagerView shows the live rating, age, fitness, individual morale, cards and injury on both minimap nodes and bench rows', () => {
  const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const ctrl = makeController(51);
  const s = ctrl.engine.state;
  const view = new ManagerView({ locale: loc, teamIndex: 0, onCommand: (cmd) => ctrl.queueCommand(cmd) });
  /** @type {Record<string, any>} */
  const els = {};
  const root = /** @type {any} */ (fakeElement());
  root.querySelector = (/** @type {string} */ sel) => (els[sel] ??= fakeElement());
  root.querySelectorAll = () => [];
  view.root = root;

  // On-pitch player 4: yellow card, injury, tired, low morale; bench player 14: fresh, high morale.
  s.players[4].card = 1;
  s.players[4].injury = 2;
  s.players[4].fitness = 0.61;
  s.players[4].morale = 52;
  s.players[4].moraleLevel = -1;
  s.players[14].morale = 91;
  s.players[14].moraleLevel = 1;
  s.players[4].rating = 5.4;
  s.players[9].rating = 7.36;
  s.players[6].rating = 8.6;
  view.update({ state: s, playbackState: 'PAUSED' });

  const map = els['#mgr-minimap'].innerHTML;
  const bench = els['#mgr-bench'].innerHTML;
  // Minimap: fitness bar + %, morale icon + %, card and injury badges (no age: it declutters the cards)
  assert.doesNotMatch(map, /mgr-age/);
  assert.match(map, /mgr-fit-fill is-low" style="width:61%"/);
  assert.match(map, /mgr-morale is-low"[^>]*><span class="mgr-morale-icon" aria-hidden="true">▼<\/span>52%/);
  assert.match(map, /class="mgr-b-yc" title="Yellow card"/);
  assert.match(map, /class="mgr-b-inj is-l2" title="Injured"/);
  // Live match rating badges, colour-coded (red < 6.0, neutral 6.0-6.9, green >= 7.0, cyan/gold >= 8.0)
  assert.equal((map.match(/class="mgr-rating /g) ?? []).length, 11);
  assert.match(map, /class="mgr-rating is-poor" title="Match rating 5.4"[^>]*>5.4</);
  assert.match(map, /class="mgr-rating is-good" title="Match rating 7.4"[^>]*>7.4</);
  assert.match(map, /class="mgr-rating is-elite"[^>]*>8.6</);
  assert.match(map, /class="mgr-rating is-avg"[^>]*>6.0</);
  assert.equal((map.match(/class="mgr-morale /g) ?? []).length, 11);
  assert.equal((map.match(/class="mgr-fit-fill /g) ?? []).length, 11);
  // Bench: the same telemetry on every row
  assert.equal((bench.match(/class="mgr-rating is-avg"[^>]*>6.0</g) ?? []).length, 7, 'the bench starts at 6.0');
  assert.doesNotMatch(bench, /mgr-age/);
  assert.equal((bench.match(/class="mgr-fit-fill /g) ?? []).length, 7);
  assert.equal((bench.match(/class="mgr-morale /g) ?? []).length, 7);
  assert.match(bench, /mgr-morale is-high"[^>]*><span class="mgr-morale-icon" aria-hidden="true">▲<\/span>91%/);

  // Card and injury badges render on bench rows too (a carried knock)
  s.players[15].injury = 1;
  view.update({ state: s, playbackState: 'PAUSED' });
  assert.match(els['#mgr-bench'].innerHTML, /class="mgr-b-inj is-l1"/);

  // pt-PT: still no age tag
  loc.setLocale('pt-PT');
  view.update({ state: s, playbackState: 'PAUSED' });
  assert.doesNotMatch(els['#mgr-minimap'].innerHTML, /mgr-age/);
  assert.match(els['#mgr-minimap'].innerHTML, /title="Cartão amarelo"/);
  assert.match(els['#mgr-minimap'].innerHTML, /title="Nota do jogo 8.6"/);
  // The rating re-renders when it changes.
  s.players[14].rating = 7.1;
  view.update({ state: s, playbackState: 'PAUSED' });
  assert.match(els['#mgr-bench'].innerHTML, /class="mgr-rating is-good"[^>]*>7.1</);

  assert.deepEqual(
    (({ rating, ratingCls, fitness, morale, card, injury }) => ({ rating, ratingCls, fitness, morale, card, injury }))(playerTelemetry(s.players[4])),
    { rating: '5.4', ratingCls: 'is-poor', fitness: 61, morale: 52, card: 1, injury: 2 },
  );
  assert.deepEqual([5.94, 5.96, 6.94, 6.96, 7.94, 7.96, 10].map(ratingClass), ['is-poor', 'is-avg', 'is-avg', 'is-good', 'is-good', 'is-elite', 'is-elite']);
  ctrl.destroy();
});

/**
 * A ManagerView over a fake DOM, with `els` giving each element by selector.
 * @param {MatchController} ctrl
 * @param {LocaleManager} locale
 */
function fakeManager(ctrl, locale) {
  const view = new ManagerView({ locale, teamIndex: 0, onCommand: (cmd) => ctrl.queueCommand(cmd) });
  /** @type {Record<string, any>} */
  const els = {};
  const root = /** @type {any} */ (fakeElement());
  root.querySelector = (/** @type {string} */ sel) => (els[sel] ??= fakeElement());
  root.querySelectorAll = () => [];
  view.root = root;
  return { view, els };
}

test('ManagerView shows the remaining in-play substitution windows, "HT: free" at half-time, and refuses to stage a 4th window', () => {
  const loc = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const ctrl = makeController(61);
  const s = ctrl.engine.state;
  const { view, els } = fakeManager(ctrl, loc);
  toOpenPlay(ctrl);

  view.update({ state: s, playbackState: 'PAUSED' });
  assert.match(els['#mgr-subs-left'].textContent, /3\/3 windows left/);
  s.teams[0].subWindows = 1;
  view.update({ state: s, playbackState: 'PAUSED' });
  assert.match(els['#mgr-subs-left'].textContent, /2\/3 windows left/);

  // A staged substitution will open a window, so it counts at once.
  view.stagedSubs.push({ outIndex: 9, inIndex: 12 });
  view.update({ state: s, playbackState: 'PAUSED' });
  assert.match(els['#mgr-subs-left'].textContent, /1\/3 windows left/);
  view.stagedSubs.length = 0;

  s.teams[0].subWindows = 3;
  view.update({ state: s, playbackState: 'PAUSED' });
  assert.match(els['#mgr-subs-left'].textContent, /0\/3 windows left/);
  view.selectedOut = 9;
  // Staging goes through the private guard: drive it with the same call the tap handlers make.
  view.stageSubForTest(9, 12);
  assert.equal(view.stagedSubs.length, 0, 'nothing staged with no window left');
  assert.equal(view.errorMsg, loc.t('errors.NO_WINDOWS_LEFT'));

  // Inside a window already opened, or at half-time, staging is fine.
  s.teams[0].inSubWindow = true;
  view.errorMsg = '';
  view.stageSubForTest(9, 12);
  assert.equal(view.stagedSubs.length, 1);
  view.stagedSubs.length = 0;
  s.teams[0].inSubWindow = false;
  s.restart.state = 'HALF_TIME';
  view.update({ state: s, playbackState: 'PAUSED' });
  assert.match(els['#mgr-subs-left'].textContent, /HT: free/);
  view.stageSubForTest(9, 12);
  assert.equal(view.stagedSubs.length, 1);

  loc.setLocale('pt-PT');
  view.update({ state: s, playbackState: 'PAUSED' });
  assert.match(els['#mgr-subs-left'].textContent, /Intervalo: livre/);
  ctrl.destroy();
});

test('serialization across a substitution stoppage is deterministic: save mid-window, restore, same hash', async () => {
  const { MatchEngine } = await import('../../src/engine/MatchEngine.js');
  const ctrl = makeController(71);
  const input = ctrl.input;
  toOpenPlay(ctrl);
  ctrl.queueCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: 9, inIndex: 12 } });
  startRestart(ctrl.engine.state, 'THROW_IN', 0, 52.5, 0);
  ctrl.stepTicks(1);
  assert.equal(ctrl.engine.state.teams[0].subWindows, 1);
  assert.equal(ctrl.engine.state.teams[0].inSubWindow, true);
  const saved = JSON.parse(JSON.stringify(ctrl.engine.serialize()));
  const resumed = MatchEngine.fromState(saved, input, config);
  assert.equal(resumed.hash(), ctrl.engine.hash());
  assert.equal(resumed.state.teams[0].inSubWindow, true);
  for (let i = 0; i < 600; i++) {
    ctrl.engine.step(1);
    resumed.step(1);
  }
  assert.equal(resumed.hash(), ctrl.engine.hash());
  ctrl.destroy();
});

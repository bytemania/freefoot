import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { ControlsView, playPauseIndicator, COACH_ICON, STATS_ICON, TACTICS_ICON } from '../../src/ui/views/ControlsView.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { generateSquad } from '../../src/shared/squadgen.js';
import { configHash } from '../../generated/config.js';
import { fakeElement, fakeRoot } from './fakedom.js';

const PAUSED_STATES = ['PAUSED', 'PAUSED_HIGHLIGHT', 'PAUSED_FORCED', 'HALF_TIME', 'FULL_TIME', 'REPLAY'];
const PLAYING_STATES = ['FULL_MATCH', 'FAST_FORWARD'];

test('playPauseIndicator: > while paused (kick-off, stops, half-time), || while playing, tinted by the pacing', () => {
  for (const ps of PAUSED_STATES) {
    for (const autoPacing of ['FAST', 'WATCH']) {
      assert.deepEqual(playPauseIndicator({ playbackState: ps, mode: 'auto_highlights', autoPacing }), { icon: '>', kind: 'paused', labelKey: 'buttons.play' }, ps);
    }
  }
  assert.deepEqual(playPauseIndicator({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'FAST' }), { icon: '||', kind: 'fast', labelKey: 'buttons.pause' });
  assert.deepEqual(playPauseIndicator({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'WATCH' }), { icon: '||', kind: 'live', labelKey: 'buttons.pause' });
  assert.deepEqual(playPauseIndicator({ playbackState: 'FULL_MATCH', mode: 'full' }), { icon: '||', kind: 'live', labelKey: 'buttons.pause' });
  assert.deepEqual(playPauseIndicator({ playbackState: 'FAST_FORWARD', mode: 'best_moments' }), { icon: '||', kind: 'fast', labelKey: 'buttons.pause' });
});

test('ControlsView: one compact Play / Pause button on the right edge, no second transport button', () => {
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const view = new ControlsView({ locale, onTogglePlay() {}, onContinue() {}, onOpenStats() {}, onOpenManager() {} });
  const html = view.partialHtml.replace(/\s+/g, ' ');
  const group = html.match(/<div class="ctrl-transport">(.*?)<\/div>/);
  assert.ok(group, 'a right-edge transport group');
  const ids = [...group[1].matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['ctrl-play'], 'a single button');
  assert.match(group[1], /<button type="button" class="pacing-badge is-paused" id="ctrl-play"[^>]*>&gt;<\/button>/, 'compact style, > before kick-off');
  assert.doesNotMatch(html, /ctrl-pacing|\|&gt;/, 'no speed badge, no |> glyph');
  assert.ok(html.indexOf('id="ctrl-stats"') < html.indexOf('ctrl-transport'), 'Stats / Coach stay on the left');
});

test('ControlsView: the button shows > while paused and || while playing, with the pacing tint and localized labels', () => {
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const view = new ControlsView({ locale, onTogglePlay() {}, onContinue() {}, onOpenStats() {}, onOpenManager() {} });
  const root = fakeRoot();
  view.root = root;
  const play = root.querySelector('#ctrl-play');
  for (const ps of PAUSED_STATES) {
    view.update({ playbackState: ps, mode: 'auto_highlights', autoPacing: 'FAST', countdownRemaining: 0 });
    assert.equal(play.textContent, '>', ps);
    assert.ok(play.classList.contains('is-paused') && !play.classList.contains('is-fast'), ps);
    assert.equal(play.attrs['aria-label'], 'Play');
  }
  for (const ps of PLAYING_STATES) {
    view.update({ playbackState: ps, mode: 'auto_highlights', autoPacing: 'FAST', countdownRemaining: 0 });
    assert.equal(play.textContent, '||', ps);
    assert.ok(play.classList.contains('is-fast') && !play.classList.contains('is-paused'), ps);
    assert.equal(play.attrs.title, 'Pause');
  }
  view.update({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'WATCH', countdownRemaining: 0 });
  assert.ok(play.classList.contains('is-live') && !play.classList.contains('is-fast'));
  locale.setLocale('pt-PT');
  view.update({ playbackState: 'PAUSED', mode: 'auto_highlights', autoPacing: 'WATCH', countdownRemaining: 0 });
  assert.equal(play.attrs['aria-label'], 'Reproduzir');
  assert.equal(play.attrs.title, 'Reproduzir');
  view.update({ playbackState: 'FULL_MATCH', mode: 'full', countdownRemaining: 0 });
  assert.equal(play.attrs['aria-label'], 'Pausar');
});

test('ControlsView: Stats, Tactics and Coach are icon-only SVG buttons with localized labels; the one button toggles play', () => {
  assert.match(COACH_ICON, /^<svg[^>]*aria-hidden="true"/);
  assert.match(STATS_ICON, /^<svg[^>]*aria-hidden="true"/);
  assert.match(TACTICS_ICON, /^<svg[^>]*aria-hidden="true"/);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  let toggles = 0;
  let tactics = 0;
  const view = new ControlsView({ locale, onTogglePlay: () => toggles++, onContinue() {}, onOpenStats() {}, onOpenManager() {}, onOpenTactics: () => tactics++ });
  /** @type {Record<string, any>} */
  const els = {};
  const root = /** @type {any} */ (fakeElement());
  root.querySelector = (/** @type {string} */ sel) => {
    if (!els[sel]) {
      const el = /** @type {any} */ (fakeElement());
      /** @type {Record<string, () => void>} */
      el.handlers = {};
      el.addEventListener = (/** @type {string} */ type, /** @type {() => void} */ fn) => (el.handlers[type] = fn);
      els[sel] = el;
    }
    return els[sel];
  };
  root.querySelectorAll = () => [];
  root.addEventListener = () => {};
  root.innerHTML = '';
  view.mount(root);

  assert.ok(view.partialHtml.includes(`id="ctrl-stats" aria-label="Match statistics" title="Match statistics">${STATS_ICON}</button>`));
  assert.ok(view.partialHtml.includes(`>${COACH_ICON}</button>`));
  assert.equal(els['#ctrl-stats'].textContent, '');
  assert.equal(els['#ctrl-manager'].textContent, '');
  assert.equal(els['#ctrl-stats'].attrs['aria-label'], 'Match statistics');
  assert.equal(els['#ctrl-manager'].attrs.title, 'Squad & substitutions');
  assert.equal(els['#ctrl-tactics'].attrs['aria-label'], 'Team tactics');
  const html = view.partialHtml;
  assert.ok(html.indexOf('id="ctrl-stats"') < html.indexOf('id="ctrl-tactics"') && html.indexOf('id="ctrl-tactics"') < html.indexOf('id="ctrl-manager"'), 'Stats, Tactics, Coach');
  locale.setLocale('pt-PT');
  assert.equal(els['#ctrl-stats'].attrs['aria-label'], 'Estatísticas do jogo');
  assert.equal(els['#ctrl-manager'].attrs['aria-label'], 'Plantel e substituições');
  assert.equal(els['#ctrl-tactics'].attrs.title, 'Tática da equipa');
  els['#ctrl-tactics'].handlers.click();
  assert.equal(tactics, 1);

  els['#ctrl-play'].handlers.click();
  els['#ctrl-play'].handlers.click();
  assert.equal(toggles, 2, 'kick-off, resume and pause all go through the one button');
  view.destroy?.();
});

test('the one button kicks off, pauses, resumes, and carries on after half-time', () => {
  const seed = 21;
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  const ctrl = new MatchController({ input: { v: 1, seed, configHash, home, away }, config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  assert.equal(playPauseIndicator(ctrl.buildFrame([])).icon, '>', 'ready for kick-off');
  ctrl.togglePlay();
  assert.equal(playPauseIndicator(ctrl.buildFrame([])).icon, '||', 'kicked off');
  ctrl.tickFrame(1 / 60);
  ctrl.togglePlay();
  assert.equal(playPauseIndicator(ctrl.buildFrame([])).icon, '>', 'paused');
  ctrl.togglePlay();
  assert.equal(ctrl.playbackState, 'FULL_MATCH', 'resumed');
  let frames = 0;
  while (/** @type {string} */ (ctrl.playbackState) !== 'HALF_TIME' && frames++ < 100000) ctrl.tickFrame(1 / 60);
  assert.equal(playPauseIndicator(ctrl.buildFrame([])).icon, '>', 'half-time');
  ctrl.togglePlay();
  assert.equal(ctrl.playbackState, 'FULL_MATCH', 'the second half starts from the same button');
  ctrl.destroy();
});

test('replayLastMoments replays the latest moments from the ring, never touches the live engine, then resumes', () => {
  const seed = 12;
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  const ctrl = new MatchController({ input: { v: 1, seed, configHash, home, away }, config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  assert.equal(ctrl.replayLastMoments(), false, 'nothing to replay at kick-off');
  ctrl.play();
  for (let i = 0; i < 400; i++) ctrl.tickFrame(1 / 60);
  while (ctrl.preRoll !== null || ctrl.animationHold > 0) ctrl.tickFrame(1 / 60); // let an Auto Highlights pre-roll finish
  const tick = ctrl.engine.tick;
  const hash = ctrl.engine.hash();
  assert.equal(ctrl.replayLastMoments(), true);
  assert.equal(ctrl.playbackState, 'REPLAY');
  assert.equal(ctrl.queueCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '4-4-2' } }).code, 'REPLAY_ACTIVE');
  let frames = 0;
  while (ctrl.playbackState === 'REPLAY' && frames++ < 2000) {
    const f = ctrl.tickFrame(1 / 60);
    assert.equal(f.newEvents.length, 0, 'the replay does not repeat commentary');
  }
  assert.ok(frames > 10, 'the replay lasts a few seconds');
  assert.equal(ctrl.playbackState, 'FULL_MATCH', 'returns to live playback');
  assert.equal(ctrl.engine.tick, tick, 'the live engine did not advance during the replay');
  assert.equal(ctrl.engine.hash(), hash);

  // Tapping again during a replay skips it; pausing ends it and pauses.
  ctrl.replayLastMoments();
  assert.equal(ctrl.playbackState, 'REPLAY');
  ctrl.replayLastMoments();
  assert.equal(ctrl.playbackState, 'FULL_MATCH');
  ctrl.replayLastMoments();
  ctrl.togglePlay();
  assert.equal(ctrl.playbackState, 'PAUSED');
  // From a paused match the replay returns to PAUSED.
  assert.equal(ctrl.replayLastMoments(), true);
  while (ctrl.playbackState === 'REPLAY') ctrl.tickFrame(1 / 60);
  assert.equal(ctrl.playbackState, 'PAUSED');
  assert.equal(ctrl.running, false);
  ctrl.destroy();
});

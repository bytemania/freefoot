import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { ControlsView, pacingIndicator, playPauseIndicator, COACH_ICON, STATS_ICON } from '../../src/ui/views/ControlsView.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { generateSquad } from '../../src/shared/squadgen.js';
import { configHash } from '../../generated/config.js';
import { fakeElement, fakeRoot } from './fakedom.js';

const PAUSED_STATES = ['PAUSED', 'PAUSED_HIGHLIGHT', 'PAUSED_FORCED', 'HALF_TIME', 'FULL_TIME'];
const ALL_STATES = ['FULL_MATCH', 'FAST_FORWARD', 'REPLAY', ...PAUSED_STATES];
const PLAY_PAUSE_GLYPHS = ['||', '|>'];

test('pacingIndicator: >> fast-forward, > live; paused shows the resume speed, dimmed, never ||', () => {
  assert.equal(pacingIndicator({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'FAST' }).icon, '>>');
  assert.equal(pacingIndicator({ playbackState: 'FAST_FORWARD', mode: 'best_moments' }).icon, '>>');
  assert.equal(pacingIndicator({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'LIVE' }).icon, '>');
  assert.equal(pacingIndicator({ playbackState: 'FULL_MATCH', mode: 'full' }).icon, '>');
  assert.equal(pacingIndicator({ playbackState: 'REPLAY', mode: 'auto_highlights', autoPacing: 'LIVE' }).icon, '>');
  for (const ps of PAUSED_STATES) {
    const fast = pacingIndicator({ playbackState: ps, mode: 'auto_highlights', autoPacing: 'FAST' });
    assert.deepEqual(fast, { icon: '>>', kind: 'paused', labelKey: 'buttons.pacingPaused', resumeLabelKey: 'buttons.pacingFast' }, ps);
    const live = pacingIndicator({ playbackState: ps, mode: 'auto_highlights', autoPacing: 'WATCH' });
    assert.deepEqual(live, { icon: '>', kind: 'paused', labelKey: 'buttons.pacingPaused', resumeLabelKey: 'buttons.pacingLive' }, ps);
    assert.equal(pacingIndicator({ playbackState: ps, mode: 'full' }).icon, '>', ps);
  }
  for (const ps of ALL_STATES) {
    for (const autoPacing of ['FAST', 'WATCH', 'LIVE']) {
      assert.ok(!PLAY_PAUSE_GLYPHS.includes(pacingIndicator({ playbackState: ps, mode: 'auto_highlights', autoPacing }).icon), `${ps}/${autoPacing}`);
    }
  }
});

test('ControlsView: in every playback state exactly one of {badge, toggle} shows a play / pause glyph (the toggle)', () => {
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const view = new ControlsView({ locale, onTogglePlay() {}, onContinue() {}, onOpenStats() {}, onOpenManager() {} });
  const root = fakeRoot();
  view.root = root;
  const badge = root.querySelector('#ctrl-pacing');
  const play = root.querySelector('#ctrl-play');
  // The initial markup, before any frame, already follows the rule.
  const initial = view.partialHtml.match(/id="ctrl-pacing"[^>]*>([^<]*)</);
  assert.ok(initial && initial[1] === '&gt;', 'the badge starts on the live speed, not ||');
  for (const ps of ALL_STATES) {
    for (const autoPacing of ['FAST', 'WATCH']) {
      view.update({ playbackState: ps, mode: 'auto_highlights', autoPacing, countdownRemaining: 0 });
      const shown = [badge.textContent, play.textContent].filter((g) => PLAY_PAUSE_GLYPHS.includes(g));
      assert.deepEqual(shown, [play.textContent], `${ps}/${autoPacing}: only the toggle shows || or |>`);
      assert.ok(['>', '>>'].includes(badge.textContent), `${ps}/${autoPacing}: the badge shows a speed`);
      assert.equal(badge.classList.contains('is-paused'), PAUSED_STATES.includes(ps), `${ps}: dimmed only while paused`);
    }
  }
});

test('ControlsView renders only the icon in the badge, with a localized tooltip', () => {
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const view = new ControlsView({ locale, onTogglePlay() {}, onContinue() {}, onOpenStats() {}, onOpenManager() {} });
  const root = fakeRoot();
  view.root = root;
  const badge = root.querySelector('#ctrl-pacing');

  view.update({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'FAST', countdownRemaining: 0 });
  assert.equal(badge.textContent, '>>');
  assert.ok(badge.classList.contains('is-fast'));
  assert.equal(badge.attrs.title, 'Fast-forward (60x) · Tap to replay the last moments');

  view.update({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'LIVE', countdownRemaining: 0 });
  assert.equal(badge.textContent, '>');
  assert.ok(badge.classList.contains('is-live') && !badge.classList.contains('is-fast'));

  locale.setLocale('pt-PT');
  view.update({ playbackState: 'PAUSED', mode: 'auto_highlights', autoPacing: 'LIVE', countdownRemaining: 0 });
  assert.equal(badge.textContent, '>');
  assert.ok(badge.classList.contains('is-paused') && !badge.classList.contains('is-live'));
  assert.equal(badge.attrs['aria-label'], 'Em pausa · Ao vivo (1x) · Toque para rever os últimos lances');
  view.update({ playbackState: 'PAUSED', mode: 'auto_highlights', autoPacing: 'FAST', countdownRemaining: 0 });
  assert.equal(badge.textContent, '>>');
  assert.equal(badge.attrs.title, 'Em pausa · Avanço rápido (60x) · Toque para rever os últimos lances');
  view.update({ playbackState: 'REPLAY', mode: 'auto_highlights', autoPacing: 'LIVE', countdownRemaining: 0 });
  assert.equal(badge.attrs.title, 'Ao vivo (1x) · Toque para saltar a repetição');
});

test('ControlsView: Coach and Stats are icon-only SVG buttons with localized aria-label / title, and the badge is a replay button', () => {
  assert.match(COACH_ICON, /^<svg[^>]*aria-hidden="true"/);
  assert.match(STATS_ICON, /^<svg[^>]*aria-hidden="true"/);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  let replays = 0;
  const view = new ControlsView({ locale, onTogglePlay() {}, onContinue() {}, onOpenStats() {}, onOpenManager() {}, onReplay: () => replays++ });
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

  // The partial has SVG icons and no text label on Stats / Coach.
  assert.ok(view.partialHtml.includes(`id="ctrl-stats" aria-label="Match statistics" title="Match statistics">${STATS_ICON}</button>`));
  assert.ok(view.partialHtml.includes(`>${COACH_ICON}</button>`));
  assert.match(view.partialHtml, /<button type="button" class="pacing-badge[^"]*" id="ctrl-pacing"/);
  assert.equal(els['#ctrl-stats'].textContent, '');
  assert.equal(els['#ctrl-manager'].textContent, '');
  assert.equal(els['#ctrl-stats'].attrs['aria-label'], 'Match statistics');
  assert.equal(els['#ctrl-stats'].attrs.title, 'Match statistics');
  assert.equal(els['#ctrl-manager'].attrs['aria-label'], 'Coach & tactics');
  assert.equal(els['#ctrl-manager'].attrs.title, 'Coach & tactics');
  locale.setLocale('pt-PT');
  assert.equal(els['#ctrl-stats'].attrs['aria-label'], 'Estatísticas do jogo');
  assert.equal(els['#ctrl-manager'].attrs['aria-label'], 'Treinador e tática');

  els['#ctrl-pacing'].handlers.click();
  assert.equal(replays, 1, 'tapping the speed badge triggers the replay action');
  view.destroy?.();
});

test('replayLastMoments replays the latest moments from the ring, never touches the live engine, then resumes', () => {
  const seed = 12;
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  const ctrl = new MatchController({ input: { v: 1, seed, configHash, home, away }, config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  assert.equal(ctrl.replayLastMoments(), false, 'nothing to replay at kick-off');
  ctrl.play();
  for (let i = 0; i < 400; i++) ctrl.tickFrame(1 / 60);
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

test('Play / Pause sits right beside the top-right speed badge and shows || while playing, |> while paused, with localized labels', () => {
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  let toggles = 0;
  const view = new ControlsView({ locale, onTogglePlay: () => toggles++, onContinue() {}, onOpenStats() {}, onOpenManager() {} });
  // Layout: the badge and the Play / Pause button share the right-edge group, badge first, button right after it.
  const html = view.partialHtml.replace(/\s+/g, ' ');
  const group = html.match(/<div class="ctrl-transport">(.*?)<\/div>/);
  assert.ok(group, 'a right-edge transport group');
  const ids = [...group[1].matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['ctrl-pacing', 'ctrl-play']);
  assert.ok(html.indexOf('id="ctrl-stats"') < html.indexOf('ctrl-transport'), 'Stats / Coach stay on the left');

  assert.deepEqual(playPauseIndicator({ playbackState: 'FULL_MATCH' }), { icon: '||', labelKey: 'buttons.pause' });
  assert.deepEqual(playPauseIndicator({ playbackState: 'FAST_FORWARD' }), { icon: '||', labelKey: 'buttons.pause' });
  for (const ps of ['PAUSED', 'PAUSED_HIGHLIGHT', 'PAUSED_FORCED', 'HALF_TIME', 'FULL_TIME', 'REPLAY']) {
    assert.equal(playPauseIndicator({ playbackState: ps }).icon, '|>', ps);
  }

  const root = fakeRoot();
  view.root = root;
  const play = root.querySelector('#ctrl-play');
  view.update({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'FAST', countdownRemaining: 0 });
  assert.equal(play.textContent, '||');
  assert.equal(play.attrs['aria-label'], 'Pause');
  assert.equal(play.attrs.title, 'Pause');
  assert.equal(root.querySelector('#ctrl-pacing').textContent, '>>');
  view.update({ playbackState: 'PAUSED', mode: 'auto_highlights', autoPacing: 'FAST', countdownRemaining: 0 });
  assert.equal(play.textContent, '|>');
  assert.equal(play.attrs['aria-label'], 'Play');
  locale.setLocale('pt-PT');
  view.update({ playbackState: 'PAUSED', mode: 'auto_highlights', autoPacing: 'FAST', countdownRemaining: 0 });
  assert.equal(play.attrs['aria-label'], 'Reproduzir');
  assert.equal(play.attrs.title, 'Reproduzir');
  view.update({ playbackState: 'FULL_MATCH', mode: 'full', countdownRemaining: 0 });
  assert.equal(play.textContent, '||');
  assert.equal(play.attrs['aria-label'], 'Pausar');
  assert.equal(root.querySelector('#ctrl-pacing').textContent, '>');
  assert.equal(toggles, 0);
});

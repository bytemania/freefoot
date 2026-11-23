import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { ControlsView, pacingIndicator } from '../../src/ui/views/ControlsView.js';
import { fakeRoot } from './fakedom.js';

test('pacingIndicator: >> fast-forward, > live, || paused', () => {
  assert.equal(pacingIndicator({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'FAST' }).icon, '>>');
  assert.equal(pacingIndicator({ playbackState: 'FAST_FORWARD', mode: 'best_moments' }).icon, '>>');
  assert.equal(pacingIndicator({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'LIVE' }).icon, '>');
  assert.equal(pacingIndicator({ playbackState: 'FULL_MATCH', mode: 'full' }).icon, '>');
  assert.equal(pacingIndicator({ playbackState: 'REPLAY', mode: 'auto_highlights', autoPacing: 'LIVE' }).icon, '>');
  for (const ps of ['PAUSED', 'PAUSED_HIGHLIGHT', 'PAUSED_FORCED', 'HALF_TIME', 'FULL_TIME']) {
    assert.equal(pacingIndicator({ playbackState: ps, mode: 'auto_highlights', autoPacing: 'FAST' }).icon, '||', ps);
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
  assert.equal(badge.attrs.title, 'Fast-forward (60x)');

  view.update({ playbackState: 'FULL_MATCH', mode: 'auto_highlights', autoPacing: 'LIVE', countdownRemaining: 0 });
  assert.equal(badge.textContent, '>');
  assert.ok(badge.classList.contains('is-live') && !badge.classList.contains('is-fast'));

  locale.setLocale('pt-PT');
  view.update({ playbackState: 'PAUSED', mode: 'auto_highlights', autoPacing: 'LIVE', countdownRemaining: 0 });
  assert.equal(badge.textContent, '||');
  assert.equal(badge.attrs['aria-label'], 'Em pausa');
});

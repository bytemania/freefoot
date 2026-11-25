// VAR HUD banner (src/ui/views/VarHudView.js): VAR CHECK with what is checked, then the decision (an overturn's own
// headline, or CHECK COMPLETE over the call that stands); it clears when play resumes, on a reset or seek, and
// shows nothing in a replay; en-GB and pt-PT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { VarHudView } from '../../src/ui/views/VarHudView.js';
import { fakeRoot } from './fakedom.js';

const CHECK = { type: 'VAR_CHECK', tick: 5000, meta: { incident: 'GOAL' } };
const DISALLOWED = { type: 'VAR_DECISION', tick: 5200, meta: { incident: 'GOAL', outcome: 'goalDisallowed', overturned: true } };
const STANDS = { type: 'VAR_DECISION', tick: 5200, meta: { incident: 'RED_CARD', outcome: 'yellowStands', overturned: false } };
const DEAD = { state: 'DEAD_BALL' };
const LIVE = { state: 'IN_PLAY' };

/** @param {'en-GB' | 'pt-PT'} [initial] */
function setup(initial = 'en-GB') {
  let now = 0;
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial });
  const view = new VarHudView({ locale, now: () => now, minDecisionMs: 1800, maxDecisionMs: 6000 });
  const root = fakeRoot();
  view.mount(root);
  const el = root.querySelector('.var-hud');
  return { view, el, locale, advance: (/** @type {number} */ ms) => (now += ms) };
}

test('VAR CHECK, then GOAL DISALLOWED; it clears once play resumes (after the minimum time)', () => {
  const { view, el, advance } = setup();
  assert.match(el.className, /is-hidden/);
  view.update({ tick: 5000, playbackState: 'FULL_MATCH', newEvents: [CHECK], restart: DEAD });
  assert.deepEqual(view.shown, { phase: 'check', headline: 'check', detail: 'checkGoal', tone: 'check' });
  assert.match(el.innerHTML, /VAR CHECK/);
  assert.match(el.innerHTML, /Checking goal/);
  assert.match(el.className, /is-check/);
  // Still under review while the ball is dead.
  advance(5000);
  view.update({ tick: 5100, playbackState: 'FULL_MATCH', newEvents: [], restart: DEAD });
  assert.equal(view.shown?.phase, 'check');
  view.update({ tick: 5200, playbackState: 'FULL_MATCH', newEvents: [DISALLOWED], restart: DEAD });
  assert.match(el.innerHTML, /GOAL DISALLOWED/);
  assert.match(el.innerHTML, /Decision overturned/);
  assert.match(el.className, /is-overturned/);
  // Play resumes at once: the call stays up for the minimum time first.
  advance(500);
  view.update({ tick: 5240, playbackState: 'FULL_MATCH', newEvents: [], restart: LIVE });
  assert.equal(view.shown?.headline, 'goalDisallowed');
  advance(1500);
  view.update({ tick: 5260, playbackState: 'FULL_MATCH', newEvents: [], restart: LIVE });
  assert.equal(view.shown, null);
  assert.match(el.className, /is-hidden/);
});

test('a call that stands: CHECK COMPLETE over the decision; it times out even if play stays dead', () => {
  const { view, el, advance } = setup();
  view.update({ tick: 5000, newEvents: [{ ...CHECK, meta: { incident: 'RED_CARD' } }], restart: DEAD });
  assert.match(el.innerHTML, /Possible red card/);
  view.update({ tick: 5200, newEvents: [STANDS], restart: DEAD });
  assert.match(el.innerHTML, /CHECK COMPLETE/);
  assert.match(el.innerHTML, /Yellow card stands/);
  assert.match(el.className, /is-stands/);
  advance(6000);
  view.update({ tick: 5300, newEvents: [], restart: DEAD });
  assert.equal(view.shown, null);
});

test('a reset or seek (the tick goes back) and a replay clear the banner', () => {
  const { view } = setup();
  view.update({ tick: 5000, newEvents: [CHECK], restart: DEAD });
  assert.ok(view.shown);
  view.update({ tick: 1200, newEvents: [], restart: LIVE });
  assert.equal(view.shown, null, 'seeked back');
  view.update({ tick: 5000, newEvents: [CHECK], restart: DEAD });
  view.update({ tick: 5001, playbackState: 'REPLAY', newEvents: [CHECK], restart: DEAD });
  assert.equal(view.shown, null, 'nothing in a replay');
});

test('pt-PT: VERIFICAÇÃO VAR and GOLO ANULADO; switching language re-renders', () => {
  const { view, el, locale } = setup('pt-PT');
  view.update({ tick: 5000, newEvents: [CHECK], restart: DEAD });
  assert.match(el.innerHTML, /VERIFICAÇÃO VAR/);
  assert.match(el.innerHTML, /A verificar golo/);
  view.update({ tick: 5200, newEvents: [DISALLOWED], restart: DEAD });
  assert.match(el.innerHTML, /GOLO ANULADO/);
  locale.setLocale('en-GB');
  assert.match(el.innerHTML, /GOAL DISALLOWED/);
});

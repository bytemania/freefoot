// Shouts panel (src/ui/views/ShoutsView.js): the ten shouts in a grid with hints, a tap sends ISSUE_SHOUT, the
// shout in effect, cooldowns and the side's receptiveness, PT / EN, and nothing during a replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { ShoutsView } from '../../src/ui/views/ShoutsView.js';
import { generateSquad } from '../../src/shared/squadgen.js';
import { fakeElement } from './fakedom.js';

/** @param {number} seed */
function makeController(seed) {
  const home = { ...generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'human' }), shouts: true };
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return new MatchController({ input: { v: 1, seed, configHash, home, away }, config, mode: 'full', schedule: () => 1, cancelSchedule: () => {} });
}

/** @param {any} view */
function mount(view) {
  /** @type {Record<string, any>} */
  const els = {};
  const root = /** @type {any} */ (fakeElement());
  root.querySelector = (/** @type {string} */ sel) => (els[sel] ??= fakeElement());
  root.querySelectorAll = () => [];
  /** @type {(ev: any) => void} */
  let onClick = () => {};
  root.addEventListener = (/** @type {string} */ type, /** @type {(ev: any) => void} */ fn) => {
    if (type === 'click') onClick = fn;
  };
  view.mount(root);
  /** @param {string} id */
  const tap = (id) => {
    const el = { getAttribute: (/** @type {string} */ k) => (k === 'data-shout' ? id : null) };
    onClick({ target: { closest: (/** @type {string} */ sel) => (sel === '[data-shout]' ? el : null) } });
  };
  return { els, tap, root };
}

/** Labels of the grid's buttons, disabled ones in brackets. @param {string} html */
const buttons = (html) =>
  [...html.matchAll(/<button type="button" class="sh-btn[^"]*" data-shout="([^"]+)"( disabled)?><span class="sh-label">([^<]*)/g)].map((m) => (m[2] ? `[${m[3]}]` : m[3]));

test('ShoutsView: ten shouts in config order with hints, in English and Portuguese', () => {
  const ctrl = makeController(3);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const view = new ShoutsView({ locale, shouts: config.shouts.shouts, onCommand: (cmd) => ctrl.queueCommand(cmd) });
  const { els } = mount(view);
  view.update({ state: ctrl.engine.state, playbackState: ctrl.playbackState });
  assert.deepEqual(buttons(els['#sh-grid'].innerHTML), ['Focus', 'Push forward', 'Tighten up', 'Encourage', 'Demand more', 'Fire up', 'Calm down', 'Praise', 'Get creative', 'Berate']);
  assert.equal((els['#sh-grid'].innerHTML.match(/class="sh-hint"/g) ?? []).length, 10);
  assert.equal(els['#sh-mood'].textContent, 'Team mood: Engaged');
  assert.equal(els['#sh-active'].textContent, 'No shout in effect');
  locale.setLocale('pt-PT');
  assert.deepEqual(buttons(els['#sh-grid'].innerHTML).slice(0, 3), ['Concentração', 'Subir no terreno', 'Fechar atrás']);
  assert.equal(els['#sh-mood'].textContent, 'Ânimo da equipa: Atenta');
});

test('ShoutsView: a tap sends ISSUE_SHOUT; the shout runs with its minutes left and cools down', () => {
  const ctrl = makeController(4);
  for (let i = 0; i < 2000 && ctrl.engine.state.restart.state !== 'IN_PLAY'; i++) ctrl.stepTicks(1);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  /** @type {any[]} */
  const sent = [];
  const view = new ShoutsView({ locale, shouts: config.shouts.shouts, onCommand: (cmd) => (sent.push(cmd), ctrl.queueCommand(cmd)) });
  const { els, tap } = mount(view);
  const refresh = () => view.update({ state: ctrl.engine.state, playbackState: ctrl.playbackState });
  refresh();
  tap('fireUp');
  assert.deepEqual(sent, [{ issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 0, payload: { shout: 'fireUp' } }]);
  refresh();
  assert.ok(buttons(els['#sh-grid'].innerHTML).every((b) => b.startsWith('[')), 'all wait while the shout is on its way');
  ctrl.stepTicks(1);
  refresh();
  const s = ctrl.engine.state;
  assert.equal(s.teams[0].shout?.count, 1);
  const grid = buttons(els['#sh-grid'].innerHTML);
  assert.match(grid[5], /^\[Fire up/, 'Fire up cools down');
  assert.match(els['#sh-grid'].innerHTML, /data-shout="fireUp" disabled><span class="sh-label">Fire up<span class="sh-cd">6′<\/span>/);
  assert.equal(grid[0], 'Focus', 'the others are free');
  if (s.teams[0].shout?.active) assert.equal(els['#sh-active'].textContent, 'Fire up · 8′ left');
  // Back-to-back shouts overwhelm the side.
  for (const id of ['focus', 'encourage', 'demandMore']) {
    tap(id);
    ctrl.stepTicks(1);
  }
  refresh();
  assert.equal(els['#sh-mood'].textContent, 'Team mood: Overwhelmed');
  assert.ok(els['#sh-mood'].className.includes('is-overwhelmed'));
});

test('ShoutsView: a refused shout shows the reason; nothing is sent during a replay', () => {
  const ctrl = makeController(5);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  /** @type {any[]} */
  const sent = [];
  const view = new ShoutsView({ locale, shouts: config.shouts.shouts, onCommand: (cmd) => (sent.push(cmd), { ok: false, code: 'SHOUT_COOLDOWN' }) });
  const { els, tap, root } = mount(view);
  view.update({ state: ctrl.engine.state, playbackState: 'PAUSED' });
  tap('praise');
  assert.equal(els['#sh-error'].textContent, 'That shout was used too recently.');
  view.update({ state: ctrl.engine.state, playbackState: 'REPLAY' });
  tap('praise');
  assert.equal(sent.length, 1);
  assert.ok(root.classList.contains('is-disabled'));
});

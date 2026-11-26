// Tactics panel (src/ui/views/TacticsView.js): tabs and rows built from config, staging, one SET_INSTRUCTIONS
// with all nine instructions on Confirm, the pending note, Reset, PT / EN strings, and the Manager's Pending list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { hasPendingSubmission, pendingInstructions, pendingSubmission } from '../../src/runtime/managerPending.js';
import { TacticsView } from '../../src/ui/views/TacticsView.js';
import { ManagerView } from '../../src/ui/views/ManagerView.js';
import { generateSquad } from '../../src/shared/squadgen.js';
import { fakeElement } from './fakedom.js';

/** @param {number} seed */
function makeController(seed) {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'human' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return new MatchController({ input: { v: 1, seed, configHash, home, away }, config, mode: 'full', schedule: () => 1, cancelSchedule: () => {} });
}

/** @param {MatchController} ctrl */
function toOpenPlay(ctrl) {
  for (let i = 0; i < 2000 && ctrl.engine.state.restart.state !== 'IN_PLAY'; i++) ctrl.stepTicks(1);
  assert.equal(ctrl.engine.state.restart.state, 'IN_PLAY');
}

/**
 * A mounted view over a fake DOM; `tap({...attrs})` delivers a click on an element carrying those attributes.
 * @param {any} view
 */
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
  /** @param {Record<string, string>} attrs */
  const tap = (attrs) => {
    const el = { getAttribute: (/** @type {string} */ k) => attrs[k] ?? null };
    onClick({ target: { closest: (/** @type {string} */ sel) => (sel.slice(1, -1) in attrs ? el : null) } });
  };
  return { els, tap, root };
}

/** Option labels of the rendered rows, active ones starred. @param {string} html */
const rows = (html) =>
  [...html.matchAll(/<div class="tac-row" data-row="([^"]+)">(.*?)<\/div><\/div>/g)].map((m) => {
    const opts = [...m[2].matchAll(/class="tac-opt( is-active)?[^"]*"[^>]*>([^<]*)</g)].map((o) => (o[1] ? `*${o[2]}` : o[2]));
    return `${m[1]}: ${opts.join(' / ')}`;
  });

test('TacticsView: In possession lists tempo, passing, attacking corridor, transition and time-wasting; Out of possession the rest', () => {
  const ctrl = makeController(3);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const view = new TacticsView({ locale, instructions: config.tactics.instructions, onCommand: (cmd) => ctrl.queueCommand(cmd) });
  const { els, tap } = mount(view);
  view.update({ state: ctrl.engine.state, playbackState: ctrl.playbackState });
  assert.deepEqual(rows(els['#tac-rows'].innerHTML), [
    'tempo: Slow / *Standard / Fast',
    'directness: Short / *Mixed / Direct',
    'attackFocus: Wings / *Mixed / Centre',
    'attackTransition: Hold shape / *Balanced / Counter',
    'timeWasting: *Never / Sometimes / Always',
  ]);
  assert.match(els['#tac-tabs'].innerHTML, /is-active[^>]*data-tac-tab="inPossession">In possession</);
  assert.doesNotMatch(els['#tac-tabs'].innerHTML, /tac-dot/);
  tap({ 'data-tac-tab': 'outOfPossession' });
  assert.deepEqual(rows(els['#tac-rows'].innerHTML), [
    'defensiveLine: Low / *Standard / High',
    'marking: *Zonal / Man-to-man',
    'defensiveTransition: Regroup / *Balanced / Counter-press',
    'tackling: Stay on feet / *Normal / Get stuck in',
  ]);
  assert.match(els['#tac-rows'].innerHTML, /Holds the shape/, 'the hint of the chosen option');
  locale.setLocale('pt-PT');
  assert.match(els['#tac-tabs'].innerHTML, />Com Bola</);
  assert.match(els['#tac-tabs'].innerHTML, />Sem Bola</);
  assert.match(els['#tac-rows'].innerHTML, />Entrar duro</);
  tap({ 'data-tac-tab': 'inPossession' });
  assert.match(els['#tac-rows'].innerHTML, /Corredor de ataque.*>Alas<.*>Misto<.*>Centro</);
});

test('TacticsView: staging marks the tab, Confirm sends all nine instructions once, applied at the next stoppage', () => {
  const ctrl = makeController(4);
  toOpenPlay(ctrl);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  /** @type {any[]} */
  const sent = [];
  const view = new TacticsView({ locale, instructions: config.tactics.instructions, onCommand: (cmd) => (sent.push(cmd), ctrl.queueCommand(cmd)) });
  const { els, tap } = mount(view);
  const refresh = () => view.update({ state: ctrl.engine.state, playbackState: ctrl.playbackState });
  refresh();
  assert.equal(els['#tac-confirm'].disabled, true, 'nothing to confirm');
  assert.equal(els['#tac-reset'].disabled, true, 'already at the defaults');
  tap({ 'data-instr': 'attackFocus', 'data-opt': 'wings' });
  tap({ 'data-instr': 'tempo', 'data-opt': 'fast' });
  assert.match(els['#tac-tabs'].innerHTML, /In possession<span class="tac-dot"/);
  assert.match(els['#tac-rows'].innerHTML, /Plays down the flanks · fewer central entries/);
  assert.equal(els['#tac-confirm'].disabled, false);
  tap({ 'data-tac-confirm': '1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'SET_INSTRUCTIONS');
  assert.equal(Object.keys(sent[0].payload.instructions).length, 9);
  assert.equal(sent[0].payload.instructions.attackFocus, 'wings');
  assert.equal(sent[0].payload.instructions.tempo, 'fast');
  const s = ctrl.engine.state;
  assert.equal(s.teams[0].instructions.tempo, 'standard', 'waits for a stoppage');
  refresh();
  assert.equal(els['#tac-status'].textContent, 'Applies at the next stoppage.');
  assert.equal(els['#tac-confirm'].disabled, true);
  assert.match(els['#tac-rows'].innerHTML, /\*?class="tac-opt is-active[^"]*"[^>]*data-instr="tempo" data-opt="fast"/, 'shows what is waiting');
  // The Manager lists it but stays usable.
  assert.deepEqual(pendingSubmission(s, 0).map((x) => x.kind), ['INSTRUCTIONS']);
  assert.equal(hasPendingSubmission(s, 0), false);
  for (let i = 0; i < 6000 && pendingInstructions(s, 0) !== null; i++) ctrl.stepTicks(1);
  assert.equal(s.teams[0].instructions.tempo, 'fast');
  refresh();
  assert.ok(els['#tac-status'].classList.contains('is-hidden'));
  // Reset stages the defaults.
  tap({ 'data-tac-reset': '1' });
  assert.match(els['#tac-rows'].innerHTML, /class="tac-opt is-active is-default"[^>]*data-instr="tempo" data-opt="standard"/);
  assert.equal(els['#tac-confirm'].disabled, false);
  view.discardDraft();
  assert.equal(els['#tac-confirm'].disabled, true);
});

test('TacticsView: nothing can be staged or sent during a replay', () => {
  const ctrl = makeController(5);
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  /** @type {any[]} */
  const sent = [];
  const view = new TacticsView({ locale, instructions: config.tactics.instructions, onCommand: (cmd) => (sent.push(cmd), { ok: true, code: null }) });
  const { tap, root } = mount(view);
  view.update({ state: ctrl.engine.state, playbackState: 'REPLAY' });
  tap({ 'data-instr': 'tempo', 'data-opt': 'fast' });
  tap({ 'data-tac-confirm': '1' });
  assert.equal(sent.length, 0);
  assert.ok(root.classList.contains('is-disabled'));
});

test('ManagerView: pending team instructions appear in the one Pending list, in both languages', () => {
  const ctrl = makeController(6);
  toOpenPlay(ctrl);
  ctrl.queueCommand({ issuer: 'human', type: 'SET_INSTRUCTIONS', teamIndex: 0, payload: { instructions: { marking: 'manToMan' } } });
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  const view = new ManagerView({ locale, teamIndex: 0, onCommand: (cmd) => ctrl.queueCommand(cmd) });
  const { els } = mount(view);
  view.update({ state: ctrl.engine.state, playbackState: ctrl.playbackState });
  assert.match(els['#mgr-pending-list'].innerHTML, /New team instructions/);
  assert.equal(view.locked, false, 'instructions do not lock the Manager');
  locale.setLocale('pt-PT');
  assert.match(els['#mgr-pending-list'].innerHTML, /Novas instruções táticas/);
});

test('TacticsView: Plan A/B pills, staged Plan B preview, Reset to plan, and cancel via active pill', () => {
  const seed = 11;
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'human' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  const gegen = config.tacticalPresets.presets.find((/** @type {any} */ p) => p.id === 'gegenpress');
  const lowBlock = config.tacticalPresets.presets.find((/** @type {any} */ p) => p.id === 'low-block');
  home.formationId = gegen.formationId;
  home.instructions = { ...gegen.instructions };
  home.tacticalPlans = {
    planA: { tacticId: gegen.id, formationId: gegen.formationId, instructions: { ...gegen.instructions }, formFam: 80, instrFam: 80 },
    planB: { tacticId: lowBlock.id, formationId: lowBlock.formationId, instructions: { ...lowBlock.instructions }, formFam: 50, instrFam: 50 },
  };
  const ctrl = new MatchController({ input: { v: 1, seed, configHash, home, away }, config, mode: 'full', schedule: () => 1, cancelSchedule: () => {} });
  toOpenPlay(ctrl);

  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  /** @type {any[]} */
  const sent = [];
  const view = new TacticsView({ locale, instructions: config.tactics.instructions, onCommand: (cmd) => (sent.push(cmd), ctrl.queueCommand(cmd)) });
  const { els, tap } = mount(view);
  const refresh = () => view.update({ state: ctrl.engine.state, playbackState: ctrl.playbackState });
  refresh();

  assert.ok(!els['#tac-plan-bar'].classList.contains('is-hidden'));
  assert.match(els['#tac-plan-bar'].innerHTML, /Gegenpress/);
  assert.match(els['#tac-plan-bar'].innerHTML, /Low Block/);
  assert.equal(els['#tac-reset'].textContent, 'Reset to plan');
  assert.equal(els['#tac-reset'].disabled, true, 'already matches Plan A');

  // Tweak one instruction -> familiarity preview shows delta and Reset to plan enables
  tap({ 'data-instr': 'tempo', 'data-opt': 'slow' });
  assert.ok(!els['#tac-fam-preview'].classList.contains('is-hidden'));
  assert.match(els['#tac-fam-preview'].innerHTML, /Familiarity: 80% → 75%/);
  assert.match(els['#tac-fam-preview'].innerHTML, /Drops to Competent/);
  assert.equal(els['#tac-reset'].disabled, false);
  tap({ 'data-tac-reset': '1' });
  assert.equal(els['#tac-reset'].disabled, true);

  // Stage Plan B switch -> Confirm sends SWITCH_TACTIC_PLAN
  tap({ 'data-plan': 'B' });
  assert.match(els['#tac-fam-preview'].innerHTML, /Familiarity: 80% → 50%/);
  assert.equal(els['#tac-confirm'].disabled, false);
  tap({ 'data-tac-confirm': '1' });
  assert.equal(sent[sent.length - 1].type, 'SWITCH_TACTIC_PLAN');
  assert.equal(sent[sent.length - 1].payload.plan, 'B');
  refresh();
  assert.match(els['#tac-status'].textContent, /Switch to Plan B queued/);

  // Tapping active Plan A pill cancels the queued switch
  tap({ 'data-plan': 'A' });
  assert.equal(sent[sent.length - 1].type, 'CANCEL_TACTIC_PLAN');
  refresh();
  assert.ok(els['#tac-status'].classList.contains('is-hidden'));
});

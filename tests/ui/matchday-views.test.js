// Unit tests for Matchday Phase 1 UI views (ManagerView plan integration, PreMatchView, PostMatchReportView)
// and calibration `--presets` pure evaluators.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import homeSquad from '../../generated/squads/sample-home.js';
import awaySquad from '../../generated/squads/sample-away.js';
import { LocaleManager } from '../../src/i18n/Locale.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { MatchdaySession } from '../../src/runtime/matchday/MatchdaySession.js';
import { buildMatchReport } from '../../src/runtime/matchday/MatchReport.js';
import { ManagerView } from '../../src/ui/views/ManagerView.js';
import { PreMatchView } from '../../src/ui/views/PreMatchView.js';
import { PostMatchReportView } from '../../src/ui/views/PostMatchReportView.js';
import { evaluatePresetVariant, formatPresetsReport, presetVariants } from '../../src/calibration/instructions.js';
import { fakeElement } from './fakedom.js';

/** Creates an in-memory StorageAdapter. */
function memStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    async get(/** @type {string} */ k) {
      return map.has(k) ? /** @type {string} */ (map.get(k)) : null;
    },
    async set(/** @type {string} */ k, /** @type {string} */ v) {
      map.set(k, v);
    },
    async remove(/** @type {string} */ k) {
      map.delete(k);
    },
  };
}

/**
 * Fake DOM host with click delegation support for `#id` and `[attr]` selectors.
 * @param {any} view
 */
function mountView(view) {
  /** @type {Record<string, any>} */
  const els = {};
  const makeNode = () => {
    const el = /** @type {any} */ (fakeElement());
    el.querySelector = (/** @type {string} */ sel) => (els[sel] ??= makeNode());
    el.querySelectorAll = () => [];
    return el;
  };
  const root = makeNode();
  /** @type {(ev: any) => void} */
  let onClick = () => {};
  root.addEventListener = (/** @type {string} */ type, /** @type {(ev: any) => void} */ fn) => {
    if (type === 'click') onClick = fn;
  };
  view.mount(root);
  /** @param {Record<string, string>} attrs @param {string} [id] */
  const tap = (attrs, id = '') => {
    const el = { getAttribute: (/** @type {string} */ k) => attrs[k] ?? null };
    onClick({
      target: {
        closest: (/** @type {string} */ sel) => {
          if (sel.startsWith('#') && sel === id) return el;
          if (sel.startsWith('[') && sel.endsWith(']') && sel.slice(1, -1) in attrs) return el;
          return null;
        },
      },
    });
  };
  return { els, tap, root };
}

test('ManagerView: read-only plan badge, PLAN_SWITCH in pending list, cancel via CANCEL_TACTIC_PLAN', () => {
  const session = new MatchdaySession({ config, configHash, homeSquad, awaySquad, storage: memStorage(), search: '?seed=22' });
  session.setPlan('A', 'gegenpress');
  session.setPlan('B', 'low-block');
  const input = session.prepareKickOff();
  const ctrl = new MatchController({ input, config, mode: 'full', schedule: () => 1, cancelSchedule: () => {} });
  for (let i = 0; i < 2000 && ctrl.engine.state.restart.state !== 'IN_PLAY'; i++) ctrl.stepTicks(1);

  ctrl.queueCommand({ issuer: 'human', type: 'SWITCH_TACTIC_PLAN', teamIndex: 0, payload: { plan: 'B' } });

  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  /** @type {any[]} */
  const sent = [];
  const view = new ManagerView({ locale, teamIndex: 0, onCommand: (cmd) => (sent.push(cmd), ctrl.queueCommand(cmd)) });
  const { els, tap } = mountView(view);
  view.update({ state: ctrl.engine.state, playbackState: ctrl.playbackState });

  assert.ok(els['#mgr-form-btns'].classList.contains('is-hidden'), 'raw formation buttons hidden when tacticalPlans active');
  assert.ok(!els['#mgr-plan-badge'].classList.contains('is-hidden'), 'read-only plan badge visible');
  assert.match(els['#mgr-plan-badge'].textContent, /Plan A · 5-4-1/, 'previews pending target formation');
  assert.match(els['#mgr-pending-list'].innerHTML, /Switch to Plan B queued/);
  assert.match(els['#mgr-pending-list'].innerHTML, /data-cancel-plan="1"/);
  assert.equal(view.locked, false, 'queued plan switch does not lock Manager staging');

  // Cancel queued plan switch from Manager pending list
  tap({ 'data-cancel-plan': '1' });
  assert.equal(sent[sent.length - 1].type, 'CANCEL_TACTIC_PLAN');
  view.update({ state: ctrl.engine.state, playbackState: ctrl.playbackState });
  assert.doesNotMatch(els['#mgr-pending-list'].innerHTML, /Switch to Plan B queued/);
  assert.match(els['#mgr-plan-badge'].textContent, /Plan A · 4-2-3-1/);
});

test('PreMatchView: 2 tabs, 10 presets, Plan A/B exclusion, Preview Plan B, GK swap guard, Auto-Pick & PT/EN', () => {
  const session = new MatchdaySession({ config, configHash, homeSquad, awaySquad, storage: memStorage(), search: '?seed=22' });
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  let kicked = 0;
  const view = new PreMatchView({ locale, session, config, onKickOff: () => kicked++ });
  const { els, tap } = mountView(view);

  assert.equal(els['#pm-title'].textContent, 'Matchday setup');
  assert.equal(els['#pm-lang-btn'].textContent, 'EN');
  const cardMatches = [...els['#pm-presets'].innerHTML.matchAll(/data-preset-id="/g)];
  assert.equal(cardMatches.length, 10);

  // Expanding a preset reveals 60/40 breakdown
  tap({ 'data-pm-expand': 'balanced' });
  assert.match(els['#pm-presets'].innerHTML, /Formation \(60%\)/);
  assert.match(els['#pm-presets'].innerHTML, /Instructions \(40%\)/);

  // Plan A !== Plan B warning
  const currentB = session.familiarity.planB;
  tap({ 'data-assign-a': currentB });
  assert.ok(!els['#pm-plan-warn'].classList.contains('is-hidden'));
  assert.equal(els['#pm-plan-warn'].textContent, 'Plan B must be a different tactic');

  // Assign distinct Plan A & Plan B clears warning
  tap({ 'data-assign-a': 'gegenpress' });
  assert.ok(els['#pm-plan-warn'].classList.contains('is-hidden'));
  assert.equal(session.familiarity.planA, 'gegenpress');

  // Switch to Squad tab and preview Plan B without mutating homePlayers
  tap({ 'data-pm-tab': 'squad' });
  assert.ok(els['#pm-panel-tactics'].classList.contains('is-hidden'));
  assert.ok(!els['#pm-panel-squad'].classList.contains('is-hidden'));
  const beforeIds = session.homePlayers.map((p) => p.id);
  tap({ 'data-pm-preview': 'B' });
  assert.deepEqual(session.homePlayers.map((p) => p.id), beforeIds, 'Preview Plan B does not mutate squad');

  // GK swap guard (slot 0 <-> outfield slot 1 rejected)
  tap({ 'data-pm-player': '0' });
  tap({ 'data-pm-player': '1' });
  assert.equal(session.homePlayers[0].role, 'GK');

  // Outfield swap succeeds
  const p1 = session.homePlayers[1].id;
  const p12 = session.homePlayers[12].id;
  tap({ 'data-pm-player': '1' });
  tap({ 'data-pm-player': '12' });
  assert.equal(session.homePlayers[1].id, p12);
  assert.equal(session.homePlayers[12].id, p1);

  // Auto-Pick & PT/EN toggle & Kick Off
  tap({ 'data-pm-autopick': '1' });
  tap({}, '#pm-lang-btn');
  assert.equal(els['#pm-lang-btn'].textContent, 'PT');
  assert.equal(els['#pm-title'].textContent, 'Preparação do Jogo');
  tap({ 'data-pm-kickoff': '1' });
  assert.equal(kicked, 1);
  view.destroy();
});

test('PostMatchReportView: 3 tabs, MOTM, familiarity progression, embedded StatsView & Next Match', () => {
  const session = new MatchdaySession({ config, configHash, homeSquad, awaySquad, storage: memStorage(), search: '?seed=22' });
  session.setPlan('A', 'gegenpress');
  session.setPlan('B', 'low-block');
  const input = session.prepareKickOff();
  const engine = MatchEngine.create(input, config);
  while (true) {
    const r = engine.step(2000);
    if (r.stoppedFor === 'FULL_TIME') break;
    if (r.stoppedFor === 'FORCED_DECISION') {
      for (let t = 0; t < 2; t++) {
        if (engine.state.teams[t].forcedDecision) {
          engine.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: t, payload: { inIndex: null, outIndex: null } });
        }
      }
    }
  }
  const report = buildMatchReport({ input, result: engine.getResult(), config });
  const locale = new LocaleManager({ uiStrings: config.uiStrings, initial: 'en-GB' });
  let nextClicks = 0;
  const view = new PostMatchReportView({ locale, report, config, onNextMatch: () => nextClicks++ });
  const { els, tap } = mountView(view);

  assert.equal(els['#rep-title'].textContent, 'Full-time report');
  assert.match(els['#rep-panel-summary'].innerHTML, /Man of the Match/);
  assert.match(els['#rep-panel-summary'].innerHTML, /Tactical familiarity/);
  assert.match(els['#rep-panel-summary'].innerHTML, /Gegenpress/);

  // Switch to Events & Stats tab
  tap({ 'data-rep-tab': 'events' });
  assert.ok(els['#rep-panel-summary'].classList.contains('is-hidden'));
  assert.ok(!els['#rep-panel-events'].classList.contains('is-hidden'));
  assert.equal(els['#rep-events-title'].textContent, 'Key events');

  // Switch to Ratings tab
  tap({ 'data-rep-tab': 'ratings' });
  assert.ok(!els['#rep-panel-ratings'].classList.contains('is-hidden'));
  assert.match(els['#rep-panel-ratings'].innerHTML, /Rating/);

  // Language toggle + Next Match button
  tap({}, '#rep-lang-btn');
  assert.equal(els['#rep-lang-btn'].textContent, 'PT');
  assert.equal(els['#rep-title'].textContent, 'Relatório Final');
  tap({ 'data-rep-next': '1' });
  assert.equal(nextClicks, 1);
  view.destroy();
});

test('calibration --presets: presetVariants, evaluatePresetVariant, and formatPresetsReport', () => {
  const variants = presetVariants(config.tacticalPresets);
  assert.equal(variants.length, 10, '9 non-balanced presets + 1 unfamiliarity check');
  assert.ok(variants.some((v) => v.id === 'gegenpress' && !v.unfamiliar));
  assert.ok(variants.some((v) => v.id === 'balanced.unfamiliar30' && v.unfamiliar));

  const zeroMetrics = () =>
    Object.fromEntries(
      ['goals', 'xG', 'oppXG', 'shots', 'oppShots', 'possession', 'passCompletion', 'oppPassCompletion', 'progressivePasses', 'crosses', 'centralPassShare', 'widePassShare', 'interceptionsSuffered', 'offsidesWon', 'oppThroughCompleted', 'oppDribblesWon', 'fouls', 'yellowCards', 'tacklesWon', 'highRegains', 'fitness', 'deadBallLeading'].map((k) => [k, 0]),
    );
  const rowsOk = [
    { seed: 1, optionSide: /** @type {0} */ (0), metrics: /** @type {[any, any]} */ ([{ ...zeroMetrics(), goals: 1 }, { ...zeroMetrics(), goals: 1 }]) },
    { seed: 2, optionSide: /** @type {1} */ (1), metrics: /** @type {[any, any]} */ ([{ ...zeroMetrics(), goals: 1 }, { ...zeroMetrics(), goals: 1 }]) },
  ];
  const rPreset = evaluatePresetVariant(variants[0], rowsOk);
  assert.equal(rPreset.pass, true);

  const rowsUnfam = [
    { seed: 1, optionSide: /** @type {0} */ (0), metrics: /** @type {[any, any]} */ ([{ ...zeroMetrics(), goals: 0.9 }, { ...zeroMetrics(), goals: 1.1 }]) },
    { seed: 2, optionSide: /** @type {1} */ (1), metrics: /** @type {[any, any]} */ ([{ ...zeroMetrics(), goals: 1.1 }, { ...zeroMetrics(), goals: 0.9 }]) },
  ];
  const unfamVar = variants.find((v) => v.unfamiliar);
  assert.ok(unfamVar);
  const rUnfam = evaluatePresetVariant(unfamVar, rowsUnfam);
  assert.equal(rUnfam.pass, true);

  const md = formatPresetsReport([rPreset, rUnfam], { engineVersion: 'test', configHash: 'abc', matches: 2, seedStart: 1, seedEnd: 2 });
  assert.match(md, /PASS/);
  assert.match(md, /balanced\.unfamiliar30/);
});

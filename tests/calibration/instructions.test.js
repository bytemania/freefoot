// @ts-nocheck -- hand-built rows and event logs; the module under test is fully type-checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../generated/config.js';
import {
  GD_CAP, TRADEOFF_METRICS, Z_MIN, evaluateVariant, formatInstructionsReport, instructionStringKeys, instructionVariants, paired, teamTradeoffMetrics,
} from '../../src/calibration/instructions.js';

const CFG = config.tactics.instructions;

test('instructionVariants: every non-default option, seventeen of them across nine instructions', () => {
  const v = instructionVariants(CFG);
  assert.equal(v.length, 17);
  assert.ok(v.some((x) => x.id === 'attackFocus.wings') && v.some((x) => x.id === 'attackFocus.center'));
  assert.ok(!v.some((x) => x.option === CFG[x.instruction].default));
  for (const x of v) assert.ok(TRADEOFF_METRICS.includes(x.upside.metric) && TRADEOFF_METRICS.includes(x.downside.metric), x.id);
});

test('instructionStringKeys: label, option and hint keys, all present in both locales', () => {
  const keys = instructionStringKeys(CFG);
  assert.ok(keys.includes('attackFocus') && keys.includes('attackFocusCenter') && keys.includes('attackFocusCenterHint'));
  for (const locale of ['en-GB', 'pt-PT']) for (const k of keys) assert.equal(typeof config.uiStrings[locale].tactics[k], 'string', `${locale} ${k}`);
});

test('teamTradeoffMetrics: own and opponent counts from the event log', () => {
  const ev = (type, teamIndex, extra = {}) => ({ type, teamIndex, x: 50, y: 34, zone: 5, ...extra });
  const events = [
    ev('SHOT', 0, { meta: { xg: 0.3 } }),
    ev('PASS', 0, { meta: { kind: 'THROUGH', completed: true } }),
    ev('PASS', 0, { y: 2, meta: { kind: 'SHORT', completed: false } }),
    ev('PASS', 1, { meta: { kind: 'SHORT', completed: true } }),
    ev('OFFSIDE', 1),
    ev('INTERCEPTION', 1, { zone: 11 }),
    ev('TACKLE', 0, { zone: 12, meta: { won: true } }),
    ev('CROSS', 0),
  ];
  const [home, away] = teamTradeoffMetrics(events, [1, 0], { fitness: [0.7, 0.8], deadBallLeading: [30, 0] });
  assert.equal(home.goals, 1);
  assert.equal(home.shots, 1);
  assert.equal(away.oppShots, 1);
  assert.equal(home.passCompletion, 0.5);
  assert.equal(away.oppPassCompletion, 0.5);
  assert.equal(home.centralPassShare, 0.5);
  assert.equal(home.widePassShare, 0.5);
  assert.equal(away.oppThroughCompleted, 1);
  assert.equal(home.offsidesWon, 1);
  assert.equal(home.interceptionsSuffered, 1);
  assert.equal(away.highRegains, 1);
  assert.equal(home.highRegains, 1);
  assert.equal(home.tacklesWon, 1);
  assert.equal(home.crosses, 1);
  assert.equal(home.fitness, 0.7);
  assert.equal(home.deadBallLeading, 30);
  for (const m of TRADEOFF_METRICS) assert.equal(typeof home[m], 'number', m);
});

test('evaluateVariant: the goal-difference cap and the paired z of the declared upside and downside', () => {
  const variant = { id: 'x.y', instruction: 'x', option: 'y', upside: { metric: 'shots', dir: 'up' }, downside: { metric: 'fitness', dir: 'down' } };
  const blank = () => Object.fromEntries(TRADEOFF_METRICS.map((m) => [m, 0]));
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const opt = { ...blank(), shots: 12 + (i % 3), fitness: 0.6, goals: i % 2 };
    const def = { ...blank(), shots: 10, fitness: 0.7 + (i % 2) * 0.01, goals: i % 2 };
    const side = /** @type {0 | 1} */ (i % 2);
    rows.push({ seed: i, optionSide: side, metrics: /** @type {any} */ (side === 0 ? [opt, def] : [def, opt]) });
  }
  const r = evaluateVariant(variant, rows);
  assert.ok(r.balance.pass && Math.abs(r.balance.mean) <= GD_CAP);
  assert.ok(r.upsideCheck.pass && r.upsideCheck.z >= Z_MIN);
  assert.ok(r.downsideCheck.pass);
  assert.ok(r.pass);
  // Goals for the option side every match: over the cap.
  const lopsided = rows.map((x) => ({ ...x, metrics: /** @type {any} */ (x.metrics.map((m, t) => ({ ...m, goals: t === x.optionSide ? 1 : 0 }))) }));
  assert.equal(evaluateVariant(variant, lopsided).balance.pass, false);
  // The wrong direction fails.
  const wrong = evaluateVariant({ ...variant, upside: { metric: 'shots', dir: 'down' } }, rows);
  assert.equal(wrong.upsideCheck.pass, false);
  assert.match(formatInstructionsReport([r, wrong]), /# freefoot Instructions Calibration \(FAIL\)/);
  assert.deepEqual(paired([1, 1, 1]).z, Infinity);
});

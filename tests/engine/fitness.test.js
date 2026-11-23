import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { validateMatchInput } from '../../src/engine/contracts/MatchInput.js';
import { ageFactors, DEFAULT_AGE, updateFitness } from '../../src/engine/fitness/Fitness.js';
import { buildTickConfig } from '../../src/engine/TickConfig.js';
import { generateSquad } from '../../src/shared/squadgen.js';
import { config, sampleInput } from './helpers.js';

const ageCfg = buildTickConfig(config).weights.fitness.age;

test('ageFactors: 1.0x up to 27, about +12% at 31, capped near +25% from 35-36, compounded by low stamina', () => {
  for (const age of [18, 23, 25, 27]) assert.deepEqual(ageFactors(age, 20, ageCfg), { drain: 1, recovery: 1 }, `age ${age}`);
  assert.ok(Math.abs(ageFactors(31, 20, ageCfg).drain - 1.12) < 1e-9);
  assert.ok(Math.abs(ageFactors(36, 20, ageCfg).drain - 1.25) < 1e-9);
  assert.equal(ageFactors(40, 20, ageCfg).drain, ageFactors(36, 20, ageCfg).drain, 'capped');
  // Each year past the peak drains more.
  let last = 1;
  for (let age = 28; age <= 35; age++) {
    const d = ageFactors(age, 20, ageCfg).drain;
    assert.ok(d > last, `age ${age}`);
    last = d;
  }
  // A lower Stamina attribute compounds the age extra slightly (never below peak 1.0x).
  const strong = ageFactors(33, 18, ageCfg).drain;
  const weak = ageFactors(33, 6, ageCfg).drain;
  assert.ok(weak > strong);
  assert.ok(weak - 1 < (strong - 1) * 1.35);
  assert.equal(ageFactors(25, 1, ageCfg).drain, 1);
  // Older players recover a little slower.
  assert.ok(ageFactors(34, 12, ageCfg).recovery < 1);
  // Missing age reads as the default (25); missing config is neutral.
  assert.deepEqual(ageFactors(undefined, 10, ageCfg), ageFactors(DEFAULT_AGE, 10, ageCfg));
  assert.deepEqual(ageFactors(34, 10, undefined), { drain: 1, recovery: 1 });
});

test('a 34-year-old drains fitness measurably faster over 90 minutes than a 25-year-old with an identical workload', () => {
  const input = sampleInput(3);
  const young = input.home.players[6];
  const old = { ...input.home.players[7], attributes: { ...young.attributes }, age: 34 };
  input.home.players[6] = { ...young, age: 25 };
  input.home.players[7] = old;
  const engine = MatchEngine.create(input, config);
  const s = engine.state;
  const a = s.players[6];
  const b = s.players[7];
  assert.equal(a.ageDrain, 1);
  assert.ok(b.ageDrain > 1.15);
  s.restart.state = 'IN_PLAY';
  // 90 minutes of the same box-to-box workload: 40% walking, 40% jogging, 15% running, 5% sprinting.
  const speeds = [1, 1, 1, 1, 4, 4, 4, 4, 6, 6, 6, 8, 1, 4, 6, 1, 4, 8, 4, 1];
  for (let t = 0; t < 90 * 60 * 20; t++) {
    const v = speeds[t % speeds.length];
    a.vx = b.vx = v;
    a.vy = b.vy = 0;
    updateFitness(s);
  }
  assert.ok(a.fitness > 0.2 && b.fitness > 0, `no clamping (young ${a.fitness}, old ${b.fitness})`);
  const youngLoss = 1 - a.fitness;
  const oldLoss = 1 - b.fitness;
  assert.ok(oldLoss > youngLoss * 1.12, `old player loses more (young ${youngLoss.toFixed(3)}, old ${oldLoss.toFixed(3)})`);
  assert.ok(a.fitness - b.fitness > 0.03, `measurable gap at 90' (${(a.fitness - b.fitness).toFixed(3)})`);
});

test('age is part of MatchInput: optional (25 by default), an integer 15-50, and present in sample and generated squads', () => {
  const input = sampleInput(1);
  assert.deepEqual(validateMatchInput(input, config), []);
  assert.ok(input.home.players.every((p) => Number.isInteger(p.age)), 'sample-home has ages');
  assert.ok(input.away.players.every((p) => Number.isInteger(p.age)), 'sample-away has ages');
  const bad = sampleInput(1);
  /** @type {any} */ (bad.home.players[3]).age = 12.5;
  assert.ok(validateMatchInput(bad, config).some((e) => e.includes('players[3].age')));
  const none = sampleInput(1);
  delete (/** @type {any} */ (none.home.players[3]).age);
  assert.deepEqual(validateMatchInput(none, config), []);
  const engine = MatchEngine.create(none, config);
  assert.equal(engine.state.players[3].ageDrain, 1, 'no age reads as 25 (peak)');

  for (const side of ['A', 'B_strong', 'B_weak']) {
    const squad = generateSquad(/** @type {any} */ (side), 77, config);
    const ages = squad.players.map((p) => p.age ?? -1);
    assert.ok(ages.every((x) => Number.isInteger(x) && x >= 18 && x <= 35), `${side}: ${ages.join(',')}`);
    assert.deepEqual(generateSquad(/** @type {any} */ (side), 77, config).players.map((p) => p.age), ages, 'deterministic');
  }
});

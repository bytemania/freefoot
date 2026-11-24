// AI substitution plan (AiCoach.planSubstitutions): 3-5 substitutions, at most three in-play windows,
// late timing, and the injury / red-card early exceptions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { evaluate, plannedSubstitutions } from '../../src/engine/ai/AiCoach.js';
import { config, sampleInput } from './helpers.js';

const M = 20 * 60;

/** @param {number} seed */
function playAi(seed) {
  const engine = MatchEngine.create(sampleInput(seed, { homeControl: 'ai', awayControl: 'ai' }), config);
  for (;;) {
    const r = engine.step(5000);
    if (r.stoppedFor === 'FULL_TIME' || r.ticksRun === 0) break;
    if (r.stoppedFor === 'HALF_TIME' || r.stoppedFor === 'FORCED_DECISION') continue;
  }
  return engine;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

test('AI teams make 3 to 5 substitutions, never more than 5, in at most 3 in-play windows', () => {
  const totals = new Set();
  for (const seed of SEEDS) {
    const engine = playAi(seed);
    const ht = /** @type {any} */ (engine.eventLog.find((e) => e.type === 'HALF_TIME')).tick;
    for (const t of [0, 1]) {
      const subs = engine.eventLog.filter((e) => e.type === 'SUBSTITUTION' && e.teamIndex === t);
      assert.ok(subs.length <= 5, `seed ${seed} team ${t}: ${subs.length} substitutions`);
      totals.add(subs.length);
      // One stoppage can hold substitutions on several ticks (a red card, then the replacement): ticks within 10 s share a window.
      let windows = 0;
      let last = -Infinity;
      for (const e of subs.filter((x) => x.tick !== ht)) {
        if (e.tick - last > 200) windows++;
        last = e.tick;
      }
      assert.ok(windows <= 3, `seed ${seed} team ${t}: ${windows} windows`);
      assert.ok(engine.state.teams[t].subWindows <= 3);
    }
  }
  assert.ok([...totals].some((n) => n >= 3), 'teams use their substitutions');
  const planned = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const e = MatchEngine.create(sampleInput(seed, { homeControl: 'ai', awayControl: 'ai' }), config);
    planned.add(plannedSubstitutions(e.state, e.state.teams[0]));
  }
  assert.deepEqual([...planned].sort(), [3, 4, 5], 'plans of 3, 4 and 5 all occur');
});

test('planned substitutions wait for the late windows: nothing before the earliest minute without injury or red card', () => {
  for (const seed of SEEDS) {
    const engine = playAi(seed);
    const ht = /** @type {any} */ (engine.eventLog.find((e) => e.type === 'HALF_TIME')).tick;
    const earliest = config.aiCoach.substitutionPlan.earliestMinute;
    const injuredTicks = new Set(engine.eventLog.filter((e) => e.type === 'INJURY' || e.type === 'RED_CARD').map((e) => e.tick));
    const early = engine.eventLog.filter(
      (e) => e.type === 'SUBSTITUTION' && e.tick > ht && e.tick < ht + (earliest - 45) * M && ![...injuredTicks].some((t) => e.tick - t >= 0 && e.tick - t < 2 * M),
    );
    assert.equal(early.length, 0, `seed ${seed}: no planned substitutions before minute ${earliest}`);
  }
});

test('a human cannot open a fourth in-play window, but half-time and queued batches are fine', () => {
  const engine = MatchEngine.create(sampleInput(3), config);
  engine.step(200);
  const s = engine.state;
  const team = s.teams[0];
  const bench = (/** @type {number} */ n) => [...Array(18).keys()].filter((i) => s.players[i].onPitch === 0 && s.players[i].cold.role !== 'GK')[n];
  const out = (/** @type {number} */ n) => [...Array(18).keys()].filter((i) => s.players[i].onPitch === 1 && s.players[i].isKeeper !== 1)[n];
  team.subWindows = 3;
  team.inSubWindow = false;
  s.restart.state = 'IN_PLAY';
  const refused = engine.applyCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: out(0), inIndex: bench(0) } });
  assert.equal(refused.ok, false);
  assert.equal(/** @type {any} */ (refused).code, 'NO_WINDOWS_LEFT');
  s.restart.state = 'HALF_TIME';
  const ok = engine.applyCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: out(0), inIndex: bench(0) } });
  assert.equal(ok.ok, true, 'half-time substitutions do not need a window');
  assert.equal(team.subWindows, 3, 'and they do not count as one');
});

test('injury and red card allow an early substitution', () => {
  const engine = MatchEngine.create(sampleInput(7, { homeControl: 'ai', awayControl: 'ai' }), config);
  while (engine.tick < 10 * M) engine.step(10 * M - engine.tick);
  const s = engine.state;
  const team = s.teams[0];
  const outfield = [...Array(18).keys()].filter((i) => s.players[i].onPitch === 1 && s.players[i].isKeeper !== 1);
  s.players[outfield[0]].injury = 2; // MEDIUM
  evaluate(s, team);
  assert.ok(s.pendingSubs.some((p) => p.teamIndex === 0 && p.outIndex === outfield[0]), 'injured player comes off in minute 10');

  const t1 = s.teams[1];
  const base = 18;
  const forward = [...Array(18).keys()].map((i) => i + base).find((i) => {
    const p = s.players[i];
    return p.onPitch === 1 && p.isKeeper !== 1 && ['ST', 'W'].includes(config.tactics.formations[t1.formationId].slots[p.slot]?.role);
  });
  assert.ok(forward !== undefined);
  const roleOf = (/** @type {number} */ i) => config.tactics.formations[t1.formationId].slots[s.players[i].slot]?.role;
  const sentOff = [...Array(18).keys()].map((i) => i + base).find((i) => s.players[i].onPitch === 1 && s.players[i].isKeeper !== 1 && i !== forward);
  s.players[/** @type {number} */ (sentOff)].card = 2;
  evaluate(s, t1);
  const answer = s.pendingSubs.find((p) => p.teamIndex === 1);
  assert.ok(answer, 'red card answered with a substitution in minute 10');
  assert.ok(['ST', 'W'].includes(roleOf(answer.outIndex)), 'an attacker makes way');
});

test('sub-window counters round-trip through serialize/restore and the run stays bit-identical', () => {
  const input = sampleInput(5, { homeControl: 'ai', awayControl: 'ai' });
  const straight = MatchEngine.create(input, config);
  for (;;) {
    const r = straight.step(5000);
    if (r.stoppedFor === 'FULL_TIME' || r.ticksRun === 0) break;
  }
  const first = MatchEngine.create(input, config);
  while (first.tick < 70 * M) first.step(70 * M - first.tick);
  const saved = JSON.parse(JSON.stringify(first.serialize()));
  assert.ok(saved.teams.every((/** @type {any} */ t) => Number.isInteger(t.subWindows) && typeof t.inSubWindow === 'boolean'));
  const resumed = MatchEngine.fromState(saved, input, config);
  assert.equal(resumed.hash(), first.hash());
  for (;;) {
    const r = resumed.step(5000);
    if (r.stoppedFor === 'FULL_TIME' || r.ticksRun === 0) break;
  }
  assert.equal(resumed.hash(), straight.hash());
  assert.deepEqual(
    resumed.state.teams.map((t) => t.subWindows),
    straight.state.teams.map((t) => t.subWindows),
  );
});

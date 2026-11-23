import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMING_BUCKETS,
  TICKS_PER_MINUTE,
  addEngineTiming,
  addStatsbombTiming,
  blankTiming,
  bucketOfMinute,
  bucketOfTick,
  formatTimingTable,
  shares,
} from '../../src/calibration/timing.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { config, sampleInput } from '../engine/helpers.js';

test('bucketOfMinute: bucket edges, first-half stoppage 45+ versus second-half 46–60, and 90+', () => {
  assert.equal(bucketOfMinute(1, 0), '1–15');
  assert.equal(bucketOfMinute(1, 14), '1–15');
  assert.equal(bucketOfMinute(1, 15), '16–30');
  assert.equal(bucketOfMinute(1, 29), '16–30');
  assert.equal(bucketOfMinute(1, 30), '31–45');
  assert.equal(bucketOfMinute(1, 44), '31–45');
  assert.equal(bucketOfMinute(1, 45), '45+', 'first-half stoppage');
  assert.equal(bucketOfMinute(1, 48), '45+');
  assert.equal(bucketOfMinute(2, 45), '46–60', 'the first minute of the second half');
  assert.equal(bucketOfMinute(2, 59), '46–60');
  assert.equal(bucketOfMinute(2, 60), '61–75');
  assert.equal(bucketOfMinute(2, 74), '61–75');
  assert.equal(bucketOfMinute(2, 75), '76–90');
  assert.equal(bucketOfMinute(2, 89), '76–90');
  assert.equal(bucketOfMinute(2, 90), '90+', 'second-half stoppage');
  assert.equal(bucketOfMinute(2, 95), '90+');
});

test('bucketOfTick: ticks map to match minutes, with the second half starting after the HALF_TIME tick', () => {
  const M = TICKS_PER_MINUTE;
  const ht = 45 * M + 2 * M; // two minutes of first-half added time, as in the engine
  assert.equal(bucketOfTick(1, ht), '1–15');
  assert.equal(bucketOfTick(15 * M, ht), '1–15', 'the last tick of minute 15');
  assert.equal(bucketOfTick(15 * M + 1, ht), '16–30');
  assert.equal(bucketOfTick(45 * M, ht), '31–45');
  assert.equal(bucketOfTick(45 * M + 1, ht), '45+');
  assert.equal(bucketOfTick(ht, ht), '45+', 'the half-time whistle itself');
  assert.equal(bucketOfTick(ht + 1, ht), '46–60', 'the second-half kick-off');
  assert.equal(bucketOfTick(ht + 15 * M, ht), '46–60');
  assert.equal(bucketOfTick(ht + 15 * M + 1, ht), '61–75');
  assert.equal(bucketOfTick(ht + 45 * M, ht), '76–90');
  assert.equal(bucketOfTick(ht + 45 * M + 1, ht), '90+');
  assert.equal(bucketOfTick(ht + 48 * M, ht), '90+');
});

test('addEngineTiming counts goals, shots, cards and substitutions per bucket; a match without half-time is skipped', () => {
  const M = TICKS_PER_MINUTE;
  const ht = 47 * M;
  const into = blankTiming();
  const events = [
    { type: 'GOAL', tick: 10 * M },
    { type: 'SHOT', tick: 10 * M },
    { type: 'SHOT', tick: 46 * M },
    { type: 'HALF_TIME', tick: ht },
    { type: 'YELLOW_CARD', tick: ht + 50 * M },
    { type: 'RED_CARD', tick: ht + 20 * M },
    { type: 'SUBSTITUTION', tick: ht + 31 * M },
    { type: 'PASS', tick: 5 },
  ];
  assert.equal(addEngineTiming(events, into), true);
  assert.equal(into.goals['1–15'], 1);
  assert.equal(into.shots['1–15'], 1);
  assert.equal(into.shots['45+'], 1);
  assert.equal(into.yellowCards['90+'], 1);
  assert.equal(into.redCards['61–75'], 1);
  assert.equal(into.substitutions['76–90'], 1);
  const before = JSON.stringify(into);
  assert.equal(addEngineTiming([{ type: 'GOAL', tick: 5 }], into), false);
  assert.equal(JSON.stringify(into), before);
});

test('addStatsbombTiming aggregates by period and minute, leaving out extra time', () => {
  const into = blankTiming();
  /** @type {any[]} */
  const events = [
    { period: 1, minute: 3, type: { name: 'Shot' }, shot: { outcome: { name: 'Goal' } } },
    { period: 1, minute: 3, type: { name: 'Shot' }, shot: { outcome: { name: 'Saved' } } },
    { period: 1, minute: 47, type: { name: 'Own Goal For' } },
    { period: 2, minute: 45, type: { name: 'Shot' }, shot: { outcome: { name: 'Off T' } } },
    { period: 2, minute: 92, type: { name: 'Substitution' } },
    { period: 2, minute: 70, type: { name: 'Foul Committed' }, foul_committed: { card: { name: 'Yellow Card' } } },
    { period: 2, minute: 80, type: { name: 'Foul Committed' }, foul_committed: { card: { name: 'Second Yellow' } } },
    { period: 2, minute: 81, type: { name: 'Bad Behaviour' }, bad_behaviour: { card: { name: 'Red Card' } } },
    { period: 2, minute: 82, type: { name: 'Foul Committed' } },
    { period: 3, minute: 95, type: { name: 'Shot' }, shot: { outcome: { name: 'Goal' } } },
  ];
  addStatsbombTiming(events, into);
  assert.equal(into.shots['1–15'], 2);
  assert.equal(into.goals['1–15'], 1);
  assert.equal(into.goals['45+'], 1);
  assert.equal(into.shots['46–60'], 1);
  assert.equal(into.substitutions['90+'], 1);
  assert.equal(into.yellowCards['61–75'], 1);
  assert.equal(into.yellowCards['76–90'], 1);
  assert.equal(into.redCards['76–90'], 2, 'a second yellow and a straight red');
  assert.equal(Object.values(into.goals).reduce((a, b) => a + b, 0), 2, 'extra-time goal not counted');
});

test('shares sum to one, and an empty kind gives zeros', () => {
  const c = Object.fromEntries(TIMING_BUCKETS.map((b, i) => [b, i + 1]));
  const s = shares(c);
  assert.ok(Math.abs(Object.values(s).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(shares(blankTiming().goals)['1–15'], 0);
});

test('a real engine match lands every goal and shot in a bucket', () => {
  const engine = MatchEngine.create(sampleInput(3, { homeControl: 'ai', awayControl: 'ai' }), config);
  while (true) {
    const r = engine.step(200);
    if (r.stoppedFor === 'FULL_TIME' || r.stoppedFor === 'FORCED_DECISION') break;
  }
  const into = blankTiming();
  assert.equal(addEngineTiming(engine.eventLog, into), true);
  const shotEvents = engine.eventLog.filter((e) => e.type === 'SHOT').length;
  assert.equal(Object.values(into.shots).reduce((a, b) => a + b, 0), shotEvents);
  const goalEvents = engine.eventLog.filter((e) => e.type === 'GOAL').length;
  assert.equal(Object.values(into.goals).reduce((a, b) => a + b, 0), goalEvents);
  // Shots happen early and late in the match.
  assert.ok(into.shots['1–15'] > 0 && into.shots['76–90'] > 0);
});

test('formatTimingTable prints simulated and benchmark rows, and works without a benchmark', () => {
  const sim = blankTiming();
  sim.goals['1–15'] = 4;
  sim.goals['90+'] = 1;
  const withBench = formatTimingTable(sim, 2, { goals: { matches: 100, counts: { ...blankTiming().goals, '1–15': 10, '16–30': 10 } } });
  assert.match(withBench, /\*\*goals\*\* \(simulated 2\.50 per match, benchmark 100 matches\)/);
  assert.match(withBench, /\| Simulated \| 80\.0% \|/);
  assert.match(withBench, /\| Benchmark \| 50\.0% \|/);
  assert.match(withBench, /\| Difference \| \+30\.0 \|/);
  const noBench = formatTimingTable(sim, 2, null);
  assert.ok(!noBench.includes('| Benchmark |'));
});

test('the benchmark file carries a timing section whose shares match its counts', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const file = new URL('../../config/benchmarks/top5-10yr.json', import.meta.url);
  if (!existsSync(file)) return;
  const t = JSON.parse(readFileSync(file, 'utf8')).timing;
  assert.ok(t, 'timing section present; run scripts/fetch-league-benchmarks.mjs --timing-only');
  assert.deepEqual(t.buckets, [...TIMING_BUCKETS]);
  /** @type {Array<[string, string[]]>} */
  const groups = [['league', ['goals', 'shots', 'yellowCards', 'redCards']], ['fiveSubEra', ['substitutions']]];
  for (const [group, kinds] of groups) {
    for (const kind of kinds) {
      const d = t[group][kind];
      const total = TIMING_BUCKETS.reduce((a, b) => a + d.counts[b], 0);
      assert.equal(total, d.total);
      assert.ok(total > 0, `${group}.${kind} has data`);
      const sum = TIMING_BUCKETS.reduce((a, b) => a + d.share[b], 0);
      assert.ok(Math.abs(sum - 1) < 1e-3, `${group}.${kind} shares sum to ${sum}`);
      for (const b of TIMING_BUCKETS) assert.ok(Math.abs(d.share[b] - d.counts[b] / total) < 1e-4);
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { generateSquad } from '../../src/shared/squadgen.js';
import { config, configHash } from './helpers.js';

// Whole-match sanity checks with both teams under the AI coach (Scenario A squads).
// Calibration against real data is build step 5; these only catch absurd behaviour.
// EXIT_MATCHES=50 runs the longer check (npm run test:exit).
const MATCHES = Number(process.env.EXIT_MATCHES ?? 3);

/** @param {number} seed */
function aiInput(seed) {
  return /** @type {any} */ ({
    v: 1, seed, configHash,
    home: generateSquad('A', seed ^ 0xa5a5a5a5, config, { side: 'home' }),
    away: generateSquad('A', seed ^ 0x5a5a5a5a, config, { side: 'away' }),
  });
}

test(`${MATCHES} AI matches finish with a sane score, events and soft metrics`, () => {
  const rows = { distanceKm: /** @type {number[]} */ ([]), sprints: /** @type {number[]} */ ([]), passes: /** @type {number[]} */ ([]), goals: /** @type {number[]} */ ([]) };
  for (let seed = 1; seed <= MATCHES; seed++) {
    const engine = MatchEngine.create(aiInput(seed), config);
    for (;;) {
      const r = engine.step(5000);
      if (r.stoppedFor === 'FULL_TIME') break;
    }
    const result = engine.getResult();
    const types = new Set(result.events.map((e) => e.type));
    for (const t of ['KICK_OFF', 'PASS', 'SHOT', 'HALF_TIME', 'FULL_TIME']) assert.ok(types.has(t), `seed ${seed} has no ${t}`);
    assert.ok(result.score.home + result.score.away <= 25, `score ${result.score.home}-${result.score.away}`);
    for (const team of [result.stats.home, result.stats.away]) {
      rows.distanceKm.push(team.distanceKm);
      rows.sprints.push(team.sprints);
      rows.passes.push(team.passes);
      rows.goals.push(team.goals);
      assert.ok(team.possessionPct > 20 && team.possessionPct < 80, `possession ${team.possessionPct}`);
    }
    // Everyone who played is accounted for and positions stay in bounds.
    for (const i of engine.state.onPitchList) assert.ok(engine.state.players[i].x >= 0 && engine.state.players[i].x <= 105);
  }
  const mean = (/** @type {number[]} */ a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`matchplay: ${JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, +mean(v).toFixed(1)])))}`);
  assert.ok(mean(rows.distanceKm) > 70 && mean(rows.distanceKm) < 170, `distanceKm ${mean(rows.distanceKm)}`);
  assert.ok(mean(rows.sprints) > 30 && mean(rows.sprints) < 900, `sprints ${mean(rows.sprints)}`);
  assert.ok(mean(rows.passes) > 150 && mean(rows.passes) < 1500, `passes ${mean(rows.passes)}`);
});

test('debug mode: invariants and event validation hold through an AI match (first 12,000 ticks)', () => {
  const engine = MatchEngine.create(aiInput(11), config, { debug: true });
  const r = engine.step(12000);
  assert.equal(r.ticksRun, 12000);
});

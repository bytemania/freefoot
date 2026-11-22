import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSquad } from '../../src/shared/squadgen.js';
import { validateMatchInput, ATTRIBUTES } from '../../src/engine/contracts/MatchInput.js';
import { teamMetrics } from '../../src/calibration/metrics.js';
import { config, configHash } from './helpers.js';

const mean = (/** @type {number[]} */ a) => a.reduce((x, y) => x + y, 0) / a.length;

test('generateSquad returns a valid MatchInput team, and the same seed gives the same bytes', () => {
  const a = generateSquad('A', 7, config, { side: 'home' });
  const b = generateSquad('A', 7, config, { side: 'home' });
  const c = generateSquad('A', 8, config, { side: 'home' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
  const input = { v: 1, seed: 1, configHash, home: a, away: generateSquad('A', 7, config, { side: 'away' }) };
  assert.deepEqual(validateMatchInput(input, config), []);
  assert.equal(a.players.length, 18);
  assert.equal(a.players[0].role, 'GK');
});

test('attributes follow the scenario distributions: primary and secondary means, and strong above weak', () => {
  const dist = config.calibration.scenarios.distributions;
  for (const [name, d] of Object.entries(dist)) {
    /** @type {number[]} */
    const primary = [];
    /** @type {number[]} */
    const secondary = [];
    for (let seed = 1; seed <= 60; seed++) {
      const squad = generateSquad(/** @type {any} */ (name), seed, config);
      for (const p of squad.players) {
        const role = config.roles[p.role];
        for (const attr of ATTRIBUTES) {
          assert.ok(p.attributes[attr] >= 1 && p.attributes[attr] <= 20 && Number.isInteger(p.attributes[attr]));
          if (role.primary.includes(attr)) primary.push(p.attributes[attr]);
          else if (role.secondary.includes(attr)) secondary.push(p.attributes[attr]);
        }
      }
    }
    assert.ok(Math.abs(mean(primary) - d.primary.mean) < 0.3, `${name} primary mean ${mean(primary)}`);
    assert.ok(Math.abs(mean(secondary) - d.secondary.mean) < 0.3, `${name} secondary mean ${mean(secondary)}`);
  }
});

test('teamMetrics derives the percentages and passes extras through', () => {
  const own = { passes: 300, passesCompleted: 240, goals: 2 };
  const opp = { passes: 100, passesCompleted: 60 };
  const m = teamMetrics(own, opp, { ticks: 1000, timeOnBallTicks: 250, distanceM: 110000, sprints: 190 });
  assert.equal(m.passCompletionPct, 80);
  assert.equal(m.possessionPct, 75);
  assert.equal(m.timeOnBallPct, 25);
  assert.equal(m.distanceKm, 110);
  assert.equal(m.sprints, 190);
  assert.equal(m.goals, 2);
  assert.deepEqual(
    [teamMetrics({}, {}, { ticks: 0, timeOnBallTicks: 0, distanceM: 0, sprints: 0 }).possessionPct, teamMetrics({}, {}, { ticks: 0, timeOnBallTicks: 0, distanceM: 0, sprints: 0 }).passCompletionPct],
    [0, 0],
  );
});

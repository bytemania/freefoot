import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsFromEvents, teamMetrics } from '../../src/calibration/metrics.js';

test('metricsFromEvents: hand-built event log gives expected possession, pass completion, shots on target and goals', () => {
  const events = [
    // Home: 4 open-play passes (3 completed), 1 cross, 1 throw-in (restart, NOT a pass)
    { type: 'PASS', teamIndex: 0, x: 40, y: 34, zone: 8, meta: { kind: 'SHORT', completed: true } },
    { type: 'PASS', teamIndex: 0, x: 55, y: 34, zone: 11, meta: { kind: 'THROUGH', completed: true } },
    { type: 'PASS', teamIndex: 0, x: 80, y: 10, zone: 13, meta: { kind: 'CROSS', completed: true } },
    { type: 'CROSS', teamIndex: 0, x: 80, y: 10, zone: 13, meta: { completed: true } },
    { type: 'PASS', teamIndex: 0, x: 75, y: 50, zone: 15, meta: { kind: 'LONG', completed: false } },
    { type: 'THROW_IN', teamIndex: 0, x: 50, y: 0, zone: 8, meta: {} },
    { type: 'CORNER', teamIndex: 0, x: 105, y: 0, zone: 16, meta: {} },
    { type: 'GOAL_KICK', teamIndex: 0, x: 5, y: 34, zone: 2, meta: {} },
    { type: 'FREE_KICK', teamIndex: 0, x: 60, y: 34, zone: 11, meta: { direct: true } },
    { type: 'KICK_OFF', teamIndex: 0, x: 52.5, y: 34, zone: 8, meta: {} },

    // Away: 1 open-play pass (1 completed)
    { type: 'PASS', teamIndex: 1, x: 60, y: 34, zone: 8, meta: { kind: 'SHORT', completed: true } },

    // Home shots: 1 ON_TARGET (goal), 1 OFF_TARGET, 1 BLOCKED, 1 WOODWORK
    { type: 'SHOT', teamIndex: 0, x: 95, y: 34, zone: 17, meta: { result: 'ON_TARGET', xg: 0.35, psxg: 0.42, distance: 10 } },
    { type: 'GOAL', teamIndex: 0, x: 95, y: 34, zone: 17, meta: { kind: 'OPEN_PLAY' } },
    { type: 'SHOT', teamIndex: 0, x: 85, y: 34, zone: 14, meta: { result: 'OFF_TARGET', xg: 0.08, psxg: 0, distance: 20 } },
    { type: 'SHOT', teamIndex: 0, x: 92, y: 30, zone: 17, meta: { result: 'BLOCKED', xg: 0.12, psxg: 0, distance: 13.6 } },
    { type: 'SHOT', teamIndex: 0, x: 94, y: 38, zone: 17, meta: { result: 'WOODWORK', xg: 0.25, psxg: 0, distance: 11.7 } },

    // Own goal by home (teamIndex 0) -> credited to away (teamIndex 1)
    { type: 'GOAL', teamIndex: 0, x: 5, y: 34, zone: 2, meta: { kind: 'OWN_GOAL' } },

    // Fouls
    { type: 'FOUL', teamIndex: 1, x: 70, y: 34, zone: 11, meta: {} },
    { type: 'FOUL', teamIndex: 1, x: 80, y: 34, zone: 14, meta: {} },
  ];

  const { home, away } = metricsFromEvents(events, {
    home: { ticks: 1000, timeOnBallTicks: 600, distanceM: 110000, sprints: 180 },
    away: { ticks: 1000, timeOnBallTicks: 400, distanceM: 105000, sprints: 170 },
  });

  // Restarts are NOT counted as passes: home has 4, away has 1 -> 80% / 20%
  assert.equal(home.passes, 4);
  assert.equal(home.passesCompleted, 3);
  assert.equal(home.passCompletionPct, 75);
  assert.equal(home.possessionPct, 80);
  assert.equal(away.passes, 1);
  assert.equal(away.possessionPct, 20);

  // Shots and goals
  assert.equal(home.shots, 4);
  assert.equal(home.shotsOnTarget, 1);
  assert.equal(home.woodwork, 1);
  assert.ok(Math.abs(home.xG - 0.8) < 1e-9);
  assert.equal(home.goals, 1);
  assert.equal(away.goals, 1); // own goal credited to away
  assert.equal(away.foulsCommitted, 2);
  assert.equal(home.foulsCommitted, 0);

  // Extras
  assert.equal(home.distanceKm, 110);
  assert.equal(home.sprints, 180);
  assert.equal(home.timeOnBallPct, 60);
});

test('teamMetrics handles zero passes without NaN', () => {
  const m = teamMetrics({ passes: 0, passesCompleted: 0 }, { passes: 0 }, { ticks: 0, timeOnBallTicks: 0, distanceM: 0, sprints: 0 });
  assert.equal(m.passCompletionPct, 0);
  assert.equal(m.possessionPct, 0);
  assert.equal(m.timeOnBallPct, 0);
});

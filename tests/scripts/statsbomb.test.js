import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HALF_GOAL_M,
  YARD_TO_M,
  computeStandings,
  extractMatchMetrics,
  extractShotFeatures,
  isOpenPlayPass,
  loadAllowListCompetitions,
  loadMatchEvents,
  loadSeasonMatches,
} from '../../scripts/lib/statsbomb.mjs';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'statsbomb');

const XG_CFG = {
  logistic: {
    intercept: -1,
    distance: -0.1,
    angle: 1.0,
    header: -0.5,
    defendersInCone: -0.3,
    assistType: { none: 0, cross: 0, through: 0, cutback: 0, setPiece: 0 },
  },
  penaltyXg: 0.76,
};

test('statsbomb reader: allow-list discovery, geometry, open-play pass filter, own goal and period 5 exclusion', () => {
  const { found, missing } = loadAllowListCompetitions(fixtureDir);
  assert.equal(found.length, 1);
  assert.equal(found[0].competition_id, 2);
  assert.equal(missing.length, 4);

  const matches = loadSeasonMatches(fixtureDir, 2, 27);
  assert.equal(matches.length, 1);
  const m = matches[0];
  const standings = computeStandings(matches);
  assert.equal(standings[0].teamId, 100);
  assert.equal(standings[0].points, 3);
  assert.equal(standings[1].teamId, 200);
  assert.equal(standings[1].points, 0);

  const events = loadMatchEvents(fixtureDir, m.match_id);
  assert.ok(events);

  // Open-play pass filter: cross (p1) and Recovery (p2) counted; Throw-in (p3) excluded.
  assert.equal(isOpenPlayPass(events[0]), true);
  assert.equal(isOpenPlayPass(events[1]), true);
  assert.equal(isOpenPlayPass(events[2]), false);
  assert.equal(isOpenPlayPass(events[3]), true);

  // Shot features on s1: at (108, 40) -> 12 yards from (120, 40) = 10.9728 m
  const byId = new Map(events.map((e) => [e.id, e]));
  const feat = extractShotFeatures(byId.get('s1'), byId);
  const expectedDist = 12 * YARD_TO_M;
  const expectedAngle = 2 * Math.atan2(HALF_GOAL_M, expectedDist);
  assert.ok(Math.abs(feat.distance - expectedDist) < 1e-9);
  assert.ok(Math.abs(feat.angle - expectedAngle) < 1e-4);
  assert.equal(feat.isHeader, true);
  assert.equal(feat.defendersInCone, 1); // CB inside cone; GK excluded; RB outside cone; teammate excluded
  assert.equal(feat.assistType, 'cross');
  assert.equal(feat.isPenalty, false);
  assert.equal(feat.isGoal, true);

  // Match metrics:
  const { home, away } = extractMatchMetrics(events, 100, 200, XG_CFG);
  // Home: 1 open-play goal (s1) + 1 Own Goal For (og1); period 5 shoot-out goal (s_p5) excluded!
  assert.equal(home.goals, 2);
  assert.equal(home.shots, 1);
  assert.equal(home.shotsOnTarget, 1);
  assert.equal(home.passes, 2);
  assert.equal(home.passesCompleted, 2);
  assert.equal(home.passCompletionPct, 100);
  assert.ok(Math.abs(home.possessionPct - (200 / 3)) < 1e-9);

  // Away: 1 penalty goal (s2) + 1 Saved Off Target (s3, NOT on target); 1 incomplete pass; 1 foul
  assert.equal(away.goals, 1);
  assert.equal(away.shots, 2);
  assert.equal(away.shotsOnTarget, 1);
  assert.equal(away.passes, 1);
  assert.equal(away.passesCompleted, 0);
  assert.equal(away.passCompletionPct, 0);
  assert.equal(away.foulsCommitted, 1);
  assert.ok(away.xG > 0.76); // penaltyXg (0.76) + s3 xG
});

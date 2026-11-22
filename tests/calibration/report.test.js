import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedGap,
  evaluateCalibration,
  evaluateScenarioA,
  evaluateScenarioB,
  formatMarkdownReport,
} from '../../src/calibration/report.js';

const TARGETS = {
  metrics: [
    {
      id: 'goals',
      unit: 'perTeam',
      layer: 'L4',
      hard: true,
      bandA: [0.9, 1.9],
      scenarioB: {},
      tolerance: 0.2,
      toleranceAbs: 0.5,
      reference: { mean: 1.35, p10: 0, p90: 3, ci90: [1.3, 1.4], source: 'test', extractorVersion: '1', rows: 100 },
    },
    {
      id: 'shots',
      unit: 'perTeam',
      layer: 'L4',
      hard: true,
      bandA: [8, 18],
      scenarioB: {},
      tolerance: 0.2,
      toleranceAbs: 2,
      reference: { mean: 12.5, p10: 7, p90: 19, ci90: [12, 13], source: 'test', extractorVersion: '1', rows: 100 },
    },
    {
      id: 'possessionPct',
      unit: 'perTeam',
      layer: 'L2',
      hard: true,
      bandA: [45, 55],
      scenarioB: { strong: { band: [60, 70], hard: true } },
      tolerance: 0.15,
      toleranceAbs: 3,
      reference: { mean: 50, p10: 38, p90: 62, ci90: [49, 51], source: 'test', extractorVersion: '1', rows: 100 },
    },
    {
      id: 'xG',
      unit: 'perTeam',
      layer: 'L4',
      hard: true,
      bandA: [0.8, 2.2],
      scenarioB: { strongShare: { band: [0.75, 1.0], hard: true } },
      tolerance: 0.2,
      toleranceAbs: 0.15,
      reference: { mean: 1.3, p10: 0.4, p90: 2.4, ci90: [1.2, 1.4], source: 'test', extractorVersion: '1', rows: 100 },
    },
    {
      id: 'strongWinRate',
      unit: 'perMatch',
      layer: 'L4',
      hard: true,
      bandA: null,
      scenarioB: { strong: { band: [0.7, 0.8], hard: true } },
      tolerance: null,
      toleranceAbs: null,
      reference: { mean: 0.75, p10: 0, p90: 1, ci90: [0.7, 0.8], source: 'test', extractorVersion: '1', rows: 100 },
    },
  ],
};

/** Builds N balanced matches with realistic spread around the reference values. */
function makePassingA() {
  // 10 matches = 20 team rows covering p10..p90 cleanly.
  const goalsSeq = [0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3];
  const shotsSeq = [6, 7, 8, 9, 10, 10, 11, 12, 12, 13, 13, 14, 14, 15, 16, 17, 18, 19, 19, 20];
  const possSeq = [37, 39, 41, 43, 45, 46, 47, 48, 49, 50, 50, 51, 52, 53, 54, 55, 57, 59, 61, 63];
  const xgSeq = [0.3, 0.4, 0.45, 0.7, 0.8, 1.0, 1.1, 1.2, 1.3, 1.3, 1.4, 1.5, 1.6, 1.8, 1.9, 2.0, 2.2, 2.3, 2.4, 2.6];
  return Array.from({ length: 10 }, (_, i) => ({
    seed: i + 1,
    home: { goals: goalsSeq[i], shots: shotsSeq[i], possessionPct: possSeq[i], xG: xgSeq[i] },
    away: { goals: goalsSeq[19 - i], shots: shotsSeq[19 - i], possessionPct: 100 - possSeq[i], xG: xgSeq[19 - i] },
  }));
}

/** Builds 10 Scenario B matches with 65% strong possession, 0.80 xG share, 70% win rate. */
function makePassingB(winCount = 7, strongPoss = 65, strongXg = 2.4, weakXg = 0.6) {
  return Array.from({ length: 10 }, (_, i) => ({
    seed: i + 1,
    strong: { goals: i < winCount ? 2 : 1, possessionPct: strongPoss, xG: strongXg },
    weak: { goals: 1, possessionPct: 100 - strongPoss, xG: weakXg },
  }));
}

test('allowedGap uses toleranceAbs floor when ref is 0 or near zero', () => {
  assert.equal(allowedGap(0, 0.2, 0.5), 0.5);
  assert.equal(allowedGap(1, 0.2, 0.5), 0.5);
  assert.equal(allowedGap(10, 0.2, 0.5), 2.0);
});

test('evaluateCalibration passes and returns exitCode 0 when all Scenario A and B gates pass', () => {
  const report = evaluateCalibration({
    scenarioA: makePassingA(),
    scenarioB: makePassingB(),
    targets: TARGETS,
    meta: { engineVersion: '0.2.0', configHash: 'abc', configHash8: 'abc', matches: 10 },
  });
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  const md = formatMarkdownReport(report);
  assert.match(md, /PASS/);
  assert.match(md, /L4: Chances & Discipline/);
});

test('Scenario A fails when a hard metric mean is out of band', () => {
  const matches = makePassingA().map((m) => ({
    ...m,
    home: { ...m.home, shots: 25 },
    away: { ...m.away, shots: 25 },
  }));
  const res = evaluateScenarioA(matches, TARGETS);
  assert.equal(res.hardPass, false);
  const shots = res.metrics.find((m) => m.id === 'shots');
  assert.equal(shots?.meanOk, false);
  assert.equal(shots?.pass, false);
  assert.equal(shots?.worst.length, 3);
});

test('Scenario A fails when p10 or p90 is outside tolerance even if mean is inside band', () => {
  // All teams have exactly 12.5 shots (mean ok, but p10=12.5 vs ref 7, gap=2 -> fail!)
  const matches = makePassingA().map((m) => ({
    ...m,
    home: { ...m.home, shots: 12.5 },
    away: { ...m.away, shots: 12.5 },
  }));
  const res = evaluateScenarioA(matches, TARGETS);
  assert.equal(res.hardPass, false);
  const shots = res.metrics.find((m) => m.id === 'shots');
  assert.equal(shots?.meanOk, true);
  assert.equal(shots?.p10Ok, false);
  assert.equal(shots?.p90Ok, false);
});

test('Scenario A uses toleranceAbs for ref = 0 (goals p10 = 0, allowed gap = 0.5)', () => {
  // With ref p10 = 0 and toleranceAbs = 0.5, actual p10 = 0.4 passes, p10 = 0.9 fails.
  const passMatches = makePassingA();
  const passRes = evaluateScenarioA(passMatches, TARGETS);
  assert.equal(passRes.metrics.find((m) => m.id === 'goals')?.p10Ok, true);

  const failMatches = makePassingA().map((m) => ({
    ...m,
    home: { ...m.home, goals: 1 },
    away: { ...m.away, goals: 2 },
  }));
  const failRes = evaluateScenarioA(failMatches, TARGETS);
  assert.equal(failRes.metrics.find((m) => m.id === 'goals')?.p10Ok, false);
});

test('Scenario B checks each of the 3 hard gates and sets exitCode 1 on failure', () => {
  // 1. Possession too low (55 < 60)
  const badPoss = evaluateScenarioB(makePassingB(7, 55, 2.4, 0.6), TARGETS);
  assert.equal(badPoss.hardPass, false);
  assert.equal(badPoss.checks.find((c) => c.id === 'possessionPct')?.pass, false);

  // 2. xG share too low (0.60 < 0.75)
  const badXg = evaluateScenarioB(makePassingB(7, 65, 1.5, 1.0), TARGETS);
  assert.equal(badXg.hardPass, false);
  assert.equal(badXg.checks.find((c) => c.id === 'xG')?.pass, false);

  // 3. Win rate too high (0.90 > 0.80) or too low (0.50 < 0.70)
  const badWinHigh = evaluateScenarioB(makePassingB(9, 65, 2.4, 0.6), TARGETS);
  assert.equal(badWinHigh.hardPass, false);
  assert.equal(badWinHigh.checks.find((c) => c.id === 'strongWinRate')?.pass, false);

  const report = evaluateCalibration({ scenarioB: makePassingB(5, 65, 2.4, 0.6), targets: TARGETS });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
});

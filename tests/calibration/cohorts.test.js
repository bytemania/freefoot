import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { config, configHash } from '../../generated/config.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { generateRatedSquad, teamOverall } from '../../src/shared/squadgen.js';
import {
  COHORTS, EVENT_METRICS, FALLBACK_BENCHMARKS, evaluateCohort, matchCounts, moraleBands, probabilityBand, resolveBenchmarks,
} from '../../src/calibration/cohorts.js';

const benchFile = new URL('../../config/benchmarks/top5-10yr.json', import.meta.url);
const bench = resolveBenchmarks(existsSync(benchFile) ? JSON.parse(readFileSync(benchFile, 'utf8')) : null);

test('benchmarks resolve, falling back to built-in bounds when missing or malformed', () => {
  assert.equal(resolveBenchmarks(null), FALLBACK_BENCHMARKS);
  assert.equal(resolveBenchmarks({ eventFrequencies: {} }), FALLBACK_BENCHMARKS);
  for (const id of EVENT_METRICS) {
    const b = bench.eventFrequencies[id].band;
    assert.ok(b[0] < bench.eventFrequencies[id].mean && bench.eventFrequencies[id].mean < b[1], id);
  }
});

test('empirical upset probabilities are realistic: underdogs neither never nor half the time win', () => {
  const { even, moderate, heavy } = bench.strengthTiers;
  for (const t of [even, moderate, heavy]) assert.ok(Math.abs(t.favWin + t.draw + t.dogWin - 1) < 1e-3);
  assert.ok(heavy.dogWin >= 0.05 && heavy.dogWin <= 0.18, `heavy upset ${heavy.dogWin}`);
  assert.ok(heavy.draw >= 0.12 && heavy.draw <= 0.26, `heavy draw ${heavy.draw}`);
  assert.ok(moderate.dogWin > heavy.dogWin && even.dogWin > moderate.dogWin, 'upsets fall as the gap grows');
  assert.ok(even.draw > heavy.draw, 'draws fall as the gap grows');
  const [lo, hi] = probabilityBand(heavy.dogWin, 200);
  assert.ok(lo > 0 && hi < 0.5);
});

test('morale bands are bounded by the form data', () => {
  const b = moraleBands(bench);
  assert.ok(b.winEdge[0] > 0 && b.winEdge[1] <= bench.formEffect.rawWinRateDelta);
  assert.ok(b.conversionDelta[0] === 0 && b.conversionDelta[1] > bench.formEffect.matchedStrength.conversionDelta);
});

test('rated squads hit their target OVR', () => {
  for (const ovr of [68, 74, 80, 83, 88]) {
    const team = generateRatedSquad(ovr, 99, config, { side: 'home' });
    assert.ok(Math.abs(teamOverall(team, config.roles) - ovr) < 2.5, `${ovr} -> ${teamOverall(team, config.roles)}`);
  }
});

/** @param {number} goalsHome @param {number} goalsAway @param {number} shotsHome @param {number} shotsAway */
function row(goalsHome, goalsAway, shotsHome = 13, shotsAway = 12) {
  const events = [];
  for (let i = 0; i < shotsHome; i++) events.push({ type: 'SHOT', teamIndex: 0, meta: { result: i < 4 ? 'ON_TARGET' : 'OFF_TARGET' } });
  for (let i = 0; i < shotsAway; i++) events.push({ type: 'SHOT', teamIndex: 1, meta: { result: i < 4 ? 'ON_TARGET' : 'OFF_TARGET' } });
  for (const [type, n] of /** @type {Array<[string, number]>} */ ([['CORNER', 10], ['FOUL', 24], ['OFFSIDE', 4], ['YELLOW_CARD', 4], ['INJURY', 2]])) {
    for (let i = 0; i < n; i++) events.push({ type, teamIndex: i % 2 });
  }
  return matchCounts(/** @type {any} */ (events), [goalsHome, goalsAway]);
}

test('matchCounts and evaluateCohort: a realistic heavy-favourite cohort passes, a 100% one fails', () => {
  const heavy = /** @type {any} */ (COHORTS.find((c) => c.id === 'heavy'));
  const r = row(2, 1, 16, 9);
  assert.equal(r.total.shots, 25);
  assert.equal(r.total.shotsOnTarget, 8);
  assert.equal(r.total.corners, 10);
  assert.equal(r.total.goals, 3);

  // 73 wins, 17 draws, 10 upsets.
  const realistic = [
    ...Array.from({ length: 73 }, () => row(3, 1, 16, 9)),
    ...Array.from({ length: 17 }, () => row(1, 1, 16, 9)),
    ...Array.from({ length: 10 }, () => row(0, 1, 16, 9)),
  ];
  const ok = evaluateCohort(heavy, realistic, bench);
  assert.ok(ok.checks.find((c) => c.id === 'result.dogWin')?.pass);
  assert.ok(ok.checks.find((c) => c.id === 'result.favWin')?.pass);

  const lopsided = evaluateCohort(heavy, Array.from({ length: 100 }, () => row(5, 0, 20, 4)), bench);
  assert.equal(lopsided.pass, false);
  assert.equal(lopsided.checks.find((c) => c.id === 'result.dogWin')?.pass, false);
});

test('engine: a heavy underdog (68 v 88) still takes points over a short run', () => {
  let dogPoints = 0;
  let favWins = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const home = generateRatedSquad(88, (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home' });
    const away = generateRatedSquad(68, (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away' });
    const e = MatchEngine.create({ v: 1, seed, configHash, home, away }, config);
    while (true) {
      const r = e.step(2000);
      if (r.stoppedFor === 'FULL_TIME' || r.stoppedFor === 'FORCED_DECISION') break;
    }
    const [h, a] = [e.state.teams[0].score, e.state.teams[1].score];
    if (h > a) favWins++;
    else dogPoints += h === a ? 1 : 3;
  }
  assert.ok(favWins >= 6, `favourite won ${favWins}/12`);
  assert.ok(dogPoints > 0, 'the underdog is never shut out of every match');
});

test('extended cohort profile: diagnostics and outlier seeds are reported and never change pass / fail', async () => {
  const { matchDiagnostics, summarizeDiagnostics, outlierSeeds } = await import('../../src/calibration/diagnostics.js');
  const ev = (/** @type {string} */ type, /** @type {number} */ teamIndex, /** @type {any} */ extra = {}) => ({ type, teamIndex, x: 0, y: 0, zone: 14, tick: 1, meta: {}, ...extra });
  const events = [
    ev('THROW_IN', 0), ev('THROW_IN', 1), ev('THROW_IN', 1), ev('MISCONTROL', 0),
    ev('PASS', 0, { meta: { completed: true, kind: 'THROUGH' } }), ev('PASS', 0, { meta: { completed: false } }),
    ev('PASS', 1, { meta: { completed: true } }), ev('INTERCEPTION', 1),
    ev('SHOT', 0, { meta: { xg: 0.25, distance: 10, result: 'ON_TARGET' } }), ev('SHOT', 0, { meta: { xg: 0.05, distance: 25, result: 'OFF_TARGET' } }),
  ];
  const d = matchDiagnostics(/** @type {any} */ (events));
  assert.equal(d.home.throwIns, 1);
  assert.equal(d.away.throwIns, 2);
  assert.equal(d.home.miscontrols, 1);
  assert.equal(d.home.progressivePasses, 1);
  assert.equal(d.away.interceptions, 1);
  assert.equal(d.home.shotsInBox, 1);

  const rows = [1, 2, 3, 4, 5].map((seed) => ({ seed, ...matchCounts(/** @type {any} */ (events), [seed === 3 ? 7 : 1, 0]), diag: d }));
  const s = summarizeDiagnostics(rows);
  assert.ok(s);
  assert.equal(s.rows.throwIns, 3);
  assert.equal(s.rows.miscontrols, 1);
  assert.ok(Math.abs(s.rows.passCompletionPct - 100 * 2 / 3) < 1e-9);
  assert.equal(s.rows.shotsInBoxPct, 50);
  assert.equal(s.home.shots, 2);
  assert.equal(s.away.shots, 0);
  assert.equal(outlierSeeds(rows)[0].seed, 3, 'the 7-goal seed is the furthest from the mean');
  assert.equal(outlierSeeds(rows).length, 3);
  assert.equal(summarizeDiagnostics([{}]), null);

  const cohort = COHORTS[0];
  const plain = evaluateCohort(cohort, [1, 2, 3, 4, 5].map((seed) => matchCounts(/** @type {any} */ (events), [seed === 3 ? 7 : 1, 0])), bench);
  const rich = evaluateCohort(cohort, rows, bench);
  assert.equal(plain.diagnostics, null);
  assert.equal(rich.pass, plain.pass);
  assert.deepEqual(rich.checks, plain.checks);
  assert.equal(rich.outliers.length, 3);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import homeSquad from '../../generated/squads/sample-home.js';
import awaySquad from '../../generated/squads/sample-away.js';
import { memoryStorage } from '../../src/runtime/storage.js';
import { matchMinuteLabel } from '../../src/shared/matchMinute.js';
import {
  FAMILIARITY_STORAGE_KEY,
  TacticalFamiliarityStore,
  applyFamiliarityProgression,
  defaultFamiliarityRecord,
  sanitizeFamiliarityRecord,
} from '../../src/runtime/matchday/TacticalFamiliarityStore.js';
import {
  BENCH_ROLE_ORDER,
  autoPickBestXI,
  buildMatchdayInput,
  createDefaultMatchInput,
  orderStartersForFormation,
  pickAiPreset,
} from '../../src/runtime/matchday/MatchdayBuilder.js';
import { buildMatchReport } from '../../src/runtime/matchday/MatchReport.js';
import { MatchdaySession } from '../../src/runtime/matchday/MatchdaySession.js';
import { validateMatchInput } from '../../src/engine/contracts/MatchInput.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import {
  hasPendingSubmission,
  pendingPlanSwitch,
  pendingSubmission,
  pendingTargetFormation,
} from '../../src/runtime/managerPending.js';

test('matchMinuteLabel formats H1, H2, and added time', () => {
  assert.equal(matchMinuteLabel(0, 1), "1'");
  assert.equal(matchMinuteLabel(45 * 60 + 90, 1), "45+2'");
  assert.equal(matchMinuteLabel(2700, 2), "46'");
  assert.equal(matchMinuteLabel(90 * 60 + 130, 2), "90+3'");
});

test('TacticalFamiliarityStore: defaults, round-trip, corrupt JSON, unknown version, clamping, and progression reducer', async () => {
  const storage = memoryStorage();
  const store = new TacticalFamiliarityStore({ storage, tacticalPresets: config.tacticalPresets });

  // First load returns defaults
  const init = await store.load();
  assert.equal(init.schemaVersion, 1);
  assert.equal(init.scopeId, 'default');
  assert.equal(init.planA, 'balanced');
  assert.equal(init.planB, 'wing-play');
  assert.equal(init.formations['4-3-3'], 90);
  assert.equal(init.tactics['balanced'], 90);

  // Save + reload
  const updated = applyFamiliarityProgression(init, { formations: { '4-3-3': 15, '3-5-2': 4 }, tactics: { 'tiki-taka': 60 } });
  assert.equal(updated.formations['4-3-3'], 100);
  assert.equal(updated.formations['3-5-2'], 49);
  assert.equal(updated.tactics['tiki-taka'], 100);
  await store.save({ ...updated, planA: 'tiki-taka', planB: 'gegenpress' });
  const reloaded = await store.load();
  assert.equal(reloaded.planA, 'tiki-taka');
  assert.equal(reloaded.planB, 'gegenpress');
  assert.equal(reloaded.formations['4-3-3'], 100);

  // Corrupt JSON falls back cleanly
  await storage.set(FAMILIARITY_STORAGE_KEY, '{not-json');
  assert.deepEqual(await store.load(), defaultFamiliarityRecord(config.tacticalPresets));

  // Unknown schemaVersion falls back cleanly
  await storage.set(FAMILIARITY_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, planA: 'gegenpress' }));
  assert.deepEqual(await store.load(), defaultFamiliarityRecord(config.tacticalPresets));

  // Clamping & duplicate planA === planB repair
  const repaired = sanitizeFamiliarityRecord(
    { schemaVersion: 1, planA: 'gegenpress', planB: 'gegenpress', formations: { '4-3-3': 999, '4-4-2': -5 }, tactics: { balanced: Number.NaN } },
    config.tacticalPresets,
  );
  assert.equal(repaired.planA, 'gegenpress');
  assert.notEqual(repaired.planB, 'gegenpress');
  assert.equal(repaired.formations['4-3-3'], 100);
  assert.equal(repaired.formations['4-4-2'], 0);
  assert.equal(repaired.tactics.balanced, 90);
});

test('MatchdayBuilder: createDefaultMatchInput, autoPickBestXI, orderStartersForFormation, pickAiPreset, buildMatchdayInput', () => {
  const def = createDefaultMatchInput({ seed: 22, configHash, homeSquad, awaySquad });
  assert.equal(def.var, true);
  assert.equal(def.home.shouts, true);
  assert.equal(def.home.tacticalPlans, undefined);
  assert.deepEqual(validateMatchInput(def, config), []);

  // Auto-pick for 3-5-2 puts all 3 CBs into the 3 CB slots (1, 2, 3) and GK at 0
  const slots352 = config.tactics.formations['3-5-2'].slots;
  const picked = autoPickBestXI(homeSquad.players, slots352, config.roles);
  assert.equal(picked.length, 18);
  assert.equal(picked[0].role, 'GK');
  assert.equal(picked[1].role, 'CB');
  assert.equal(picked[2].role, 'CB');
  assert.equal(picked[3].role, 'CB');
  // Bench sorted by BENCH_ROLE_ORDER
  const benchRoles = picked.slice(11).map((p) => BENCH_ROLE_ORDER.indexOf(p.role));
  for (let i = 1; i < benchRoles.length; i++) assert.ok(benchRoles[i] >= benchRoles[i - 1]);

  // orderStartersForFormation preserves bench and aligns starters
  const reordered = orderStartersForFormation(picked, config.tactics.formations['4-3-3'].slots, config.roles);
  assert.equal(reordered[0].role, 'GK');
  assert.deepEqual(reordered.slice(11).map((p) => p.id), picked.slice(11).map((p) => p.id));

  // pickAiPreset is deterministic
  const ai1 = pickAiPreset(42, config.tacticalPresets.presets);
  const ai2 = pickAiPreset(42, config.tacticalPresets.presets);
  assert.equal(ai1.id, ai2.id);

  // buildMatchdayInput produces valid MatchInput with AI aligned & no AI tacticalPlans
  const fam = defaultFamiliarityRecord(config.tacticalPresets);
  const input = buildMatchdayInput({
    seed: 7,
    config,
    configHash,
    homeSquad,
    awaySquad,
    homePlayers: autoPickBestXI(homeSquad.players, config.tactics.formations['4-3-3'].slots, config.roles),
    planAId: 'balanced',
    planBId: 'wing-play',
    familiarity: fam,
  });
  assert.deepEqual(validateMatchInput(input, config), []);
  assert.ok(input.home.tacticalPlans);
  assert.equal(input.away.tacticalPlans, undefined);
  assert.equal(input.away.formationId, pickAiPreset(7, config.tacticalPresets.presets).formationId);
});

test('MatchReport: VAR-disallowed goals, OWN_GOAL flip, HT pause classification, MOTM tie-breaking, and continuous familiarity progression', () => {
  const fam = defaultFamiliarityRecord(config.tacticalPresets);
  // Shared-formation test (4-3-3 balanced + 4-3-3 tiki-taka) with tiki-taka at 62 -> +4 reaches 66 (Fluid unlocked!)
  fam.formations['4-3-3'] = 100;
  fam.tactics['tiki-taka'] = 62;
  const input = buildMatchdayInput({
    seed: 10,
    config,
    configHash,
    homeSquad,
    awaySquad,
    homePlayers: autoPickBestXI(homeSquad.players, config.tactics.formations['4-3-3'].slots, config.roles),
    planAId: 'tiki-taka',
    planBId: 'balanced',
    familiarity: fam,
  });

  const basePlayers = [...input.home.players, ...input.away.players].map((p, index) => ({
    index,
    id: p.id,
    minutes: index % 18 < 11 ? 90 : 0,
    distanceKm: 10,
    fitness: 0.7,
    card: 0,
    injury: 0,
    goals: 0,
    assists: 0,
    rating: 6.5,
  }));
  // Tie ratings between player 9 (1 goal) and player 10 (0 goals) -> player 9 wins MOTM
  basePlayers[9].rating = 8.4;
  basePlayers[9].goals = 1;
  basePlayers[10].rating = 8.4;
  basePlayers[10].goals = 0;

  const syntheticResult = /** @type {any} */ ({
    v: 1,
    engineVersion: '0.1.0',
    configHash,
    seed: 10,
    score: { home: 2, away: 0 },
    stats: { home: { goals: 2 }, away: { goals: 0 } },
    players: basePlayers,
    suspensions: [],
    finalStateHash: 1,
    planUsage: {
      home: {
        A: { minutes: 95, modifiedMinutes: 0 }, // heavy added time (>90) must cap gain at +4
        B: { minutes: 5, modifiedMinutes: 0 }, // cameo (<10 min) uses unused <80 rule (balanced is 90 -> +0)
      },
    },
    events: [
      { seq: 1, tick: 12000, type: 'GOAL', teamIndex: 0, actorIndex: 9, secondaryIndices: [], meta: { kind: 'OPEN_PLAY' } },
      // VAR-disallowed goal for player 9
      { seq: 2, tick: 24000, type: 'GOAL', teamIndex: 0, actorIndex: 9, secondaryIndices: [], meta: { kind: 'OPEN_PLAY' } },
      { seq: 3, tick: 24100, type: 'VAR_DECISION', teamIndex: 0, actorIndex: 9, secondaryIndices: [], meta: { outcome: 'goalDisallowed' } },
      // Yellow upgraded to red by VAR
      { seq: 4, tick: 30000, type: 'YELLOW_CARD', teamIndex: 1, actorIndex: 20, secondaryIndices: [], meta: {} },
      { seq: 5, tick: 30100, type: 'VAR_DECISION', teamIndex: 1, actorIndex: 20, secondaryIndices: [], meta: { outcome: 'redCardUpgraded' } },
      // Half-time + half-time pause plan switch (same tick, seq > htSeq -> 'HT')
      { seq: 6, tick: 56000, type: 'HALF_TIME', teamIndex: -1, actorIndex: -1, secondaryIndices: [], meta: {} },
      { seq: 7, tick: 56000, type: 'FORMATION_CHANGE', teamIndex: 0, actorIndex: -1, secondaryIndices: [], meta: { formationId: '4-3-3', plan: 'B', tacticId: 'balanced' } },
      // Away OWN_GOAL (teamIndex = 1 conceding -> must appear in home scorers with ownGoal: true!)
      { seq: 8, tick: 68000, type: 'GOAL', teamIndex: 1, actorIndex: 20, secondaryIndices: [], meta: { kind: 'OWN_GOAL' } },
    ],
  });

  const report = buildMatchReport({ input, result: syntheticResult, config });
  assert.equal(report.motm?.index, 9);
  assert.equal(report.scorers.home.length, 2, 'Should include valid goal + away own goal, excluding VAR-disallowed goal');
  assert.equal(report.scorers.home[0].ownGoal, false);
  assert.equal(report.scorers.home[1].ownGoal, true);
  assert.equal(report.scorers.away.length, 0);

  const disallowedEv = report.keyEvents.find((e) => e.seq === 2);
  assert.equal(disallowedEv?.overturned, true);
  const upgradedYellow = report.keyEvents.find((e) => e.seq === 4);
  assert.equal(upgradedYellow?.upgradedToRed, true);
  const htSwitch = report.keyEvents.find((e) => e.seq === 7);
  assert.equal(htSwitch?.minute, 'HT');

  // Familiarity progression: tiki-taka 62 -> 66 unlocks Fluid (79 -> 86)!
  assert.ok(report.familiarity);
  const planA = report.familiarity.plans[0];
  assert.equal(planA.instrBefore, 62);
  assert.equal(planA.instrAfter, 66);
  assert.equal(planA.effectiveBefore, 79);
  assert.equal(planA.effectiveAfter, 86);
  assert.equal(planA.fluidUnlocked, true);
  // Shared formation 4-3-3 computed once (capped at +4)
  assert.equal(report.familiarity.deltas.formations['4-3-3'], 4);
  // Cameo Plan B (balanced at 90 >= 80) gets +0
  assert.equal(report.familiarity.deltas.tactics['balanced'], 0);
});

test('MatchReport: continuous effectiveInstrMinutes smooths modified gain while keeping formFam at full gain', () => {
  const fam = defaultFamiliarityRecord(config.tacticalPresets);
  const input = buildMatchdayInput({
    seed: 12,
    config,
    configHash,
    homeSquad,
    awaySquad,
    homePlayers: autoPickBestXI(homeSquad.players, config.tactics.formations['4-2-3-1'].slots, config.roles),
    planAId: 'gegenpress',
    planBId: 'low-block',
    familiarity: fam,
  });
  const result = /** @type {any} */ ({
    v: 1, engineVersion: '0.1.0', configHash, seed: 12,
    score: { home: 1, away: 1 }, stats: { home: {}, away: {} },
    players: [], suspensions: [], finalStateHash: 1, events: [],
    planUsage: {
      home: {
        A: { minutes: 90, modifiedMinutes: 45 }, // effInstrMin = 45 + 22.5 = 67.5 -> round(4 * 0.75) = 3; formGain = 4
        B: { minutes: 0, modifiedMinutes: 0 }, // unused < 80 -> +1 both
      },
    },
  });
  const report = buildMatchReport({ input, result, config });
  assert.equal(report.familiarity?.deltas.formations['4-2-3-1'], 4);
  assert.equal(report.familiarity?.deltas.tactics['gegenpress'], 3);
  assert.equal(report.familiarity?.deltas.formations['5-4-1'], 1);
  assert.equal(report.familiarity?.deltas.tactics['low-block'], 1);
});

test('MatchdaySession: init, plan switching, GK-only swaps, single-use consumeMatchInput, idempotent completeMatch, resetForNextMatch', async () => {
  const storage = memoryStorage();
  let nextSeed = 100;
  const session = new MatchdaySession({
    config,
    configHash,
    homeSquad,
    awaySquad,
    storage,
    search: '?seed=22',
    randomSeed: () => ++nextSeed,
  });
  assert.equal(session.seed, 22, 'Bootstrap reads ?seed=22 once');
  await session.init();

  // Plan A / Plan B mutual exclusion
  assert.equal(session.setPlan('A', 'wing-play'), false);
  assert.equal(session.setPlan('A', 'gegenpress'), true);
  assert.equal(session.familiarity.planA, 'gegenpress');

  // GK swap rules: cannot swap slot 0 with outfielder, CAN swap slot 0 with bench GK (index 11 after auto-pick)
  assert.equal(session.swapPlayers(0, 1), false);
  const benchGkIdx = session.homePlayers.findIndex((p, idx) => idx >= 11 && p.role === 'GK');
  assert.ok(benchGkIdx >= 11);
  assert.equal(session.swapPlayers(1, benchGkIdx), false, 'Cannot place bench GK into outfield starter slot');
  assert.equal(session.swapPlayers(0, benchGkIdx), true, 'GK-for-GK swap allowed');

  const input = session.prepareKickOff();
  assert.equal(session.consumeMatchInput(), input);
  assert.equal(session.consumeMatchInput(), null, 'consumeMatchInput is single-use');

  // Run match to full time and test idempotent completeMatch
  const eng = MatchEngine.create(input, config);
  while (eng.state.restart.state !== 'FULL_TIME') {
    const r = eng.step(500);
    if (r.stoppedFor === 'FORCED_DECISION') {
      for (let t = 0; t < 2; t++) {
        if (eng.state.teams[t].forcedDecision) {
          eng.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: t, payload: { inIndex: null, outIndex: null } });
        }
      }
    }
  }
  const res = eng.getResult();
  const famBefore = session.familiarity.tactics['gegenpress'];
  await session.completeMatch(input, res);
  const famAfter1 = session.familiarity.tactics['gegenpress'];
  assert.ok(famAfter1 > famBefore);
  assert.ok(session.latestReport !== null);

  // Second completeMatch call is idempotent (no double-credit!)
  await session.completeMatch(input, res);
  assert.equal(session.familiarity.tactics['gegenpress'], famAfter1);

  // resetForNextMatch rolls new seed and retains familiarity
  session.resetForNextMatch();
  assert.equal(session.seed, 101);
  assert.equal(session.latestReport, null);
  assert.equal(session.familiarity.tactics['gegenpress'], famAfter1);
});

test('managerPending: pendingPlanSwitch, pendingTargetFormation (<11 reduced), and non-locking hasPendingSubmission', () => {
  const fam = defaultFamiliarityRecord(config.tacticalPresets);
  const input = buildMatchdayInput({
    seed: 22,
    config,
    configHash,
    homeSquad,
    awaySquad,
    homePlayers: autoPickBestXI(homeSquad.players, config.tactics.formations['4-3-3'].slots, config.roles),
    planAId: 'balanced',
    planBId: 'fluid-counter',
    familiarity: fam,
  });
  const eng = MatchEngine.create(input, config);
  eng.step(120);
  eng.applyCommand({ issuer: 'human', type: 'SWITCH_TACTIC_PLAN', teamIndex: 0, payload: { plan: 'B' } });

  assert.equal(pendingPlanSwitch(eng.state, 0)?.plan, 'B');
  assert.equal(pendingTargetFormation(eng.state, 0), '3-5-2');
  assert.ok(pendingSubmission(eng.state, 0).some((it) => it.kind === 'PLAN_SWITCH'));
  assert.equal(hasPendingSubmission(eng.state, 0), false, 'PLAN_SWITCH does not lock Manager');

  // With 10 players on pitch, pendingTargetFormation resolves through emergencyShape ('4-4-1')
  eng.state.players[10].onPitch = 0;
  assert.equal(pendingTargetFormation(eng.state, 0), '4-4-1');
});

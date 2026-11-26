import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import homeSquad from '../../generated/squads/sample-home.js';
import awaySquad from '../../generated/squads/sample-away.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { validateMatchInput } from '../../src/engine/contracts/MatchInput.js';
import {
  countInstructionDeviations,
  deriveEffectiveFamiliarity,
  familiarityKnobsFor,
} from '../../src/engine/tactics/Familiarity.js';
import { computeOptimalSlotAssignments, setFormation } from '../../src/engine/tactics/Formation.js';
import { standInKeeper } from '../../src/engine/commands/Forced.js';
import { inspectPitch } from '../../src/engine/debug/inspect.js';

const instrCfg = config.tactics.instructions;

/** @param {Record<string, any>} [homeOverrides] */
function makeInput(homeOverrides = {}) {
  return /** @type {any} */ (
    JSON.parse(
      JSON.stringify({
        v: 1,
        seed: 22,
        configHash,
        home: { ...homeSquad, ...homeOverrides },
        away: awaySquad,
      }),
    )
  );
}

/** @param {Partial<import('../../src/engine/contracts/MatchInput.js').TeamTacticalPlans>} [overrides] */
function makePlans(overrides = {}) {
  return {
    planA: {
      tacticId: 'balanced',
      formationId: '4-3-3',
      instructions: {},
      formFam: 90,
      instrFam: 90,
      ...overrides.planA,
    },
    planB: {
      tacticId: 'wing-play',
      formationId: '4-4-2',
      instructions: { attackFocus: 'wings' },
      formFam: 85,
      instrFam: 60,
      ...overrides.planB,
    },
  };
}

test('Familiarity: Fluid-gate boundary thresholds (100,64)->79, (100,65)->86, (64,100)->78', () => {
  const c1 = deriveEffectiveFamiliarity(instrCfg, { formFam: 100, instrFam: 64, instructions: {} }, {});
  assert.equal(c1.raw, 86);
  assert.equal(c1.capped, true);
  assert.equal(c1.effective, 79);
  assert.equal(c1.tier, 'competent');

  const c2 = deriveEffectiveFamiliarity(instrCfg, { formFam: 100, instrFam: 65, instructions: {} }, {});
  assert.equal(c2.capped, false);
  assert.equal(c2.effective, 86);
  assert.equal(c2.tier, 'fluid');

  const c3 = deriveEffectiveFamiliarity(instrCfg, { formFam: 64, instrFam: 100, instructions: {} }, {});
  assert.equal(c3.capped, false);
  assert.equal(c3.effective, 78);
  assert.equal(c3.tier, 'competent');
});

test('Familiarity: override penalty (-12 per deviated instruction) and knob ramps', () => {
  const plan = { formFam: 85, instrFam: 85, instructions: {} };
  assert.equal(countInstructionDeviations(instrCfg, {}, {}), 0);
  assert.equal(countInstructionDeviations(instrCfg, { tempo: 'fast', directness: 'direct' }, {}), 2);

  const oneTweak = deriveEffectiveFamiliarity(instrCfg, plan, { tempo: 'fast' });
  assert.equal(oneTweak.instrFamLive, 73);
  assert.equal(oneTweak.effective, 80);
  assert.equal(oneTweak.modified, true);
  assert.equal(familiarityKnobsFor(oneTweak.effective), null);

  const twoTweaks = deriveEffectiveFamiliarity(instrCfg, plan, { tempo: 'fast', directness: 'direct' });
  assert.equal(twoTweaks.instrFamLive, 61);
  assert.equal(twoTweaks.effective, 75);
  assert.equal(twoTweaks.tier, 'competent');

  assert.equal(familiarityKnobsFor(80), null);
  assert.equal(familiarityKnobsFor(100), null);
  const k79 = familiarityKnobsFor(79);
  assert.ok(k79 !== null && Math.abs(k79.noiseMul - 1.002) < 1e-9 && k79.drainMul === undefined);
  const k50 = familiarityKnobsFor(50);
  assert.ok(k50 !== null && Math.abs(k50.noiseMul - 1.06) < 1e-9 && k50.drainMul === undefined);
  const k0 = familiarityKnobsFor(0);
  assert.ok(k0 !== null && Math.abs(k0.noiseMul - 1.12) < 1e-9 && Math.abs(k0.drainMul - 1.05) < 1e-9);
});

test('validateMatchInput enforces tacticalPlans invariants including 11-slot formations', () => {
  const valid = makeInput({ tacticalPlans: makePlans() });
  assert.deepEqual(validateMatchInput(valid, config), []);

  const reduced = makeInput({
    tacticalPlans: makePlans({ planB: { tacticId: 'low-block', formationId: '4-4-1', instructions: {}, formFam: 50, instrFam: 50 } }),
  });
  assert.ok(validateMatchInput(reduced, config).some((e) => e.includes('must have 11 slots')));

  const sameId = makeInput({
    tacticalPlans: makePlans({ planB: { tacticId: 'balanced', formationId: '4-4-2', instructions: {}, formFam: 80, instrFam: 80 } }),
  });
  assert.ok(validateMatchInput(sameId, config).some((e) => e.includes('must differ from planA.tacticId')));

  const mismatchForm = makeInput({
    tacticalPlans: makePlans({ planA: { tacticId: 'wing-play', formationId: '4-4-2', instructions: {}, formFam: 80, instrFam: 80 } }),
  });
  assert.ok(validateMatchInput(mismatchForm, config).some((e) => e.includes('must match home.formationId')));

  const badFam = makeInput({
    tacticalPlans: makePlans({ planA: { tacticId: 'balanced', formationId: '4-3-3', instructions: {}, formFam: Number.NaN, instrFam: 90 } }),
  });
  assert.ok(validateMatchInput(badFam, config).some((e) => e.includes('formFam must be a number 0-100')));
});

test('Initial unfamiliar penalty applies from tick 0 and survives shout activation + expiry', () => {
  const input = makeInput({
    shouts: true,
    tacticalPlans: makePlans({ planA: { tacticId: 'balanced', formationId: '4-3-3', instructions: {}, formFam: 30, instrFam: 30 } }),
  });
  const engine = MatchEngine.create(input, config, { debug: true });
  const team = engine.state.teams[0];
  assert.ok(team.familiarityKnobs !== null);
  assert.ok(team.knobs.noiseMul > 1.08);
  assert.ok(team.knobs.drainMul > 1.01);

  const shoutRes = engine.applyCommand({ issuer: 'human', type: 'ISSUE_SHOUT', teamIndex: 0, payload: { shout: 'encourage' } });
  assert.equal(shoutRes.ok, true);
  // Advance past shout duration so shout expires inside updateShouts()
  engine.step(4000);
  assert.equal(team.shout?.active, null);
  assert.ok(team.familiarityKnobs !== null);
  assert.equal(team.knobs.noiseMul, team.familiarityKnobs.noiseMul);
  assert.equal(team.knobs.drainMul, team.familiarityKnobs.drainMul);
});

test('SET_FORMATION rejected when tacticalPlans present; SWITCH_TACTIC_PLAN & CANCEL_TACTIC_PLAN rules + dependent instruction cleanup', () => {
  const input = makeInput({ tacticalPlans: makePlans() });
  const engine = MatchEngine.create(input, config, { debug: true });

  // Raw SET_FORMATION blocked
  assert.deepEqual(
    engine.applyCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '4-4-2' } }),
    { ok: false, code: 'USE_TACTIC_PLAN' },
  );
  // Already active plan rejected unconditionally
  assert.deepEqual(
    engine.applyCommand({ issuer: 'human', type: 'SWITCH_TACTIC_PLAN', teamIndex: 0, payload: { plan: 'A' } }),
    { ok: false, code: 'ALREADY_ACTIVE_PLAN' },
  );
  // No pending plan switch to cancel
  assert.deepEqual(
    engine.applyCommand({ issuer: 'human', type: 'CANCEL_TACTIC_PLAN', teamIndex: 0, payload: {} }),
    { ok: false, code: 'NO_PENDING_PLAN_SWITCH' },
  );

  // Advance into open play (past kickoff hold)
  engine.step(120);
  assert.equal(engine.state.restart.state, 'IN_PLAY');

  // Queue Plan B, then tweak an instruction on top, then cancel Plan B -> both switch and dependent instruction cleared
  const sw = engine.applyCommand({ issuer: 'human', type: 'SWITCH_TACTIC_PLAN', teamIndex: 0, payload: { plan: 'B' } });
  assert.equal(sw.ok, true);
  const tw = engine.applyCommand({
    issuer: 'human',
    type: 'SET_INSTRUCTIONS',
    teamIndex: 0,
    payload: { instructions: { attackFocus: 'wings', tempo: 'fast' } },
  });
  assert.equal(tw.ok, true);
  assert.equal(engine.state.pendingCommands.length, 2);

  const cancel = engine.applyCommand({ issuer: 'human', type: 'CANCEL_TACTIC_PLAN', teamIndex: 0, payload: {} });
  assert.equal(cancel.ok, true);
  assert.equal(engine.state.pendingCommands.length, 0);
  assert.equal(engine.state.teams[0].activePlan, 'A');
});

test('Simultaneous SUBSTITUTE + SWITCH_TACTIC_PLAN runs Hungarian remapping on post-sub XI and replays identically', () => {
  const input = makeInput({
    tacticalPlans: makePlans({
      planB: {
        tacticId: 'fluid-counter',
        formationId: '3-5-2',
        instructions: { tempo: 'fast', attackTransition: 'counter' },
        formFam: 45,
        instrFam: 50,
      },
    }),
  });
  const engine = MatchEngine.create(input, config, { debug: true });
  engine.step(120);
  assert.equal(engine.state.restart.state, 'IN_PLAY');

  // Bring on bench CB (index 12) for starter winger (index 8) alongside Plan B (3-5-2, 3 CB slots: 1,2,3)
  const subRes = engine.applyCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: 8, inIndex: 12 } });
  assert.equal(subRes.ok, true);
  const swRes = engine.applyCommand({ issuer: 'human', type: 'SWITCH_TACTIC_PLAN', teamIndex: 0, payload: { plan: 'B' } });
  assert.equal(swRes.ok, true);

  // Step until Plan B executes at the next stoppage (debug: true also runs validateEvent on FORMATION_CHANGE!)
  let switched = false;
  for (let i = 0; i < 600 && !switched; i++) {
    const out = engine.step(20);
    if (out.events.some((e) => e.type === 'FORMATION_CHANGE' && e.meta.plan === 'B')) switched = true;
  }
  assert.equal(switched, true, 'Plan B should execute at the next stoppage');
  assert.equal(engine.state.teams[0].activePlan, 'B');
  assert.equal(engine.state.teams[0].formationId, '3-5-2');
  assert.equal(engine.state.players[12].onPitch, 1);
  const cbSlotRole = config.tactics.formations['3-5-2'].slots[engine.state.players[12].slot].role;
  assert.equal(cbSlotRole, 'CB', 'Incoming CB must land in a CB slot after post-sub Hungarian remapping');

  // Replay determinism check
  const replayed = MatchEngine.replay(input, config, engine.getCommandLog(), engine.state.tick);
  assert.equal(replayed.engine.state.hash(), engine.state.hash());
  assert.equal(replayed.engine.state.teams[0].activePlan, 'B');
});

test('Short-handed remapping (10, 9, 8, 7 players + acting GK) pins GK to slot 0 and preserves CBs', () => {
  const input = makeInput({
    tacticalPlans: makePlans({
      planB: { tacticId: 'low-block', formationId: '5-4-1', instructions: { defensiveLine: 'low' }, formFam: 50, instrFam: 50 },
    }),
  });
  const engine = MatchEngine.create(input, config, { debug: true });
  const s = engine.state;
  const team = s.teams[0];

  // Send off GK (index 0) and put outfielder in goal via standInKeeper
  s.players[0].onPitch = 0;
  s.players[0].card = 2;
  s.players[0].out = 2;
  standInKeeper(s, team);
  const actingGk = s.players.find((p) => p.team === 0 && p.onPitch === 1 && p.isKeeper === 1);
  assert.ok(actingGk, 'An outfielder should be marked as acting keeper');

  // Drop down to 7 players total (4 sent off)
  for (const idx of [8, 9, 10]) {
    s.players[idx].onPitch = 0;
    s.players[idx].card = 2;
    s.players[idx].out = 2;
  }
  s.rebuildOnPitchList();

  setFormation(s, team, '5-4-1');
  assert.equal(actingGk.slot, 0, 'Acting keeper stays pinned to GK slot 0');
  const onPitch = s.players.filter((p) => p.team === 0 && p.onPitch === 1);
  assert.equal(onPitch.length, 7);
  const slotsUsed = new Set(onPitch.map((p) => p.slot));
  assert.equal(slotsUsed.size, 7);
  for (const sl of slotsUsed) assert.ok(sl >= 0 && sl < 11);
  const cbRolesFilled = onPitch.filter((p) => config.tactics.formations['5-4-1'].slots[p.slot].role === 'CB').length;
  assert.ok(cbRolesFilled >= 2, 'Short-handed bias preserves central defenders');

  // Generalized computeOptimalSlotAssignments accepts raw InputPlayer[] (18 -> 11 auto-pick)
  const rawMap = computeOptimalSlotAssignments(homeSquad.players, config.tactics.formations['3-5-2'].slots, config.roles);
  const assignedSlots = [...rawMap.values()].filter((v) => v >= 0);
  assert.equal(assignedSlots.length, 11);
  assert.equal(new Set(assignedSlots).size, 11);
});

test('Serialize/restore round-trip, planTicks batch invariance, MatchResult.rating/planUsage, and inspectPitch', () => {
  const runToFullTime = (/** @type {MatchEngine} */ eng) => {
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
  };

  // 1. tacticalPlans === null omits activePlan/planTicks completely
  const plain = MatchEngine.create(makeInput(), config);
  plain.step(40);
  const plainSer = plain.state.serialize();
  assert.equal('activePlan' in plainSer.teams[0], false);
  assert.equal('planTicks' in plainSer.teams[0], false);
  runToFullTime(plain);
  const plainResult = plain.getResult();
  assert.equal(typeof plainResult.players[0].rating, 'number');
  assert.equal(plainResult.planUsage, undefined);

  // 2. tacticalPlans present: batch invariance + serialize/restore + inspectPitch + MatchResult.planUsage
  const plannedInput = makeInput({
    tacticalPlans: makePlans({ planA: { tacticId: 'balanced', formationId: '4-3-3', instructions: {}, formFam: 60, instrFam: 50 } }),
  });
  const e1 = MatchEngine.create(plannedInput, config);
  const e2 = MatchEngine.create(plannedInput, config);
  for (let i = 0; i < 100; i++) e1.step(1);
  e2.step(100);
  assert.equal(e1.state.hash(), e2.state.hash());
  assert.deepEqual(e1.state.teams[0].planTicks, e2.state.teams[0].planTicks);
  assert.equal(e1.state.teams[0].planTicks?.A, 100);

  const ser = e1.state.serialize();
  assert.deepEqual(ser.teams[0].planTicks, { A: 100, B: 0, modA: 0, modB: 0 });
  const restored = MatchEngine.fromState(ser, plannedInput, config);
  assert.equal(restored.state.hash(), e1.state.hash());
  assert.deepEqual(restored.state.teams[0].knobs, e1.state.teams[0].knobs);

  const pitch = inspectPitch(e1.state);
  assert.equal(pitch.teams[0].activePlan, 'A');
  assert.equal(pitch.teams[0].baseFormationId, '4-3-3');
  assert.equal(pitch.teams[0].familiarity?.effective, 56);
  assert.equal(pitch.teams[1].familiarity, null);

  runToFullTime(e1);
  const res = e1.getResult();
  assert.ok(res.planUsage?.home);
  assert.ok(res.planUsage.home.A.minutes >= 90);
  assert.equal(res.planUsage.away, undefined);
});

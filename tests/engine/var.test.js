// @ts-nocheck -- scene-building helpers over engine internals; the engine code they exercise is fully type-checked.
// VAR (docs/designs/var.md): config, zero regression without VAR, the three overturn types (goal disallowed,
// penalty awarded, red card upgraded) and the calls that stand, with their two-beat events, ruling, added time
// and asymmetric morale swings; play held through a review (the half cannot end mid-review); offside tracking;
// and determinism across replay and save / restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MatchEngine, FLAG_VAR_REVIEW, SNAP_LEN } from '../../src/engine/MatchEngine.js';
import { HALF_TICKS } from '../../src/engine/TickConfig.js';
import { VAR_OUTCOMES, varBanner, varOnFoul, varTrackPass } from '../../src/engine/officiating/VarSystem.js';
import { startFoulRestart } from '../../src/engine/restarts/RestartMachine.js';
import { shoutReactions } from '../../src/engine/tactics/Shouts.js';
import { DEFAULT_PERSONAL_MORALE } from '../../src/engine/morale/Morale.js';
import { GOLDEN_PATH, config, runMatch, sampleInput } from './helpers.js';

const V = config.var;
const NO_CHECK = { checkP: 0, overturnP: 0 };

/**
 * The compiled config with VAR patched: every check off unless `patch` turns one on.
 * @param {Record<string, any>} patch
 */
function varConfig(patch = {}) {
  const base = {
    ...V,
    goalCheck: { ...V.goalCheck, tight: NO_CHECK, routine: NO_CHECK },
    penaltyCheck: { given: NO_CHECK, missed: { checkP: 0, awardP: 0 } },
    redCardCheck: { ...V.redCardCheck, checkP: 0 },
  };
  const merged = { ...base };
  for (const [k, v] of Object.entries(patch)) merged[k] = typeof v === 'object' && !Array.isArray(v) ? { ...base[k], ...v } : v;
  return { ...config, var: merged };
}

/** A VAR match (both sides human-controlled, so the AI coach never changes anything). */
function varInput(seed) {
  return { ...sampleInput(seed), var: true };
}

/**
 * Steps `engine` one tick at a time until `pred(event)` holds for an event of the tick (or the match ends).
 * Calls `before(engine)` before each tick. Returns the matching event and the tick's events.
 */
function stepUntil(engine, pred, { maxTicks = 120000, before = () => {} } = {}) {
  for (let i = 0; i < maxTicks; i++) {
    before(engine);
    const r = engine.step(1);
    const hit = r.events.find(pred);
    if (hit) return { hit, events: r.events };
    if (r.stoppedFor === 'FULL_TIME') return { hit: null, events: [] };
    if (r.stoppedFor === 'HALF_TIME') continue;
    if (r.stoppedFor === 'FORCED_DECISION') {
      // An injury or a sent-off keeper: resolved as the golden runner does, and play goes on.
      for (let t = 0; t < 2; t++) {
        if (engine.state.teams[t].forcedDecision) engine.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: t, payload: { inIndex: null, outIndex: null } });
      }
    }
  }
  return { hit: null, events: [] };
}

/** Snapshot of the morale shifts VAR moves. */
function moraleOf(s, individual) {
  return { team: [s.teams[0].moraleShift, s.teams[1].moraleShift], personal: s.players[individual].personalShift };
}

/** Runs a VAR match on `cfg` until its first VAR_DECISION; returns everything around it. */
/** A seed whose VAR match scores (in the first half). */
const GOAL_SEED = 2;

function firstDecision(cfg, seed = 1) {
  const engine = MatchEngine.create(varInput(seed), cfg, { debug: false });
  const check = stepUntil(engine, (e) => e.type === 'VAR_CHECK');
  assert.ok(check.hit, 'a VAR check happened');
  const s = engine.state;
  const subject = check.hit.actorIndex;
  const review = { ...s.var.review };
  // Just before the decision tick: the state it acts on.
  let pre = null;
  const decision = stepUntil(engine, (e) => e.type === 'VAR_DECISION', {
    before: (en) => {
      if (en.state.tick + 1 === review.decideTick) {
        pre = {
          score: [en.state.teams[0].score, en.state.teams[1].score],
          addedSeconds: en.state.clock.addedSeconds,
          morale: moraleOf(en.state, subject),
          restart: { ...en.state.restart },
          yellows: [...en.state.stats.yellowCards],
          goals: [...en.state.stats.playerGoals],
          ratingPoints: en.state.players[subject].ratingPoints,
        };
      }
    },
  });
  assert.ok(decision.hit, 'the check was decided');
  return { engine, s, check: check.hit, review, pre, decision: decision.hit, events: decision.events, subject };
}

test('config: VAR is on, a 60-120 s review, eight outcomes with asymmetric overturn swings', () => {
  assert.equal(V.enabled, true);
  assert.ok(V.reviewTicks > 0 && V.checkDelayTicks >= 0);
  assert.deepEqual([V.addedSeconds.min, V.addedSeconds.max], [60, 120]);
  assert.deepEqual(Object.keys(V.morale).sort(), [...VAR_OUTCOMES].sort());
  for (const outcome of ['goalDisallowed', 'penaltyAwarded', 'penaltyOverturned', 'redCardUpgraded']) {
    const m = V.morale[outcome];
    assert.ok(m.benefiting > 0 && m.penalized < 0, `${outcome}: one side gains, the other loses`);
    assert.ok(-m.penalized > m.benefiting, `${outcome}: the side that loses the decision loses more than the other gains`);
  }
  assert.ok(V.morale.goalDisallowed.individual < 0, 'the scorer of a disallowed goal is hit');
  assert.ok(V.morale.penaltyAwarded.individual < 0, 'the fouler of a VAR penalty is hit');
});

test('zero regression: without var: true there is no VAR state, nothing serialized and the golden file is untouched', () => {
  const engine = MatchEngine.create(sampleInput(1), config);
  assert.equal(engine.state.var, null);
  assert.ok(!('var' in engine.serialize()));
  engine.step(20000);
  assert.ok(!engine.eventLog.some((e) => e.type === 'VAR_CHECK' || e.type === 'VAR_DECISION'));
  assert.ok(!('var' in engine.serialize()));
  // var: true with VAR switched off in the config is the same as no VAR.
  const off = MatchEngine.create(varInput(1), { ...config, var: { ...V, enabled: false } });
  assert.equal(off.state.var, null);
  // A match with VAR switched off hashes exactly like a match without it.
  const halfHash = (input, cfg) => {
    const e = MatchEngine.create(input, cfg);
    e.step(30000);
    return e.hash();
  };
  assert.equal(halfHash(varInput(3), { ...config, var: { ...V, enabled: false } }), halfHash(sampleInput(3), config));
  // And a VAR-free match matches the golden stream (tests/engine/determinism.test.js checks every seed).
  assert.equal(typeof runMatch, 'function');
  // tests/golden/seeds.json has no uncommitted changes.
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--stat', '--', GOLDEN_PATH], { encoding: 'utf8' });
  } catch {
    diff = ''; // not a git checkout: the golden determinism test still guards the file's contents
  }
  assert.equal(diff.trim(), '', 'tests/golden/seeds.json is unchanged');
  assert.ok(readFileSync(GOLDEN_PATH, 'utf8').length > 0);
});

test('match input: var must be a boolean', () => {
  assert.throws(() => MatchEngine.create({ ...sampleInput(1), var: 'yes' }, config), /var must be a boolean/);
});

test('goalDisallowed: two beats, score reverted, free kick to the defence, goal off the stats, added time, morale', () => {
  const cfg = varConfig({ goalCheck: { tight: { checkP: 1, overturnP: 1 }, routine: { checkP: 1, overturnP: 1 } } });
  const { engine, s, check, review, pre, decision, events, subject } = firstDecision(cfg, GOAL_SEED);
  const scoring = check.teamIndex;
  assert.equal(check.meta.incident, 'GOAL');
  // The goal stood until the decision; VAR_CHECK came checkDelayTicks after the goal.
  const goal = engine.eventLog.filter((e) => e.type === 'GOAL' && e.tick <= check.tick).at(-1);
  assert.equal(goal.actorIndex, subject);
  assert.equal(check.tick, goal.tick + cfg.var.checkDelayTicks);
  assert.equal(decision.tick, check.tick + cfg.var.reviewTicks);
  assert.equal(pre.score[scoring], s.teams[scoring].score + 1, 'the goal is taken back');
  assert.equal(decision.meta.outcome, 'goalDisallowed');
  assert.equal(decision.meta.overturned, true);
  // Free kick to the defending side.
  assert.equal(s.restart.state, 'DEAD_BALL');
  assert.equal(s.restart.kind, 'FREE_KICK');
  assert.equal(s.restart.teamIndex, 1 - scoring);
  // Stats: the scorer's goal is gone, and so is the team counter's.
  assert.equal(s.stats.playerGoals[subject], pre.goals[subject] - 1);
  assert.equal(engine.getStats()[scoring === 0 ? 'home' : 'away'].goals, s.teams[scoring].score);
  // Added time from the review.
  assert.ok(decision.meta.addedSeconds >= 60 && decision.meta.addedSeconds <= 120);
  assert.ok(s.clock.addedSeconds >= pre.addedSeconds + decision.meta.addedSeconds);
  // Morale: the defending side up, the scoring side down more, the scorer hit hardest.
  const m = cfg.var.morale.goalDisallowed;
  const after = moraleOf(s, subject);
  assert.ok(Math.abs(after.team[1 - scoring] - pre.morale.team[1 - scoring] - m.benefiting) < 0.1);
  assert.ok(Math.abs(after.team[scoring] - pre.morale.team[scoring] - m.penalized) < 0.1);
  assert.ok(Math.abs(after.personal - pre.morale.personal - m.individual) < 0.1);
  // Rating: the goal's points come back off.
  assert.ok(s.players[subject].ratingPoints < pre.ratingPoints);
  // The reacting players: the defending side positive, the scoring side negative.
  const reactions = shoutReactions(decision);
  assert.ok(reactions.length > 0);
  for (const r of reactions) assert.equal(s.players[r.actor].team === 1 - scoring ? 'positive' : 'negative', r.outcome);
  assert.ok(events.includes(decision));
  assert.equal(review.incident, 'GOAL');
});

test('goalConfirmed: the call stands, no reactions, the score is kept, and the kick-off follows', () => {
  const cfg = varConfig({ goalCheck: { tight: { checkP: 1, overturnP: 0 }, routine: { checkP: 1, overturnP: 0 } } });
  const { s, check, pre, decision } = firstDecision(cfg, GOAL_SEED);
  assert.equal(decision.meta.outcome, 'goalConfirmed');
  assert.equal(decision.meta.overturned, false);
  assert.deepEqual(decision.secondaryIndices, []);
  assert.deepEqual([s.teams[0].score, s.teams[1].score], pre.score);
  assert.equal(pre.restart.kind, 'KICK_OFF');
  assert.equal(s.restart.kind, 'KICK_OFF');
  assert.equal(s.restart.teamIndex, 1 - check.teamIndex);
});

test('penaltyAwarded: play is stopped for a box challenge, then a penalty with its event, added time and morale', () => {
  const cfg = varConfig({ penaltyCheck: { missed: { checkP: 1, awardP: 1 } } });
  const { s, check, pre, decision, events, subject } = firstDecision(cfg);
  const defending = check.teamIndex;
  assert.equal(check.meta.incident, 'POSSIBLE_PENALTY');
  assert.equal(pre.restart.state, 'DEAD_BALL', 'play was stopped for the check');
  assert.equal(decision.meta.outcome, 'penaltyAwarded');
  // The PENALTY_AWARDED follows the decision on the same tick, against the tackler.
  const pen = events.find((e) => e.type === 'PENALTY_AWARDED');
  assert.ok(pen && pen.seq > decision.seq);
  assert.equal(pen.actorIndex, subject);
  assert.equal(s.restart.kind, 'PENALTY');
  assert.equal(s.restart.teamIndex, 1 - defending);
  assert.ok(decision.meta.addedSeconds >= 60 && decision.meta.addedSeconds <= 120);
  // Morale: the attack up, the defence down more; the fouler takes VAR's swing and the conceded penalty.
  const m = cfg.var.morale.penaltyAwarded;
  const pm = s.k.weights.morale.personal ?? DEFAULT_PERSONAL_MORALE;
  const after = moraleOf(s, subject);
  assert.ok(Math.abs(after.team[1 - defending] - pre.morale.team[1 - defending] - m.benefiting) < 0.1);
  assert.ok(Math.abs(after.team[defending] - pre.morale.team[defending] - m.penalized) < 0.1);
  assert.ok(Math.abs(after.personal - pre.morale.personal - (m.individual + pm.penaltyConceded)) < 0.1);
  const reactions = shoutReactions(decision);
  for (const r of reactions) assert.equal(s.players[r.actor].team === 1 - defending ? 'positive' : 'negative', r.outcome);
});

test('noPenalty: the check clears the challenge and the drop ball stands', () => {
  const cfg = varConfig({ penaltyCheck: { missed: { checkP: 1, awardP: 0 } } });
  const { s, decision, events } = firstDecision(cfg);
  assert.equal(decision.meta.outcome, 'noPenalty');
  assert.ok(!events.some((e) => e.type === 'PENALTY_AWARDED'));
  assert.equal(s.restart.kind, 'DROP_BALL');
});

test('penaltyOverturned / penaltyConfirmed: a penalty given on the field is checked, then cancelled or kept', () => {
  for (const overturnP of [1, 0]) {
    const cfg = varConfig({ penaltyCheck: { given: { checkP: 1, overturnP } } });
    const engine = MatchEngine.create(varInput(1), cfg);
    engine.step(400);
    const s = engine.state;
    // A home centre-back fouls the away striker in the home box (home defends x = 0 in the first half).
    const fouler = s.players.findIndex((p) => p.team === 0 && p.onPitch === 1 && p.cold.role === 'CB');
    const fouled = s.players.findIndex((p) => p.team === 1 && p.onPitch === 1 && p.cold.role === 'ST');
    startFoulRestart(s, 1, 8, 30, true, fouler, fouled);
    varOnFoul(s, fouler, fouled, 0, 0.2, true, 8, 30);
    assert.equal(s.var.review.incident, 'PENALTY');
    const personal = s.players[fouler].personalShift;
    const { hit: decision } = stepUntil(engine, (e) => e.type === 'VAR_DECISION');
    if (overturnP === 1) {
      assert.equal(decision.meta.outcome, 'penaltyOverturned');
      assert.equal(s.restart.kind, 'DROP_BALL');
      assert.equal(s.restart.teamIndex, 0, 'the defending side restarts');
      assert.ok(s.players[fouler].personalShift > personal, 'relief for the fouler');
      assert.ok(shoutReactions(decision).every((r) => (s.players[r.actor].team === 0) === (r.outcome === 'positive')));
    } else {
      assert.equal(decision.meta.outcome, 'penaltyConfirmed');
      assert.equal(s.restart.kind, 'PENALTY');
      assert.equal(s.restart.teamIndex, 1);
      assert.deepEqual(decision.secondaryIndices, []);
    }
  }
});

test('redCardUpgraded: the yellow becomes a straight red, the player leaves, the yellow comes off the stats', () => {
  const cfg = varConfig({ redCardCheck: { minSeverity: 0, checkP: 1, upgradeP: 1 } });
  const { s, check, pre, decision, events, subject } = firstDecision(cfg);
  const booked = check.teamIndex;
  assert.equal(check.meta.incident, 'RED_CARD');
  assert.equal(decision.meta.outcome, 'redCardUpgraded');
  const red = events.find((e) => e.type === 'RED_CARD');
  assert.ok(red && red.seq > decision.seq, 'the red card follows the decision');
  assert.equal(red.actorIndex, subject);
  assert.equal(s.players[subject].card, 2);
  assert.equal(s.players[subject].onPitch, 0);
  assert.equal(s.stats.yellowCards[booked], pre.yellows[booked] - 1, 'the yellow is rescinded');
  // Morale: VAR's swing on top of the red card's own (Morale.onRedCard).
  const m = cfg.var.morale.redCardUpgraded;
  const ev = s.k.weights.morale.events;
  const after = moraleOf(s, subject);
  assert.ok(Math.abs(after.team[1 - booked] - pre.morale.team[1 - booked] - (m.benefiting + ev.redCardOpponent)) < 0.1);
  assert.ok(Math.abs(after.team[booked] - pre.morale.team[booked] - (m.penalized - ev.redCardOwn)) < 0.1);
  assert.ok(after.personal < pre.morale.personal);
});

test('yellowStands: the booking is confirmed and the player stays on', () => {
  const cfg = varConfig({ redCardCheck: { minSeverity: 0, checkP: 1, upgradeP: 0 } });
  const { s, decision, events, subject } = firstDecision(cfg);
  assert.equal(decision.meta.outcome, 'yellowStands');
  assert.ok(!events.some((e) => e.type === 'RED_CARD'));
  assert.equal(s.players[subject].card, 1);
  assert.equal(s.players[subject].onPitch, 1);
});

test('a review holds play: the restart waits, the snapshot flags it, and the half cannot end mid-review', () => {
  const cfg = varConfig({ goalCheck: { tight: { checkP: 1, overturnP: 0 }, routine: { checkP: 1, overturnP: 0 } } });
  const engine = MatchEngine.create(varInput(GOAL_SEED), cfg);
  const { hit } = stepUntil(engine, (e) => e.type === 'VAR_CHECK');
  const s = engine.state;
  const snap = new Float64Array(SNAP_LEN);
  assert.ok(engine.getSnapshot(snap)[5] & FLAG_VAR_REVIEW);
  // Time is up for the half while the review runs: it does not end until the decision.
  s.clock.announced = true;
  s.clock.addedTicks = 0;
  s.clock.halfTick = HALF_TICKS + 5;
  let ended = false;
  while (s.var.review !== null) {
    const r = engine.step(1);
    assert.equal(s.restart.state, 'DEAD_BALL', 'play stays dead during the review (and on the decision tick)');
    if (r.stoppedFor === 'HALF_TIME' || r.stoppedFor === 'FULL_TIME') ended = true;
  }
  // Play resumes only resumeTicks after the decision.
  assert.ok(s.restart.resumeTick >= s.tick + cfg.var.resumeTicks);
  assert.equal(ended, false);
  assert.ok(!(engine.getSnapshot(snap)[5] & FLAG_VAR_REVIEW));
  // The decision added time onto the half, so it plays on.
  assert.ok(s.clock.addedTicks >= 60 * 20);
  assert.ok(hit);
});

test('offside tracking keeps the tightest onside pass of the move', () => {
  const engine = MatchEngine.create(varInput(1), config);
  const s = engine.state;
  const r = s.players[9];
  varTrackPass(s, 0, r, 70, 70.8);
  assert.equal(s.var.move.margin.toFixed(1), '0.8');
  varTrackPass(s, 0, r, 70, 70.2); // tighter: kept
  assert.equal(s.var.move.margin.toFixed(1), '0.2');
  varTrackPass(s, 0, r, 70, 72); // looser, same move: ignored
  assert.equal(s.var.move.margin.toFixed(1), '0.2');
  varTrackPass(s, 0, r, 40, 40.1); // own half: no offside possible
  assert.equal(s.var.move.margin.toFixed(1), '0.2');
  varTrackPass(s, 1, s.players[27], 80, 81); // the other side's move replaces it
  assert.equal(s.var.move.team, 1);
});

test('HUD banner strings: VAR CHECK, then the overturn headline or CHECK COMPLETE', () => {
  assert.deepEqual(varBanner({ type: 'VAR_CHECK', meta: { incident: 'GOAL' } }), { headline: 'check', detail: 'checkGoal', tone: 'check' });
  assert.deepEqual(varBanner({ type: 'VAR_DECISION', meta: { outcome: 'goalDisallowed', overturned: true } }), { headline: 'goalDisallowed', detail: 'overturned', tone: 'overturned' });
  assert.deepEqual(varBanner({ type: 'VAR_DECISION', meta: { outcome: 'yellowStands', overturned: false } }), { headline: 'checkComplete', detail: 'yellowStands', tone: 'stands' });
  assert.equal(varBanner({ type: 'GOAL', meta: {} }), null);
});

test('determinism: a VAR match replays identically, and save / restore mid-review carries on bit-identically', () => {
  const cfg = varConfig({ goalCheck: { tight: { checkP: 1, overturnP: 0.5 }, routine: { checkP: 1, overturnP: 0.5 } }, penaltyCheck: { missed: { checkP: 0.2, awardP: 0.5 } } });
  const a = MatchEngine.create(varInput(4), cfg);
  stepUntil(a, (e) => e.type === 'VAR_CHECK');
  assert.ok(a.state.var.review !== null);
  const saved = JSON.parse(JSON.stringify(a.serialize()));
  assert.ok(saved.var.review.checked);
  const b = MatchEngine.fromState(saved, varInput(4), cfg);
  assert.equal(b.hash(), a.hash());
  for (let i = 0; i < 6000; i++) {
    a.step(1);
    b.step(1);
  }
  assert.equal(b.hash(), a.hash());
  const { engine } = MatchEngine.replay(varInput(4), cfg, [], a.tick);
  assert.equal(engine.hash(), a.hash());
});

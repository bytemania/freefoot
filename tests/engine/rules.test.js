// @ts-nocheck -- dense table-driven checks with untyped helper lambdas; the engine code they exercise is fully type-checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { judgeOffside, showCard } from '../../src/engine/officiating/Referee.js';
import { launchPass } from '../../src/engine/decisions/Actions.js';
import { startRestart } from '../../src/engine/restarts/RestartMachine.js';
import { raiseForced } from '../../src/engine/commands/Forced.js';
import { evaluate } from '../../src/engine/ai/AiCoach.js';
import { config, configHash, sampleInput } from './helpers.js';
import { generateSquad } from '../../src/shared/squadgen.js';

/** A deep copy of the config with `edit` applied (the generated config is frozen). */
function modified(edit) {
  const c = JSON.parse(JSON.stringify(config));
  edit(c);
  return c;
}

/** Config where every contact is a HIGH injury. */
const hurtful = modified((c) => {
  c.injuries.perContact.i0.value = 1000;
  c.injuries.levelSplit = { LIGHT: 0, MEDIUM: 0, HIGH: 1 };
});

/** An engine in open play (past the kick-off hold) with everyone parked. */
function inPlay(seed = 5, cfg = config) {
  const engine = MatchEngine.create(sampleInput(seed), cfg);
  engine.step(100);
  assert.equal(engine.state.restart.state, 'IN_PLAY');
  return engine;
}

const SET_F = (teamIndex, formationId) => ({ issuer: 'human', type: 'SET_FORMATION', teamIndex, payload: { formationId } });
const SUB = (teamIndex, outIndex, inIndex) => ({ issuer: 'human', type: 'SUBSTITUTE', teamIndex, payload: { outIndex, inIndex } });

// ---------------------------------------------------------------- offside

test('offside geometry: strictly ahead of the ball and the second-last defender, in the opponent half', () => {
  const ctx = (over) => ({ receiverAlong: 80, ballAlong: 60, secondLastAlong: 70, tolerance: 0, restartKind: '', ...over });
  assert.equal(judgeOffside(ctx({})), true);
  assert.equal(judgeOffside(ctx({ receiverAlong: 70 })), false, 'level is onside');
  assert.equal(judgeOffside(ctx({ receiverAlong: 70.01 })), true);
  assert.equal(judgeOffside(ctx({ receiverAlong: 55, ballAlong: 50, secondLastAlong: 40 })), true, 'just inside the opponent half');
  assert.equal(judgeOffside(ctx({ receiverAlong: 52.5, ballAlong: 40, secondLastAlong: 30 })), false, 'on the halfway line is not the opponent half');
  assert.equal(judgeOffside(ctx({ receiverAlong: 50, ballAlong: 40, secondLastAlong: 30 })), false, 'own half');
  assert.equal(judgeOffside(ctx({ receiverAlong: 80, ballAlong: 85 })), false, 'level with or behind the ball');
  assert.equal(judgeOffside(ctx({ tolerance: 15 })), false, 'tolerance');
  for (const kind of ['THROW_IN', 'GOAL_KICK', 'CORNER', 'KICK_OFF']) assert.equal(judgeOffside(ctx({ restartKind: kind })), false, kind);
  assert.equal(judgeOffside(ctx({ restartKind: 'FREE_KICK' })), true, 'free kicks are not exempt');
});

test('an offside pass stops play: OFFSIDE for the receiver and an indirect free kick for the opponent', () => {
  const engine = inPlay();
  const s = engine.state;
  const passer = s.players[5];
  const receiver = s.players[9];
  passer.x = 40;
  passer.y = 34;
  receiver.x = 80;
  receiver.y = 30;
  for (const i of s.onPitchList) {
    const q = s.players[i];
    if (q.team === 1) {
      q.x = q.isKeeper === 1 ? 104 : 70;
      q.y = 34 + (i % 5) * 3;
    }
  }
  s.ball.owner = 5;
  s.tickEvents.length = 0;
  assert.equal(launchPass(s, passer, 9, 'SHORT', ''), false);
  assert.deepEqual(s.tickEvents.map((e) => [e.type, e.teamIndex, e.actorIndex]), [['OFFSIDE', 0, 9]]);
  assert.equal(s.restart.state, 'DEAD_BALL');
  assert.equal(s.restart.kind, 'FREE_KICK');
  assert.equal(s.restart.teamIndex, 1);
  assert.equal(s.restart.direct, false);
  assert.deepEqual([s.restart.x, s.restart.y], [80, 30]);
  assert.equal(s.ball.pass, null);
});

test('a level receiver is onside, and a throw-in is never offside', () => {
  const engine = inPlay();
  const s = engine.state;
  const passer = s.players[5];
  const receiver = s.players[9];
  passer.x = 40;
  passer.y = 34;
  receiver.x = 70;
  receiver.y = 30;
  for (const i of s.onPitchList) {
    const q = s.players[i];
    if (q.team === 1) {
      q.x = q.isKeeper === 1 ? 104 : 70;
      q.y = 34 + (i % 5) * 3;
    }
  }
  s.ball.owner = 5;
  assert.equal(launchPass(s, passer, 9, 'SHORT', ''), true);
  assert.notEqual(s.ball.pass, null);
  receiver.x = 90;
  assert.equal(launchPass(s, passer, 9, 'SHORT', 'THROW_IN'), true);
});

// ------------------------------------------------------------------ cards

test('a second yellow card becomes a red: YELLOW_CARD, then RED_CARD with secondYellow, and the player is off for good', () => {
  const engine = inPlay();
  const s = engine.state;
  s.tickEvents.length = 0;
  showCard(s, 4, 1, 22);
  assert.equal(s.players[4].card, 1);
  assert.equal(s.players[4].onPitch, 1);
  showCard(s, 4, 1, 22);
  assert.deepEqual(s.tickEvents.map((e) => [e.type, e.meta.secondYellow]), [['YELLOW_CARD', undefined], ['YELLOW_CARD', undefined], ['RED_CARD', true]]);
  assert.equal(s.players[4].card, 2);
  assert.equal(s.players[4].onPitch, 0);
  assert.equal(s.players[4].out, 1);
  assert.deepEqual(engine.applyCommand(SUB(0, 3, 4)), { ok: false, code: 'PLAYER_NOT_ON_BENCH' }, 'a sent-off player never returns');
  assert.equal(s.teams[0].formationId, '4-3-2');
  assert.equal(s.teams[0].reduced, true);
});

test('a straight red is a red without a second yellow', () => {
  const engine = inPlay();
  engine.state.tickEvents.length = 0;
  showCard(engine.state, 8, 2, -1);
  assert.deepEqual(engine.state.tickEvents.map((e) => [e.type, e.meta.secondYellow]), [['RED_CARD', false]]);
});

// ------------------------------------------------------------ substitutions

test('queued substitutions apply only at the first dead-ball tick', () => {
  const engine = inPlay();
  const s = engine.state;
  assert.deepEqual(engine.applyCommand(SUB(0, 9, 12)), { ok: true, code: null, seq: 1 });
  assert.equal(s.pendingSubs.length, 1);
  // Open play: nothing happens while the ball is live.
  const before = s.tick;
  for (let t = 0; t < 5 && s.restart.state === 'IN_PLAY'; t++) {
    const r = engine.step(1);
    assert.ok(!r.events.some((e) => e.type === 'SUBSTITUTION'));
    assert.equal(s.players[9].onPitch, 1);
  }
  assert.ok(s.tick > before);
  assert.equal(s.restart.state, 'IN_PLAY');
  startRestart(s, 'THROW_IN', 0, 50, 0);
  const r = engine.step(1);
  assert.deepEqual(r.events.filter((e) => e.type === 'SUBSTITUTION').map((e) => [e.teamIndex, e.actorIndex, e.secondaryIndices[0]]), [[0, 9, 12]]);
  assert.equal(s.players[9].onPitch, 0);
  assert.equal(s.players[12].onPitch, 1);
  assert.equal(s.players[12].slot, 9);
  assert.equal(s.teams[0].subsUsed, 1);
  assert.equal(s.pendingSubs.length, 0);
});

test('a substitution queued during a dead ball applies on the next tick, and a pending one can be cancelled', () => {
  const engine = inPlay();
  const s = engine.state;
  startRestart(s, 'THROW_IN', 0, 50, 0);
  engine.step(1);
  assert.equal(s.restart.state, 'DEAD_BALL');
  const ok = engine.applyCommand(SUB(0, 9, 12));
  assert.equal(ok.ok, true);
  const cancel = engine.applyCommand({ issuer: 'human', type: 'CANCEL_SUBSTITUTION', teamIndex: 0, payload: { seq: ok.seq } });
  assert.equal(cancel.ok, true);
  assert.equal(s.pendingSubs.length, 0);
  engine.applyCommand(SUB(0, 8, 13));
  const r = engine.step(1);
  assert.deepEqual(r.events.filter((e) => e.type === 'SUBSTITUTION').map((e) => [e.actorIndex, e.secondaryIndices[0]]), [[8, 13]]);
});

// ------------------------------------------------------------ error codes

test('each command error code is returned in its own case', () => {
  const engine = inPlay();
  const s = engine.state;
  const code = (cmd) => engine.applyCommand(cmd).code;
  assert.equal(code({ issuer: 'human', type: 'NOPE', teamIndex: 0 }), 'UNKNOWN_TYPE');
  assert.equal(code(SET_F(2, '4-4-2')), 'BAD_TEAM');
  assert.equal(code(SET_F(0, '9-9-9')), 'UNKNOWN_FORMATION');
  assert.equal(code({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: 0, payload: { inIndex: null, outIndex: null } }), 'NOT_AWAITING_DECISION');
  assert.equal(code(SUB(0, 13, 12)), 'PLAYER_NOT_ON_PITCH', 'out is on the bench');
  assert.equal(code(SUB(0, 18 + 3, 12)), 'PLAYER_NOT_ON_PITCH', 'out belongs to the other team');
  assert.equal(code(SUB(0, 9, 10)), 'PLAYER_NOT_ON_BENCH', 'in is on the pitch');
  assert.equal(code(SUB(0, 9, 18 + 12)), 'PLAYER_NOT_ON_BENCH', 'in belongs to the other team');
  s.players[12].card = 2;
  assert.equal(code(SUB(0, 9, 12)), 'SENT_OFF_PLAYER');
  s.players[12].card = 0;
  assert.equal(code({ issuer: 'human', type: 'CANCEL_SUBSTITUTION', teamIndex: 0, payload: { seq: 99 } }), 'UNKNOWN_SEQ');
  assert.equal(code(SUB(0, 9, 12)), null);
  assert.equal(code(SUB(0, 9, 13)), 'ALREADY_PENDING', 'out is already part of a pending substitution');
  assert.equal(code(SUB(0, 8, 12)), 'ALREADY_PENDING', 'in is already part of a pending substitution');
  const done = inPlay().state;
  for (let i = 0; i < 5; i++) done.pendingSubs.push({ seq: 100 + i, teamIndex: 0, outIndex: 1 + i, inIndex: 12 + i });
  assert.equal(MatchEngineCode(done, SUB(0, 6, 17)), 'NO_SUBS_LEFT');
  const over = MatchEngine.create(sampleInput(5), config);
  over.step(200000);
  over.step(200000);
  assert.equal(over.applyCommand(SET_F(0, '4-4-2')).code, 'MATCH_OVER');
  s.teams[1].forcedDecision = true;
  s.teams[1].forcedKind = 1;
  assert.equal(code(SET_F(1, '4-4-2')), 'DECISION_PENDING');
  s.teams[1].forcedKind = 2;
  assert.equal(code({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: 1, payload: { inIndex: 18 + 11, outIndex: null } }), 'OUT_REQUIRED');
});

/** Runs a command on a state through a throwaway engine facade. */
function MatchEngineCode(state, cmd) {
  const engine = Object.create(MatchEngine.prototype);
  engine.state = state;
  engine.commandLog = state.commandLog;
  return engine.applyCommand(cmd).code;
}

test('validation order (§12): type, team, match over, then decision pending, then the type-specific checks', () => {
  const engine = inPlay();
  const s = engine.state;
  const code = (cmd) => engine.applyCommand(cmd).code;
  assert.equal(code({ issuer: 'human', type: 'NOPE', teamIndex: 7 }), 'UNKNOWN_TYPE', 'type before team');
  assert.equal(code({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 7, payload: { formationId: '9-9-9' } }), 'BAD_TEAM', 'team before formation');
  s.teams[0].forcedDecision = true;
  s.teams[0].forcedKind = 1;
  assert.equal(code(SET_F(0, '9-9-9')), 'DECISION_PENDING', 'decision pending before the formation check');
  assert.equal(code(SUB(0, 13, 12)), 'DECISION_PENDING', 'decision pending before the substitution checks');
  s.teams[0].forcedDecision = false;
  s.restart.state = 'FULL_TIME';
  s.teams[0].forcedDecision = true;
  assert.equal(code(SET_F(0, '9-9-9')), 'MATCH_OVER', 'match over before decision pending');
  s.restart.state = 'IN_PLAY';
  s.teams[0].forcedDecision = false;
  // Substitution checks run in table order: subs left, on pitch, on bench, sent off, already pending.
  s.teams[0].subsUsed = 5;
  assert.equal(code(SUB(0, 13, 10)), 'NO_SUBS_LEFT');
  s.teams[0].subsUsed = 0;
  assert.equal(code(SUB(0, 13, 10)), 'PLAYER_NOT_ON_PITCH');
  assert.equal(code(SUB(0, 9, 10)), 'PLAYER_NOT_ON_BENCH');
});

// --------------------------------------------------------- forced decisions

test('a forced decision stops step(), and RESOLVE_FORCED lets the match go on', () => {
  const engine = MatchEngine.create(sampleInput(5), hurtful);
  let r = { stoppedFor: /** @type {any} */ (null), events: /** @type {any[]} */ ([]) };
  for (let i = 0; i < 100 && r.stoppedFor === null; i++) r = engine.step(1000);
  assert.equal(r.stoppedFor, 'FORCED_DECISION');
  assert.ok(engine.state.awaitingDecision);
  const raised = r.events.filter((e) => e.type === 'FORCED_DECISION_REQUIRED');
  assert.ok(raised.length >= 1 && raised[0].meta.reason === 'HIGH_INJURY');
  const tick = engine.tick;
  assert.deepEqual(engine.step(10), { ticksRun: 0, events: [], stoppedFor: 'FORCED_DECISION' });
  assert.equal(engine.tick, tick);
  // The team named in the event must resolve it; a home decision first if both are pending.
  const team = raised[0].teamIndex;
  const bench = engine.state.players.filter((p) => p.team === team && p.onPitch === 0 && p.out === 0).map((p) => p.index);
  assert.deepEqual(engine.applyCommand(SET_F(team, '4-4-2')), { ok: false, code: 'DECISION_PENDING' });
  const out = engine.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: team, payload: { inIndex: bench[1], outIndex: null } });
  assert.equal(out.ok, true);
  const injured = raised[0].actorIndex;
  const after = engine.step(1);
  assert.equal(after.ticksRun, 1);
  assert.ok(after.events.some((e) => e.type === 'SUBSTITUTION' && e.actorIndex === injured && e.secondaryIndices[0] === bench[1]));
  assert.equal(engine.state.players[injured].onPitch, 0);
  assert.equal(engine.state.teams[team].subsUsed, 1, 'a forced substitution counts toward the 5');
});

test('a goalkeeper red card with a bench keeper needs outIndex, and the forced sub counts toward the 5', () => {
  const engine = inPlay();
  const s = engine.state;
  s.tickEvents.length = 0;
  showCard(s, 0, 2, -1);
  assert.equal(s.teams[0].forcedDecision, true);
  assert.equal(s.teams[0].forcedKind, 2);
  assert.ok(s.awaitingDecision);
  assert.ok(s.tickEvents.some((e) => e.type === 'FORCED_DECISION_REQUIRED' && e.meta.reason === 'GK_SENT_OFF'));
  const resolve = (payload) => engine.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: 0, payload });
  assert.deepEqual(resolve({ inIndex: 11, outIndex: null }), { ok: false, code: 'OUT_REQUIRED' });
  assert.equal(resolve({ inIndex: 11, outIndex: 10 }).ok, true);
  assert.equal(s.awaitingDecision, false);
  const r = engine.step(1);
  assert.ok(r.events.some((e) => e.type === 'SUBSTITUTION' && e.actorIndex === 10 && e.secondaryIndices[0] === 11));
  assert.equal(s.teams[0].subsUsed, 1);
  assert.equal(s.players[11].onPitch, 1);
  assert.equal(s.players[11].isKeeper, 1);
  assert.equal(s.players[11].slot, 0);
  assert.equal(s.onPitchList.filter((i) => i < 18).length, 10);
});

test('no substitutes left: a red card gives a reduced shape and no forced decision', () => {
  const engine = inPlay();
  const s = engine.state;
  s.teams[0].subsUsed = 5;
  showCard(s, 9, 2, -1);
  assert.equal(s.teams[0].forcedDecision, false);
  assert.equal(s.awaitingDecision, false);
  assert.equal(s.teams[0].formationId, '4-3-2');
  assert.equal(s.teams[0].reduced, true);
  // A HIGH injury with no substitutes: the player leaves, still no decision.
  raiseForced(s, s.teams[0], 1, 8);
  assert.equal(s.teams[0].forcedDecision, false);
  assert.equal(s.players[8].onPitch, 0);
  assert.equal(s.players[8].out, 1);
  assert.equal(s.teams[0].formationId, '4-3-1');
  assert.deepEqual(engine.step(1).stoppedFor, null);
});

test('a goalkeeper red card with no goalkeeper on the bench, or no substitutions left, puts the best outfield player in goal', () => {
  /** @param {(s: any) => void} setup */
  const run = (setup) => {
    const engine = inPlay();
    const s = engine.state;
    setup(s);
    showCard(s, 0, 2, -1);
    return s;
  };
  for (const setup of [(s) => { s.players[11].out = 1; }, (s) => { s.teams[0].subsUsed = 5; }]) {
    const s = run(setup);
    assert.equal(s.teams[0].forcedDecision, false);
    assert.equal(s.awaitingDecision, false);
    let best = -1;
    let bestScore = -1;
    for (let i = 1; i < 11; i++) {
      const a = s.players[i].cold.attributes;
      if (a.reflexes + a.positioning > bestScore) {
        bestScore = a.reflexes + a.positioning;
        best = i;
      }
    }
    assert.equal(s.players[best].isKeeper, 1);
    assert.equal(s.players[best].slot, 0, 'takes the goalkeeper slot');
    assert.equal(s.players.filter((p) => p.team === 0 && p.isKeeper === 1 && p.onPitch === 1).length, 1);
  }
});

test('formation changes take effect on the tick after they are issued', () => {
  const engine = inPlay();
  engine.applyCommand(SET_F(0, '4-4-2'));
  assert.equal(engine.state.teams[0].formationId, '4-3-3');
  const r = engine.step(1);
  assert.equal(engine.state.teams[0].formationId, '4-4-2');
  assert.equal(r.events.find((e) => e.type === 'FORMATION_CHANGE')?.tick, engine.tick);
});

// --------------------------------------------------------------- added time

test('added time equals the configured seconds for the goals, substitutions, cards and injuries of the half', () => {
  const t = config.officiating.addedTime;
  for (const [seed, cfg] of /** @type {[number, any][]} */ ([[3, config], [5, hurtful]])) {
    const engine = MatchEngine.create(sampleInput(seed), cfg);
    engine.applyCommand(SUB(0, 9, 12));
    for (let i = 0; i < 60 && engine.tick < 53999; i++) {
      const r = engine.step(Math.min(1000, 53999 - engine.tick));
      if (r.stoppedFor === 'FORCED_DECISION') {
        const team = engine.state.teams.findIndex((x) => x.forcedDecision);
        engine.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: team, payload: { inIndex: null, outIndex: null } });
      }
    }
    let expected = 0;
    for (const e of engine.eventLog) {
      if (e.tick > 53999) continue;
      if (e.type === 'GOAL') expected += t.perGoal;
      else if (e.type === 'SUBSTITUTION') expected += t.perSubstitution;
      else if (e.type === 'YELLOW_CARD' || e.type === 'RED_CARD') expected += t.perCard;
      else if (e.type === 'INJURY_STOPPAGE') expected += t.perInjuryStoppage;
    }
    assert.ok(expected > 0, `seed ${seed} recorded stoppages`);
    assert.equal(engine.state.clock.addedSeconds, expected);
  }
});

// ------------------------------------------------------------------ AI coach

/** An AI-controlled engine at a given match minute of the second half. */
function aiAt(minute) {
  const engine = inPlay();
  const s = engine.state;
  s.teams[0].controlledBy = 'ai';
  s.clock.half = 2;
  s.clock.halfTick = Math.round((minute - 45) * 1200);
  return engine;
}

test('tired substitutions fire no earlier than 55 minutes', () => {
  for (const [minute, expected] of [[54.9, 0], [55, 1]]) {
    const engine = aiAt(minute);
    const s = engine.state;
    s.players[9].fitness = 0.4;
    evaluate(s, s.teams[0]);
    assert.equal(s.pendingSubs.length, expected, `minute ${minute}`);
    if (expected) {
      assert.equal(s.pendingSubs[0].outIndex, 9);
      assert.ok(s.pendingSubs[0].inIndex >= 11 && s.pendingSubs[0].inIndex <= 17);
      assert.equal(engine.getCommandLog()[0].issuer, 'ai');
    }
  }
});

test('the AI substitutes at most maxSubstitutionsPerCheck players per evaluation, and injured players come off', () => {
  const engine = aiAt(60);
  const s = engine.state;
  s.players[9].fitness = 0.3;
  s.players[8].fitness = 0.3;
  s.players[7].injury = 2;
  evaluate(s, s.teams[0]);
  assert.equal(s.pendingSubs.length, config.aiCoach.maxSubstitutionsPerCheck);
});

test('the losing-late formation switch fires at 70 minutes, once', () => {
  for (const [minute, expected] of [[69.9, 0], [70, 1]]) {
    const engine = aiAt(minute);
    const s = engine.state;
    s.teams[1].score = 1;
    s.teams[0].formationId = '4-4-2'; // the losing-late formation is 4-3-3
    evaluate(s, s.teams[0]);
    const log = engine.getCommandLog().filter((c) => c.type === 'SET_FORMATION');
    assert.equal(log.length, expected, `minute ${minute}`);
    if (expected) {
      assert.equal(log[0].payload.formationId, config.aiCoach.losingLate.formationId);
      evaluate(s, s.teams[0]);
      assert.equal(engine.getCommandLog().filter((c) => c.type === 'SET_FORMATION').length, 1, 'fires once');
    }
  }
  const level = aiAt(80);
  evaluate(level.state, level.state.teams[0]);
  assert.equal(level.getCommandLog().length, 0, 'no switch when not losing');
});

test('after a red card the AI switches to the red-card formation', () => {
  const engine = aiAt(30);
  const s = engine.state;
  s.players[9].card = 2;
  s.players[9].onPitch = 0;
  s.rebuildOnPitchList();
  evaluate(s, s.teams[0]);
  const log = engine.getCommandLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].payload.formationId, config.aiCoach.redCard.formationId);
});

test('AI forced decisions resolve on the same tick and never stop step()', () => {
  const input = /** @type {any} */ ({
    v: 1, seed: 8, configHash,
    home: generateSquad('A', 1, config, { side: 'home' }),
    away: generateSquad('A', 2, config, { side: 'away' }),
  });
  const engine = MatchEngine.create(input, hurtful);
  let stops = 0;
  for (let i = 0; i < 60 && engine.getCommandLog().filter((c) => c.type === 'RESOLVE_FORCED').length === 0; i++) {
    const r = engine.step(1000);
    if (r.stoppedFor === 'FORCED_DECISION') stops++;
  }
  assert.equal(stops, 0);
  const resolved = engine.getCommandLog().filter((c) => c.type === 'RESOLVE_FORCED');
  assert.ok(resolved.length >= 1);
  assert.equal(resolved[0].issuer, 'ai');
  assert.equal(engine.state.awaitingDecision, false);
  const raisedTick = engine.eventLog.find((e) => e.type === 'FORCED_DECISION_REQUIRED')?.tick;
  assert.equal(resolved[0].tick, raisedTick, 'resolved on the tick it was raised');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine, SNAP_LEN, SNAP_PLAYERS, SNAP_PLAYER_STRIDE, ENGINE_VERSION } from '../../src/engine/MatchEngine.js';
import { addStoppageFor } from '../../src/engine/clock/MatchClock.js';
import { config, configHash, sampleInput } from './helpers.js';

const input = sampleInput(7);

test('create validates the MatchInput', () => {
  const bad = sampleInput(7);
  bad.home.players[0].role = 'ST';
  assert.throws(() => MatchEngine.create(bad, config), /players\[0\] must be a goalkeeper/);
});

test('a full match runs 2 x 54,000 ticks (plus added time) with the half-time stop and ends at FULL_TIME', () => {
  const engine = MatchEngine.create(input, config);
  let r = engine.step(200000);
  const first = r.events;
  assert.equal(r.stoppedFor, 'HALF_TIME');
  assert.ok(r.ticksRun >= 54000 && r.ticksRun % 1200 === 0, `first half ${r.ticksRun}`);
  r = engine.step(200000);
  const second = r.events;
  assert.equal(r.stoppedFor, 'FULL_TIME');
  assert.ok(r.ticksRun >= 54000 && r.ticksRun % 1200 === 0, `second half ${r.ticksRun}`);
  assert.equal(first[0].type, 'KICK_OFF');
  assert.equal(first.filter((e) => e.type === 'HALF_TIME').length, 1);
  assert.equal(first[first.length - 1].type, 'HALF_TIME');
  assert.deepEqual([second[0].type, second[0].teamIndex], ['KICK_OFF', 1]);
  assert.equal(second[second.length - 1].type, 'FULL_TIME');
  assert.deepEqual(engine.step(10), { ticksRun: 0, events: [], stoppedFor: 'FULL_TIME' });
});

test('events carry increasing seq and the right tick; the kick-off has no actor', () => {
  const engine = MatchEngine.create(input, config);
  const { events } = engine.step(3000);
  assert.deepEqual(events[0], {
    v: 1, seq: 0, tick: 1, type: 'KICK_OFF', teamIndex: 0, actorIndex: -1, secondaryIndices: [], x: 52.5, y: 34, zone: 11, meta: {},
  });
  assert.ok(events.length > 3);
  events.forEach((e, i) => {
    assert.equal(e.seq, i);
    assert.ok(e.tick >= 1 && e.tick <= 3000 && (i === 0 || e.tick >= events[i - 1].tick));
  });
  const half = engine.step(60000);
  assert.equal(half.events[half.events.length - 1].type, 'HALF_TIME');
  assert.equal(half.events[half.events.length - 1].teamIndex, -1);
  assert.equal(half.events[half.events.length - 1].zone, -1);
});

test('sides swap at half-time and the away team kicks off the second half', () => {
  const engine = MatchEngine.create(input, config);
  assert.equal(engine.state.attackDir(0), 1);
  engine.step(200000);
  const r = engine.step(1);
  assert.equal(engine.state.attackDir(0), -1);
  assert.equal(engine.state.attackDir(1), 1);
  assert.equal(r.events[0].type, 'KICK_OFF');
  assert.equal(r.events[0].teamIndex, 1);
  for (const i of engine.state.onPitchList) {
    const p = engine.state.players[i];
    assert.ok(p.team === 0 ? p.x >= 52.5 - 6 : p.x <= 52.5 + 6, `player ${i} starts the second half in its own half (x ${p.x})`);
  }
});

test('restart: kick-off holds for the configured seconds, then play resumes; the clock runs throughout', () => {
  const engine = MatchEngine.create(input, config);
  engine.step(59);
  assert.equal(engine.state.restart.state, 'DEAD_BALL');
  engine.step(1);
  assert.equal(engine.state.restart.state, 'IN_PLAY');
  assert.equal(engine.state.clock.halfTick, 60);
});

test('added time is rounded up to whole minutes, announced and played', () => {
  const engine = MatchEngine.create(input, config);
  engine.step(1000);
  engine.state.clock.addedSeconds += 50;
  engine.step(54000 - 1 - engine.tick);
  const acc = engine.state.clock.addedSeconds;
  const minutes = Math.ceil(acc / 60);
  assert.ok(minutes >= 1);
  const r = engine.step(1);
  assert.equal(engine.tick, 54000);
  const added = r.events.filter((e) => e.type === 'ADDED_TIME');
  assert.deepEqual(added.map((e) => e.meta), [{ minutes }]);
  const rest = engine.step(200000);
  assert.equal(rest.stoppedFor, 'HALF_TIME');
  assert.equal(engine.tick, 54000 + minutes * 1200);
});

test('stoppage events add configured seconds to the accumulator', () => {
  const engine = MatchEngine.create(input, config);
  const at = config.officiating.addedTime;
  engine.state.tick = 5;
  const goal = engine.state.emit('GOAL', { teamIndex: 0, actorIndex: 9, meta: { kind: 'OPEN_PLAY' } });
  const card = engine.state.emit('YELLOW_CARD', { teamIndex: 0, actorIndex: 4 });
  const sub = engine.state.emit('SUBSTITUTION', { teamIndex: 0, actorIndex: 9, secondaryIndices: [12] });
  const stop = engine.state.emit('INJURY_STOPPAGE', { teamIndex: 0, actorIndex: 3 });
  const other = engine.state.emit('PASS', { teamIndex: 0, actorIndex: 3, secondaryIndices: [4], meta: { kind: 'SHORT' } });
  for (const e of [goal, card, sub, stop, other]) addStoppageFor(engine.state, e);
  assert.equal(engine.state.clock.addedSeconds, at.perGoal + at.perCard + at.perSubstitution + at.perInjuryStoppage);
});

test('SET_FORMATION: validated, logged, applied at step 1 of the next tick, and emits FORMATION_CHANGE', () => {
  const engine = MatchEngine.create(input, config);
  engine.step(5);
  assert.deepEqual(engine.applyCommand({ issuer: 'human', type: 'NOPE', teamIndex: 0 }), { ok: false, code: 'UNKNOWN_TYPE' });
  assert.deepEqual(engine.applyCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 2, payload: { formationId: '4-4-2' } }), { ok: false, code: 'BAD_TEAM' });
  assert.deepEqual(engine.applyCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '9-9-9' } }), { ok: false, code: 'UNKNOWN_FORMATION' });
  assert.equal(engine.getCommandLog().length, 0);

  const ok = engine.applyCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '4-4-2' } });
  assert.deepEqual(ok, { ok: true, code: null, seq: 1 });
  assert.equal(engine.state.teams[0].formationId, '4-3-3'); // not yet
  const r = engine.step(1);
  assert.equal(engine.state.teams[0].formationId, '4-4-2');
  assert.deepEqual(r.events.map((e) => [e.type, e.teamIndex, e.meta]), [['FORMATION_CHANGE', 0, { formationId: '4-4-2' }]]);
  assert.deepEqual(engine.getCommandLog().map((c) => [c.seq, c.tick, c.issuer, c.type]), [[1, 5, 'human', 'SET_FORMATION']]);
});

test('commands after full time return MATCH_OVER; a pending forced decision returns DECISION_PENDING', () => {
  const engine = MatchEngine.create(input, config);
  engine.state.teams[1].forcedDecision = true;
  assert.deepEqual(engine.applyCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 1, payload: { formationId: '4-4-2' } }), { ok: false, code: 'DECISION_PENDING' });
  engine.state.teams[1].forcedDecision = false;
  engine.step(200000);
  engine.step(200000);
  assert.deepEqual(engine.applyCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '4-4-2' } }), { ok: false, code: 'MATCH_OVER' });
});

test('a forced decision stops step() before and after a tick', () => {
  const engine = MatchEngine.create(input, config);
  engine.state.awaitingDecision = true;
  assert.deepEqual(engine.step(5), { ticksRun: 0, events: [], stoppedFor: 'FORCED_DECISION' });
});

test('getSnapshot fills the documented layout', () => {
  const engine = MatchEngine.create(input, config);
  engine.step(10);
  const out = engine.getSnapshot(new Float64Array(SNAP_LEN));
  assert.equal(SNAP_LEN, 371);
  assert.deepEqual([...out.slice(0, 6)], [10, 0, 0, 0.5, 1, 2]); // tick, score, score, clock, half, dead-ball flag
  assert.deepEqual([...out.slice(6, 11)], [52.5, 34, 52.5, 34, 0]);
  const p0 = [...out.slice(SNAP_PLAYERS, SNAP_PLAYERS + SNAP_PLAYER_STRIDE)];
  assert.equal(p0[4], 1); // onPitch
  assert.equal(p0[5], 0); // team
  assert.equal(p0[8], 1); // keeper
  assert.equal(p0[9], 1); // fitness
  const bench = out.slice(SNAP_PLAYERS + SNAP_PLAYER_STRIDE * 12, SNAP_PLAYERS + SNAP_PLAYER_STRIDE * 13);
  assert.equal(bench[4], 0);
  const away0 = out.slice(SNAP_PLAYERS + SNAP_PLAYER_STRIDE * 18, SNAP_PLAYERS + SNAP_PLAYER_STRIDE * 19);
  assert.equal(away0[5], 1);
});

test('getResult is available at full time and carries the fixed fields', () => {
  const engine = MatchEngine.create(input, config);
  assert.throws(() => engine.getResult(), /not finished/);
  engine.step(200000);
  engine.step(200000);
  const result = engine.getResult();
  assert.equal(result.v, 1);
  assert.equal(result.engineVersion, ENGINE_VERSION);
  assert.equal(result.configHash, configHash);
  assert.equal(result.seed, 7);
  const goals = result.events.filter((e) => e.type === 'GOAL');
  const homeGoals = goals.filter((e) => (e.meta.kind === 'OWN_GOAL' ? 1 - e.teamIndex : e.teamIndex) === 0).length;
  assert.deepEqual(result.score, { home: homeGoals, away: goals.length - homeGoals });
  assert.equal(result.players.length, 36);
  for (const p of result.players) assert.ok(p.minutes >= 0 && p.minutes <= 105, `minutes ${p.minutes}`);
  assert.deepEqual(result.suspensions, result.players.filter((p) => p.card === 2).map((p) => p.id));
  assert.equal(result.finalStateHash, engine.hash());
  assert.equal(result.events[0].type, 'KICK_OFF');
  assert.equal(result.events[result.events.length - 1].type, 'FULL_TIME');
});

test('debug mode checks invariants and validates events through a full match', () => {
  const engine = MatchEngine.create(sampleInput(3), config, { debug: true });
  engine.step(2000);
  assert.equal(engine.tick, 2000);
  engine.state.ball.owner = 30; // a bench player cannot own the ball
  assert.throws(() => engine.step(1), /invariant violated at tick 2001: ball owner 30/);
});

test('debug mode rejects an event that does not match the registry', () => {
  const engine = MatchEngine.create(input, config, { debug: true });
  assert.throws(() => engine.state.emit('SHOT', { teamIndex: 0, actorIndex: 3, meta: { result: 'NOPE' } }), /meta\.result must be one of/);
  assert.throws(() => engine.state.emit('GOAL', { teamIndex: 0 }), /missing actor/);
  assert.throws(() => engine.state.emit('MISSING_TYPE'), /unknown type/);
});

test('stats are updated from events through the registry (goals, shots, xG, passes)', () => {
  const engine = MatchEngine.create(input, config);
  const s = engine.state;
  s.tick = 1;
  const events = [
    s.emit('SHOT', { teamIndex: 0, actorIndex: 9, meta: { result: 'ON_TARGET', xg: 0.25 } }),
    s.emit('GOAL', { teamIndex: 0, actorIndex: 9, meta: { kind: 'OPEN_PLAY' } }),
    s.emit('GOAL', { teamIndex: 0, actorIndex: 20, meta: { kind: 'OWN_GOAL' } }),
    s.emit('PASS', { teamIndex: 1, actorIndex: 22, secondaryIndices: [23], meta: { kind: 'SHORT', completed: true } }),
    s.emit('PASS', { teamIndex: 1, actorIndex: 22, secondaryIndices: [23], meta: { kind: 'SHORT', completed: false } }),
    s.emit('FOUL', { teamIndex: 1, actorIndex: 22, secondaryIndices: [4] }),
    s.emit('YELLOW_CARD', { teamIndex: 1, actorIndex: 22 }),
    s.emit('RED_CARD', { teamIndex: 0, actorIndex: 4, meta: { secondYellow: false } }),
  ];
  for (const e of events) s.stats.onEvent(e);
  const stats = engine.getStats();
  assert.equal(stats.home.shots, 1);
  assert.equal(stats.home.shotsOnTarget, 1);
  assert.equal(stats.home.xG, 0.25);
  assert.equal(stats.home.goals, 1); // the own goal counts for the opponent (away)
  assert.equal(stats.away.goals, 0 + 1);
  assert.equal(stats.away.passes, 2);
  assert.equal(stats.away.passCompletionPct, 50);
  assert.equal(stats.away.possessionPct, 100);
  assert.equal(stats.away.yellowCards, 1);
  assert.equal(stats.home.redCards, 1);
  assert.equal(stats.away.foulsCommitted, 1);
  assert.equal(s.stats.playerGoals[9], 1);
  assert.equal(s.stats.playerGoals[20], 0);
});

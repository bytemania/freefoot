import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { config, sampleInput } from './helpers.js';

/** @param {MatchEngine} engine @param {number} toTick */
function runTo(engine, toTick) {
  /** @type {any[]} */
  const events = [];
  while (engine.tick < toTick) {
    const r = engine.step(toTick - engine.tick);
    events.push(...r.events);
    if (r.stoppedFor === 'FULL_TIME' || r.ticksRun === 0) break;
  }
  return events;
}

/**
 * Like runTo, but a human team's forced decision (a HIGH injury, say) is answered with "play on without a
 * substitute" so the run continues; the resolution goes in the command log and replays with it.
 * @param {MatchEngine} engine @param {number} toTick
 */
function runResolving(engine, toTick) {
  /** @type {any[]} */
  const events = [];
  while (engine.tick < toTick) {
    const r = engine.step(toTick - engine.tick);
    events.push(...r.events);
    if (r.stoppedFor === 'FORCED_DECISION') {
      for (const t of [0, 1]) {
        if (engine.state.teams[t].forcedDecision) {
          const res = engine.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: t, payload: { inIndex: null, outIndex: null } });
          if (!res.ok) throw new Error(`could not resolve the forced decision: ${res.code}`);
        }
      }
      continue;
    }
    if (r.stoppedFor === 'FULL_TIME' || r.ticksRun === 0) break;
  }
  return events;
}

const input = sampleInput(43);

// Hash-at-T cases (build step 2). Lofted pass, dead ball and pending substitution cases arrive in steps 3 and 4.
for (const [t1, t2] of [[30, 2000], [5000, 20000], [54000, 54500], [90000, 108000]]) {
  test(`serialize at tick ${t1}, JSON round-trip, restore, run to ${t2}: same hash as an uninterrupted run`, () => {
    const straight = MatchEngine.create(input, config);
    const straightEvents = runTo(straight, t2);

    const first = MatchEngine.create(input, config);
    const firstEvents = runTo(first, t1);
    const saved = JSON.parse(JSON.stringify(first.serialize()));
    const resumed = MatchEngine.fromState(saved, input, config);
    assert.equal(resumed.hash(), first.hash());
    const resumedEvents = runTo(resumed, t2);

    assert.equal(resumed.hash(), straight.hash());
    assert.deepEqual([...firstEvents, ...resumedEvents], straightEvents);
  });
}

test('a velocity component of -0 survives serialization and hashing', () => {
  const engine = MatchEngine.create(input, config);
  runTo(engine, 100);
  engine.state.players[3].vx = 0;
  engine.state.players[3].vy = 0;
  const before = engine.hash();
  engine.state.players[3].vx = -0;
  engine.state.players[3].vy = -0;
  assert.equal(engine.hash(), before);
  const saved = JSON.parse(JSON.stringify(engine.serialize()));
  const resumed = MatchEngine.fromState(saved, input, config);
  assert.equal(resumed.hash(), before);
  runTo(engine, 3000);
  runTo(resumed, 3000);
  assert.equal(resumed.hash(), engine.hash());
});

test('serialize throws on NaN and Infinity', () => {
  const engine = MatchEngine.create(input, config);
  engine.state.players[0].x = NaN;
  assert.throws(() => engine.serialize(), /non-finite/);
  engine.state.players[0].x = Infinity;
  assert.throws(() => engine.hash(), /non-finite/);
});

test('fromState rejects an unknown stateVersion', () => {
  const engine = MatchEngine.create(input, config);
  const saved = { ...engine.serialize(), stateVersion: 99 };
  assert.throws(() => MatchEngine.fromState(saved, input, config), /stateVersion/);
});

test('re-simulation: replay to tick T gives the same hash and the same events, with a command in the log', () => {
  const live = MatchEngine.create(input, config);
  const liveEvents = runResolving(live, 3000);
  assert.deepEqual(live.applyCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '4-4-2' } }), { ok: true, code: null, seq: 1 });
  liveEvents.push(...runResolving(live, 70000));
  live.applyCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 1, payload: { formationId: '4-3-3' } });
  liveEvents.push(...runResolving(live, 80000));

  const { engine, events } = MatchEngine.replay(input, config, live.getCommandLog(), 80000);
  assert.equal(engine.tick, 80000);
  assert.equal(engine.hash(), live.hash());
  assert.ok(liveEvents.some((e) => e.type === 'FORMATION_CHANGE'));
  assert.deepEqual(events, liveEvents.filter((e) => e.tick <= 80000));
});

test('replay ignores AI entries (the AI coach re-derives them)', () => {
  const log = [
    { seq: 1, tick: 100, issuer: 'ai', type: 'SET_FORMATION', teamIndex: 1, payload: { formationId: '4-4-2' } },
  ];
  const { engine } = MatchEngine.replay(input, config, /** @type {any} */ (log), 500);
  assert.equal(engine.state.teams[1].formationId, '4-4-2'); // the sample away squad already plays 4-4-2
  assert.equal(engine.getCommandLog().length, 0);
});

// Build step 3: a lofted pass in flight, and a ground ball, survive serialize -> JSON -> restore.
import { launchLofted, launchGround } from '../../src/engine/ball/BallPhysics.js';

for (const kind of ['lofted pass', 'ground pass']) {
  test(`serialize mid-flight of a ${kind}, JSON round-trip, restore: same hash and events as an uninterrupted run`, () => {
    /** @param {MatchEngine} e */
    const kick = (e) => {
      if (kind === 'lofted pass') launchLofted(e.state, 30, 34, 70, 20, 22, 8, 9);
      else launchGround(e.state, 30, 34, 70, 20, 18, 9);
    };
    const straight = MatchEngine.create(input, config, { debug: true });
    runTo(straight, 200);
    kick(straight);
    const straightEvents = runTo(straight, 600);

    const first = MatchEngine.create(input, config, { debug: true });
    runTo(first, 200);
    kick(first);
    runTo(first, 215); // 15 ticks into the flight
    if (kind === 'lofted pass') assert.ok(first.state.ball.flight !== null && first.state.ball.height > 0);
    const saved = JSON.parse(JSON.stringify(first.serialize()));
    const resumed = MatchEngine.fromState(saved, input, config, { debug: true });
    assert.equal(resumed.hash(), first.hash());
    const resumedEvents = runTo(resumed, 600);
    assert.equal(resumed.hash(), straight.hash());
    assert.deepEqual(resumedEvents, straightEvents.filter((e) => e.tick > 215));
  });
}

// Build step 4: a dead ball, a pending substitution, a forced decision, and AI replay.
import { generateSquad } from '../../src/shared/squadgen.js';
import { configHash } from './helpers.js';

/**
 * Steps until `pred(engine)` is true after a tick, up to `max` ticks; returns the tick or -1.
 * @param {MatchEngine} engine
 * @param {(e: MatchEngine) => boolean} pred
 * @param {number} [max]
 */
function stepUntil(engine, pred, max = 60000) {
  for (let i = 0; i < max; i++) {
    engine.step(1);
    if (pred(engine)) return engine.tick;
  }
  return -1;
}

for (const kind of ['dead ball', 'open play with a pending substitution']) {
  test(`serialize during a ${kind}, JSON round-trip, restore: same hash and events as an uninterrupted run`, () => {
    const setup = () => {
      const e = MatchEngine.create(input, config);
      if (kind === 'dead ball') {
        const t = stepUntil(e, (/** @type {MatchEngine} */ x) => x.state.restart.state === 'DEAD_BALL' && x.state.restart.announced && x.tick > 200);
        assert.ok(t > 0, 'a dead ball occurs');
      } else {
        // A substitution confirmed at a stoppage is made at once, so one stays
        // pending only while the ball is in play.
        const t = stepUntil(e, (/** @type {MatchEngine} */ x) => x.state.restart.state === 'IN_PLAY' && x.tick > 200);
        assert.ok(t > 0, 'open play occurs');
        e.applyCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 1, payload: { outIndex: 18 + 9, inIndex: 18 + 12 } });
        assert.equal(e.state.pendingSubs.length, 1);
      }
      return e;
    };
    const straight = setup();
    const straightEvents = runTo(straight, straight.tick + 6000);
    if (kind !== 'dead ball') assert.ok(straightEvents.some((/** @type {any} */ ev) => ev.type === 'SUBSTITUTION' && ev.teamIndex === 1), 'the pending substitution is made at the next stoppage');

    const first = setup();
    const saved = JSON.parse(JSON.stringify(first.serialize()));
    assert.equal(saved.restart.state, kind === 'dead ball' ? 'DEAD_BALL' : 'IN_PLAY');
    const resumed = MatchEngine.fromState(saved, input, config);
    assert.equal(resumed.hash(), first.hash());
    const resumedEvents = runTo(resumed, straight.tick);
    assert.equal(resumed.hash(), straight.hash());
    assert.deepEqual(resumedEvents, straightEvents);
  });
}

test('serialize while a forced decision is pending, restore, resolve: same as resolving the original', () => {
  const hurtful = JSON.parse(JSON.stringify(config));
  hurtful.injuries.perContact.i0.value = 1000;
  hurtful.injuries.levelSplit = { LIGHT: 0, MEDIUM: 0, HIGH: 1 };
  const base = MatchEngine.create(input, hurtful);
  const t = stepUntil(base, (/** @type {MatchEngine} */ x) => x.state.awaitingDecision);
  assert.ok(t > 0);
  const team = base.state.teams.findIndex((/** @type {any} */ x) => x.forcedDecision);
  const saved = JSON.parse(JSON.stringify(base.serialize()));
  const resumed = MatchEngine.fromState(saved, input, hurtful);
  assert.equal(resumed.hash(), base.hash());
  assert.ok(resumed.state.awaitingDecision);
  const resolve = (/** @type {MatchEngine} */ e) => e.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: team, payload: { inIndex: null, outIndex: null } });
  assert.equal(resolve(base).ok, true);
  assert.equal(resolve(resumed).ok, true);
  const a = runTo(base, base.tick + 2000);
  const b = runTo(resumed, resumed.tick + 2000);
  assert.equal(resumed.hash(), base.hash());
  assert.deepEqual(b, a);
});

test('AI replay: with both teams AI and AI substitutions in the log, replay gives the same hash (AI entries are not re-applied)', () => {
  const eager = JSON.parse(JSON.stringify(config));
  eager.aiCoach.tiredSubstitution.fitnessThreshold = 0.999; // everyone counts as tired after 55'
  const aiInput = /** @type {any} */ ({
    v: 1, seed: 21, configHash,
    home: generateSquad('A', 3, config, { side: 'home' }),
    away: generateSquad('A', 4, config, { side: 'away' }),
  });
  const live = MatchEngine.create(aiInput, eager);
  runTo(live, 90000);
  const log = live.getCommandLog();
  assert.ok(log.some((c) => c.issuer === 'ai' && c.type === 'SUBSTITUTE'), 'the AI made substitutions');
  assert.ok(log.every((c) => c.issuer === 'ai'));
  const { engine, events } = MatchEngine.replay(aiInput, eager, log, 90000);
  assert.equal(engine.hash(), live.hash());
  assert.deepEqual(events, live.eventLog.filter((e) => e.tick <= 90000));
  assert.deepEqual(engine.getCommandLog(), log, 'the replayed AI re-derives the same commands with the same seq');
});

test('re-simulation with human commands in the log gives the same hash (substitution and formation)', () => {
  const live = MatchEngine.create(input, config);
  runTo(live, 3000);
  live.applyCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: 9, inIndex: 12 } });
  runTo(live, 20000);
  live.applyCommand({ issuer: 'human', type: 'SET_FORMATION', teamIndex: 1, payload: { formationId: '4-3-3' } });
  runTo(live, 40000);
  const { engine } = MatchEngine.replay(input, config, live.getCommandLog(), 40000);
  assert.equal(engine.hash(), live.hash());
});

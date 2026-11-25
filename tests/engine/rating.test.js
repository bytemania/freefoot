import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine, SNAP_LEN, SNAP_PLAYERS, SNAP_PLAYER_STRIDE } from '../../src/engine/MatchEngine.js';
import { makeEvent } from '../../src/engine/events/MatchEvent.js';
import { RATING_BASE, rateEvents, ratingFromPoints } from '../../src/engine/stats/Rating.js';
import { onPlayerEvents, updateMorale } from '../../src/engine/morale/Morale.js';
import { config, sampleInput } from './helpers.js';

/** A fresh engine in open play. */
function fresh(seed = 1) {
  const engine = MatchEngine.create(sampleInput(seed), config);
  engine.state.restart.state = 'IN_PLAY';
  return engine;
}

/**
 * Builds one tick's events and records them into ratings and individual morale.
 * @param {MatchEngine} engine
 * @param {[string, Parameters<typeof makeEvent>[2]][]} list
 */
function record(engine, list) {
  const s = engine.state;
  const events = list.map(([type, fields]) => makeEvent(s, type, fields));
  rateEvents(s, events);
  onPlayerEvents(s, events);
  return events;
}

test('ratingFromPoints: 6.0 at kick-off, bounded to 0-10, monotonic with diminishing returns', () => {
  assert.equal(ratingFromPoints(0), RATING_BASE);
  let last = -Infinity;
  for (let pts = -40; pts <= 40; pts += 0.5) {
    const r = ratingFromPoints(pts);
    assert.ok(r > 0 && r < 10, `${pts} -> ${r}`);
    assert.ok(r > last, 'monotonic');
    last = r;
  }
  assert.ok(ratingFromPoints(1) - ratingFromPoints(0) > ratingFromPoints(5) - ratingFromPoints(4), 'diminishing returns');
  assert.ok(ratingFromPoints(3) >= 7.9 && ratingFromPoints(3) <= 8.1, 'a goal, an assist and a solid game is about 8');
});

test('every player starts at 6.0; goals, assists, key passes, shots on target, passes, tackles and saves raise it', () => {
  const engine = fresh();
  const s = engine.state;
  for (const p of s.players) assert.equal(p.rating, 6);
  const striker = 9;
  const mid = 6;
  const defender = 2;
  const awayKeeper = 18;
  record(engine, [
    ['PASS', { teamIndex: 0, actorIndex: mid, secondaryIndices: [striker], meta: { kind: 'SHORT', completed: true } }],
    ['KEY_PASS', { teamIndex: 0, actorIndex: mid, secondaryIndices: [striker] }],
    ['SHOT', { teamIndex: 0, actorIndex: striker, meta: { result: 'ON_TARGET' } }],
    ['SAVE', { teamIndex: 1, actorIndex: awayKeeper, meta: { kind: 'HELD' } }],
    ['TACKLE', { teamIndex: 0, actorIndex: defender, secondaryIndices: [27], meta: { won: true } }],
    ['INTERCEPTION', { teamIndex: 0, actorIndex: defender }],
  ]);
  assert.ok(s.players[mid].rating > 6, 'passer');
  assert.ok(s.players[striker].rating > 6, 'shot on target');
  assert.ok(s.players[awayKeeper].rating > 6, 'save');
  assert.ok(s.players[defender].rating > 6, 'tackle + interception');
  const before = s.players[striker].rating;
  record(engine, [
    ['SHOT', { teamIndex: 0, actorIndex: striker, meta: { result: 'ON_TARGET' } }],
    ['GOAL', { teamIndex: 0, actorIndex: striker, meta: { kind: 'OPEN_PLAY' } }],
    ['ASSIST', { teamIndex: 0, actorIndex: mid, secondaryIndices: [striker] }],
  ]);
  assert.ok(s.players[striker].rating - before > 0.7, 'a goal is a big lift');
  assert.ok(s.players[mid].rating > 6.8, 'an assist too');
  // Conceding hurts the keeper most, then the defenders; the opponents' attackers are unaffected.
  assert.ok(s.players[awayKeeper].rating < 6, 'keeper after conceding');
  const awayCb = s.players.find((p) => p.team === 1 && p.onPitch === 1 && p.cold.role === 'CB');
  assert.ok(awayCb && awayCb.rating < 6, 'defender after conceding');
  // Bench players keep 6.0.
  for (let i = 11; i < 18; i++) assert.equal(s.players[i].rating, 6);
});

test('failed passes, turnovers, missed big chances, fouls and cards lower the rating', () => {
  const engine = fresh();
  const s = engine.state;
  const p = 7;
  record(engine, [
    ['PASS', { teamIndex: 0, actorIndex: p, secondaryIndices: [8], meta: { kind: 'SHORT', completed: false } }],
    ['POSSESSION_LOST', { teamIndex: 0, actorIndex: p }],
    ['MISCONTROL', { teamIndex: 0, actorIndex: p }],
  ]);
  assert.ok(s.players[p].rating < 6);
  const r1 = s.players[p].rating;
  record(engine, [
    ['SHOT', { teamIndex: 0, actorIndex: p, meta: { result: 'OFF_TARGET' } }],
    ['BIG_CHANCE', { teamIndex: 0, actorIndex: p, meta: { xg: 0.6 } }],
  ]);
  assert.ok(s.players[p].rating < r1, 'a missed big chance');
  const r2 = s.players[p].rating;
  record(engine, [
    ['FOUL', { teamIndex: 0, actorIndex: p, secondaryIndices: [24] }],
    ['YELLOW_CARD', { teamIndex: 0, actorIndex: p }],
  ]);
  assert.ok(r2 - s.players[p].rating > 0.3, 'a booking');
  record(engine, [['RED_CARD', { teamIndex: 0, actorIndex: p, meta: { secondYellow: true } }]]);
  assert.ok(s.players[p].rating < 4.5, `a red card (${s.players[p].rating.toFixed(2)})`);
  // A big chance that is scored on the same tick is not "missed".
  const q = 9;
  record(engine, [
    ['SHOT', { teamIndex: 0, actorIndex: q, meta: { result: 'ON_TARGET' } }],
    ['BIG_CHANCE', { teamIndex: 0, actorIndex: q, meta: { xg: 0.6 } }],
    ['GOAL', { teamIndex: 0, actorIndex: q, meta: { kind: 'OPEN_PLAY' } }],
  ]);
  assert.ok(s.players[q].rating > 7);
  // An own goal hurts the scorer.
  record(engine, [['GOAL', { teamIndex: 1, actorIndex: 20, meta: { kind: 'OWN_GOAL' } }]]);
  assert.ok(s.players[20].rating < 5.5);
});

test('individual morale moves with the player’s own actions, tempered by composure and determination, and decays', () => {
  const engine = fresh();
  const s = engine.state;
  const scorer = 9;
  const mate = 10;
  const m0 = s.players[scorer].morale;
  const mateM0 = s.players[mate].morale;
  record(engine, [['GOAL', { teamIndex: 0, actorIndex: scorer, meta: { kind: 'OPEN_PLAY' } }]]);
  assert.ok(s.players[scorer].morale > m0, 'scoring lifts the scorer');
  assert.equal(s.players[mate].morale, mateM0, 'a personal event leaves team-mates alone');
  // The conceding keeper and defenders lose individual morale.
  const keeper = s.players[18];
  assert.ok(keeper.personalShift < 0);
  const cb = s.players.find((p) => p.team === 1 && p.onPitch === 1 && p.cold.role === 'CB');
  assert.ok(cb && cb.personalShift < 0 && cb.personalShift > keeper.personalShift, 'defenders less than the keeper');
  // A booking and turnovers lower it.
  const p = s.players[7];
  const before = p.morale;
  record(engine, [
    ['YELLOW_CARD', { teamIndex: 0, actorIndex: 7 }],
    ['POSSESSION_LOST', { teamIndex: 0, actorIndex: 7 }],
  ]);
  assert.ok(p.morale < before);
  // Steady players (high composure + determination) swing less than volatile ones.
  const steady = s.players[3];
  const volatile = s.players[4];
  /** @type {any} */ (steady).cold = { ...steady.cold, attributes: { ...steady.cold.attributes, composure: 20, determination: 20 } };
  /** @type {any} */ (volatile).cold = { ...volatile.cold, attributes: { ...volatile.cold.attributes, composure: 2, determination: 2 } };
  const sm = steady.morale;
  const vm = volatile.morale;
  record(engine, [
    ['GOAL', { teamIndex: 0, actorIndex: 3, meta: { kind: 'OPEN_PLAY' } }],
    ['GOAL', { teamIndex: 0, actorIndex: 4, meta: { kind: 'OPEN_PLAY' } }],
  ]);
  assert.ok(volatile.morale - vm > steady.morale - sm, 'composure / determination temper the swing');
  // The personal shift decays back toward the base over time.
  const shift = s.players[scorer].personalShift;
  for (let t = 0; t < 20 * 600; t++) {
    s.tick++;
    updateMorale(s);
  }
  assert.ok(s.players[scorer].personalShift > 0 && s.players[scorer].personalShift < shift * 0.5, 'decays');
});

test('a full match: every rating stays in 0-10, morale in 0-100, both copied into the RenderSnapshot and kept by save/restore', () => {
  const engine = MatchEngine.create(sampleInput(1), config);
  // Each step stops at half-time (and at a forced decision for the human home side: answer it with no
  // substitution), so play on until the whistle.
  for (let i = 0; i < 10; i++) {
    const r = engine.step(200000);
    if (r.stoppedFor === 'FULL_TIME') break;
    if (r.stoppedFor === 'FORCED_DECISION') {
      for (const t of engine.state.teams) {
        if (t.forcedDecision) engine.applyCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: t.index, payload: {} });
      }
    }
  }
  assert.equal(engine.state.restart.state, 'FULL_TIME', 'the match was played to the end');
  const s = engine.state;
  const played = s.players.filter((p) => p.ticksOnPitch > 0);
  for (const p of s.players) {
    assert.ok(p.rating >= 0 && p.rating <= 10, `rating ${p.rating}`);
    assert.ok(p.morale >= 0 && p.morale <= 100, `morale ${p.morale}`);
  }
  const ratings = played.map((p) => p.rating);
  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  assert.ok(mean > 5.5 && mean < 7.5, `mean rating ${mean.toFixed(2)}`);
  assert.ok(Math.max(...ratings) - Math.min(...ratings) > 0.8, 'ratings separate good and poor games');
  assert.ok(new Set(s.players.map((p) => Math.round(p.morale))).size > 4, 'morale is individual');
  const snap = engine.getSnapshot(new Float64Array(SNAP_LEN));
  for (let i = 0; i < 36; i++) {
    const o = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * i;
    assert.equal(snap[o + 10], s.players[i].rating);
    assert.equal(snap[o + 11], s.players[i].morale);
  }
  const restored = MatchEngine.fromState(JSON.parse(JSON.stringify(engine.serialize())), engine.input, config);
  assert.equal(restored.hash(), engine.hash());
  for (let i = 0; i < 36; i++) {
    assert.equal(restored.state.players[i].rating, s.players[i].rating);
    assert.equal(restored.state.players[i].morale, s.players[i].morale);
  }
});

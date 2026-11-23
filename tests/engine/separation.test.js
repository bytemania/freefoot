// Player body separation (Movement.separatePlayers): unit behaviour, determinism, and a live
// overlap audit over real AI-vs-AI matches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { separatePlayers } from '../../src/engine/movement/Movement.js';
import { ACTION } from '../../src/engine/decisions/Perception.js';
import { PITCH_LENGTH, PITCH_WIDTH } from '../../src/engine/state/MatchState.js';
import { config, sampleInput } from './helpers.js';

const SEEDS = Number(process.env.SEPARATION_SEEDS ?? 12);
const MIN_SEP = config.weights.movement.minPlayerSeparation.value;

/** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Two opposing outfield players, everyone else parked far away; no ball owner. */
function setup() {
  const engine = MatchEngine.create(sampleInput(5, { homeControl: 'ai', awayControl: 'ai' }), config);
  const s = engine.state;
  engine.step(200);
  const outfield = s.onPitchList.filter((i) => s.players[i].isKeeper !== 1);
  const ia = /** @type {number} */ (outfield.find((i) => s.players[i].team === 0));
  const ib = /** @type {number} */ (outfield.find((i) => s.players[i].team === 1));
  const im = /** @type {number} */ (outfield.find((i) => s.players[i].team === 0 && i !== ia));
  const a = s.players[ia];
  const b = s.players[ib];
  const mates = s.players[im];
  // Spread everybody else out so only the pair under test interacts.
  let n = 0;
  for (const i of s.onPitchList) {
    const p = s.players[i];
    if (p === a || p === b) continue;
    p.x = 5 + (n % 11) * 9;
    p.y = n < 11 ? 5 : 60;
    n++;
    p.pendingAction = ACTION.HOLD;
  }
  s.ball.owner = -1;
  a.pendingAction = b.pendingAction = ACTION.HOLD;
  return { s, a, b, mates };
}

test('two converging non-dueling players are pushed apart and stay apart', () => {
  const { s, a, b } = setup();
  a.x = 50;
  a.y = 30;
  b.x = 50.3;
  b.y = 30;
  for (let t = 0; t < 40; t++) {
    // They keep walking into each other every tick.
    a.x += 0.1;
    b.x -= 0.1;
    separatePlayers(s);
  }
  const d = dist(a.x, a.y, b.x, b.y);
  // Pushed against at 2 m/s each, the pair settles a bit under the target; never into overlap.
  assert.ok(d > 0.6, `still ${d.toFixed(2)} m apart`);
  assert.ok(Number.isFinite(a.x) && Number.isFinite(b.x));
});

test('a single pass closes part of an overlap, at most separationMaxStep per player', () => {
  const { s, a, b } = setup();
  const m = config.weights.movement;
  a.x = 50;
  a.y = 30;
  b.x = 50.2;
  b.y = 30;
  separatePlayers(s);
  assert.ok(a.x < 50 && b.x > 50.2, 'pushed in opposite directions');
  assert.ok(50 - a.x <= m.separationMaxStep.value + 1e-9);
  assert.ok(b.x - 50.2 <= m.separationMaxStep.value + 1e-9);
  assert.ok(Math.abs(a.y - 30) < 1e-9 && Math.abs(b.y - 30) < 1e-9);
});

test('players on exactly the same spot split deterministically, without NaN', () => {
  const run = () => {
    const { s, a, b } = setup();
    a.x = b.x = 40;
    a.y = b.y = 25;
    separatePlayers(s);
    return [a.x, a.y, b.x, b.y];
  };
  const r = run();
  assert.ok(r.every(Number.isFinite));
  assert.ok(Math.abs(r[0] - r[2]) > 0, 'separated');
  assert.ok(r[0] < r[2], 'the lower index goes to the left');
  assert.deepEqual(run(), r);
});

test('the result does not depend on which pair is visited first (three-body cluster)', () => {
  const place = (/** @type {any} */ s, /** @type {any[]} */ ps, /** @type {number[][]} */ at) => ps.forEach((p, i) => ([p.x, p.y] = at[i]));
  const { s, a, b, mates } = setup();
  const at = [[50, 30], [50.3, 30.1], [50.1, 29.7]];
  place(s, [a, b, mates], at);
  separatePlayers(s);
  const first = [a, b, mates].map((p) => [p.x, p.y]);
  // Same cluster, the same players assigned to the spots in another order: each ends where
  // its own spot's neighbours push it, so the displacement multiset is identical.
  place(s, [mates, a, b], at);
  separatePlayers(s);
  const second = [mates, a, b].map((p) => [p.x, p.y]);
  assert.deepEqual(second, first);
});

test('players in a duel (tackle on the carrier, two chasers) are exempt; teammates are not', () => {
  const { s, a, b, mates } = setup();
  a.x = 50;
  a.y = 30;
  b.x = 50.4;
  b.y = 30;
  s.ball.owner = a.index;
  b.pendingAction = ACTION.PRESS;
  separatePlayers(s);
  assert.equal(a.x, 50);
  assert.equal(b.x, 50.4);

  s.ball.owner = -1;
  a.pendingAction = ACTION.CHASE;
  b.pendingAction = ACTION.RECEIVE;
  separatePlayers(s);
  assert.equal(a.x, 50);
  assert.equal(b.x, 50.4);

  // Team-mates never duel with each other.
  a.pendingAction = b.pendingAction = ACTION.HOLD;
  mates.x = 50.2;
  mates.y = 30;
  separatePlayers(s);
  assert.ok(mates.x > 50.2 || a.x < 50, 'team-mates are separated even when chasing the same ball');
});

test('positions are clamped to the pitch', () => {
  const { s, a, b } = setup();
  a.x = 0;
  a.y = 0;
  b.x = 0.1;
  b.y = 0;
  separatePlayers(s);
  for (const p of [a, b]) {
    assert.ok(p.x >= 0 && p.x <= PITCH_LENGTH && p.y >= 0 && p.y <= PITCH_WIDTH);
  }
  a.x = PITCH_LENGTH;
  a.y = PITCH_WIDTH;
  b.x = PITCH_LENGTH;
  b.y = PITCH_WIDTH;
  separatePlayers(s);
  for (const p of [a, b]) {
    assert.ok(Number.isFinite(p.x) && p.x <= PITCH_LENGTH && p.y <= PITCH_WIDTH);
  }
});

/**
 * Overlap audit: every tick of N AI-vs-AI matches, count player pairs closer than 0.6 m,
 * ignoring pairs in a duel or at a dead ball (positions there are set by the restart).
 * @param {number} sepOverride minPlayerSeparation to run with (0 turns the pass off)
 */
function audit(sepOverride) {
  let pairTicks = 0;
  let ticks = 0;
  let worst = Infinity;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const cfg = sepOverride === MIN_SEP ? config : { ...config, weights: { ...config.weights, movement: { ...config.weights.movement, minPlayerSeparation: { ...config.weights.movement.minPlayerSeparation, value: sepOverride } } } };
    const engine = MatchEngine.create(sampleInput(seed, { homeControl: 'ai', awayControl: 'ai' }), cfg);
    const s = engine.state;
    while (s.restart.state !== 'FULL_TIME') {
      engine.step(1);
      if (s.tick % 10 !== 0) continue;
      ticks++;
      const list = s.onPitchList;
      for (let n = 0; n < list.length; n++) {
        const a = s.players[list[n]];
        for (let o = n + 1; o < list.length; o++) {
          const b = s.players[list[o]];
          const d = dist(a.x, a.y, b.x, b.y);
          if (d >= 0.6) continue;
          const duel = a.team !== b.team && (s.ball.owner === a.index || s.ball.owner === b.index || ((a.pendingAction === ACTION.CHASE || a.pendingAction === ACTION.RECEIVE) && (b.pendingAction === ACTION.CHASE || b.pendingAction === ACTION.RECEIVE)));
          if (duel) continue;
          pairTicks++;
          if (d < worst) worst = d;
        }
      }
    }
  }
  return { perSample: pairTicks / ticks, worst };
}

test('live audit: overlaps under 0.6 m between non-dueling players all but disappear', () => {
  const off = audit(0);
  const on = audit(MIN_SEP);
  console.log(`# overlap (<0.6 m) pairs per sample, ${SEEDS} matches: without separation ${off.perSample.toFixed(4)}, with ${on.perSample.toFixed(4)} (closest ${on.worst.toFixed(2)} m)`);
  assert.ok(off.perSample > 0.02, `the audit finds overlaps without separation (${off.perSample})`);
  assert.ok(on.perSample <= off.perSample * 0.2, `with separation ${on.perSample} vs ${off.perSample} without`);
  assert.ok(on.perSample < 0.01, `${on.perSample} overlapping pairs per sample`);
});

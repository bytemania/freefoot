import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { computeAnchors, setFormation, reduce } from '../../src/engine/tactics/Formation.js';
import { updateMovement, topSpeed, acceleration } from '../../src/engine/movement/Movement.js';
import { updateFitness } from '../../src/engine/fitness/Fitness.js';
import { roleRating } from '../../src/engine/state/PlayerMatchState.js';
import { config, sampleInput, playScripted } from './helpers.js';

const slots = config.tactics.formations['4-3-3'].slots;

function fresh() {
  const engine = MatchEngine.create(sampleInput(1), config);
  engine.state.restart.state = 'IN_PLAY';
  return engine.state;
}

test('anchors follow the ball by their coefficients (home, attacking phase)', () => {
  const s = fresh();
  s.ball.owner = 9; // home striker owns the ball: attacking anchors
  const st = slots[9];
  for (const [bx, by] of [[52.5, 34], [70, 20], [30, 60]]) {
    s.ball.x = bx;
    s.ball.y = by;
    computeAnchors(s, s.teams[0]);
    const p = s.players[9];
    assert.ok(Math.abs(p.tx - (st.attack[0] * 105 + (bx - 52.5) * st.follow[0])) < 1e-9);
    assert.ok(Math.abs(p.ty - (st.attack[1] * 68 + (by - 34) * st.follow[1])) < 1e-9);
  }
});

test('the away team computes anchors in its own frame, mirrored on the pitch', () => {
  const s = fresh();
  s.ball.owner = 9; // home owns: away defends
  s.ball.x = 70;
  s.ball.y = 20;
  computeAnchors(s, s.teams[1]);
  const awaySlots = config.tactics.formations['4-4-2'].slots;
  const p = s.players[18 + 9]; // away striker
  const f = awaySlots[9];
  // away frame: x' = 105 - x, y' = 68 - y
  const bx = 105 - 70;
  const by = 68 - 20;
  const ax = f.defend[0] * 105 + (bx - 52.5) * f.follow[0];
  const ay = f.defend[1] * 68 + (by - 34) * f.follow[1];
  assert.ok(Math.abs(p.tx - (105 - ax)) < 1e-9);
  assert.ok(Math.abs(p.ty - (68 - ay)) < 1e-9);
});

test('anchors are clamped to the pitch, so nobody passes their own goal line', () => {
  const s = fresh();
  s.ball.owner = 9;
  s.ball.x = 105;
  s.ball.y = 0;
  computeAnchors(s, s.teams[0]);
  assert.equal(s.players[9].tx, 104.5); // 0.86 * 105 + 52.5 * 0.35 would be 108.7
  s.ball.x = 0;
  s.ball.y = 68;
  computeAnchors(s, s.teams[0]);
  for (let i = 0; i < 11; i++) {
    const p = s.players[i];
    assert.ok(p.tx >= 0.5 && p.tx <= 104.5 && p.ty >= 0.5 && p.ty <= 67.5, `player ${i} anchor (${p.tx}, ${p.ty})`);
  }
  assert.equal(s.players[0].tx >= 0.5, true);
});

test('a loose ball blends the shape from defending to attacking, with no jump at halfway', () => {
  const s = fresh();
  s.ball.owner = -1;
  s.ball.y = 34;
  const tx = (/** @type {number} */ x) => {
    s.ball.x = x;
    computeAnchors(s, s.teams[0]);
    return s.players[9].tx;
  };
  assert.ok(Math.abs(tx(52.5) - tx(52.6)) < 0.2);
  assert.ok(tx(80) > tx(20));
});

test('kick-off positions stay in the team\'s own half', () => {
  const engine = MatchEngine.create(sampleInput(1), config);
  const s = engine.state;
  computeAnchors(s, s.teams[0]);
  computeAnchors(s, s.teams[1]);
  for (let i = 0; i < 11; i++) assert.ok(s.players[i].tx <= 51.5);
  for (let i = 18; i < 29; i++) assert.ok(s.players[i].tx >= 53.5);
});

test('players never exceed top speed or the acceleration bound, over a scripted half', () => {
  const engine = MatchEngine.create(sampleInput(5), config);
  const s = engine.state;
  const k = s.k;
  const prev = s.players.map((p) => [p.vx, p.vy]);
  for (let tick = 0; tick < 4000; tick++) {
    if (tick % 150 === 0) {
      // scripted ball movement: bounce the ball between far corners
      s.ball.x = tick % 300 === 0 ? 10 : 95;
      s.ball.y = tick % 300 === 0 ? 10 : 58;
    }
    engine.step(1);
    for (const i of s.onPitchList) {
      const p = s.players[i];
      const speed = Math.hypot(p.vx, p.vy);
      assert.ok(speed <= topSpeed(p, k) + 1e-9, `player ${i} speed ${speed} above top ${topSpeed(p, k)}`);
      const dv = Math.hypot(p.vx - prev[i][0], p.vy - prev[i][1]);
      assert.ok(dv <= acceleration(p, k) * k.dt + 1e-9 || p.vx === 0 || p.vy === 0, `player ${i} dv ${dv}`);
      prev[i] = [p.vx, p.vy];
      assert.ok(p.x >= 0 && p.x <= 105 && p.y >= 0 && p.y <= 68);
    }
  }
});

test('a player accelerates toward a distant target, slows on arrival and stops on it', () => {
  const s = fresh();
  const p = s.players[9];
  p.x = p.prevX = 20;
  p.y = p.prevY = 34;
  p.vx = p.vy = 0;
  p.tx = 30;
  p.ty = 34;
  let maxSpeed = 0;
  const hold = s.k.weights.movement.holdMaxSpeed;
  for (let t = 0; t < 400; t++) {
    p.tx = 30;
    p.ty = 34;
    updateMovement(s, s.k.dt);
    maxSpeed = Math.max(maxSpeed, Math.hypot(p.vx, p.vy));
  }
  assert.ok(maxSpeed <= hold + 1e-9, 'a short hold correction is a jog, not a sprint');
  assert.ok(maxSpeed > 2);
  assert.ok(Math.abs(p.x - 30) < 0.05);
  assert.ok(Math.hypot(p.vx, p.vy) < 0.05);
  assert.ok(p.distance >= 10 - 0.5 && p.distance < 12);
});

test('a far target is a sprint at top speed; each new sprint after a stop is counted once', () => {
  const s = fresh();
  const p = s.players[9];
  p.x = p.prevX = 10;
  p.y = p.prevY = 34;
  p.vx = p.vy = 0;
  p.sprints = 0;
  const top = topSpeed(p, s.k);
  assert.ok(top > s.k.weights.movement.sprintThreshold, 'sample striker can sprint');
  let max = 0;
  for (let t = 0; t < 200; t++) {
    p.tx = 90;
    p.ty = 34;
    updateMovement(s, s.k.dt);
    max = Math.max(max, Math.hypot(p.vx, p.vy));
  }
  assert.ok(Math.abs(max - top) < 1e-6);
  assert.equal(p.sprints, 1);
  // it arrives and stands (well over 1 s below the threshold), then sprints back, then out again
  for (const target of [5, 90]) {
    for (let t = 0; t < 200; t++) {
      p.tx = target;
      p.ty = 34;
      updateMovement(s, s.k.dt);
    }
  }
  assert.equal(p.sprints, 3);
});

test('formation switch optimally assigns slots by role fit; the keeper keeps slot 0; ties go to the lower index', () => {
  const engine = MatchEngine.create(sampleInput(1), config);
  const s = engine.state;
  const team = s.teams[0];
  setFormation(s, team, '4-4-2');
  assert.equal(team.formationId, '4-4-2');
  const bySlot = new Map();
  for (let i = 0; i < 18; i++) if (s.players[i].onPitch === 1) bySlot.set(s.players[i].slot, i);
  assert.equal(bySlot.size, 11);
  assert.equal(bySlot.get(0), 0);

  // Verify global optimality: no 2-player swap increases total fit score
  const slots442 = config.tactics.formations['4-4-2'].slots;
  const fitScore = (/** @type {any} */ p, /** @type {number} */ sl) => {
    const sr = slots442[sl].role;
    return roleRating(p, config.roles, sr) + (p.cold.role === sr ? 3 : 0);
  };
  for (let a = 1; a < 11; a++) {
    for (let b = a + 1; b < 11; b++) {
      const pA = s.players[/** @type {number} */ (bySlot.get(a))];
      const pB = s.players[/** @type {number} */ (bySlot.get(b))];
      const cur = fitScore(pA, a) + fitScore(pB, b);
      const swapped = fitScore(pA, b) + fitScore(pB, a);
      assert.ok(cur + 1e-9 >= swapped, `slot swap (${a},${b}) improved score ${cur} -> ${swapped}`);
    }
  }
  // ties: identical outfield attributes give the lowest indices in slot order
  for (let i = 1; i < 11; i++) {
    for (const a of Object.keys(s.players[i].cold.attributes)) {
      s.players[i].cold = { ...s.players[i].cold, role: 'MF', attributes: { ...s.players[i].cold.attributes, [a]: 12 } };
    }
  }
  setFormation(s, team, '4-3-3');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => s.players[i].slot), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('reduce picks the reduced variant for ten and nine men, and the emergency shape otherwise', () => {
  const engine = MatchEngine.create(sampleInput(1), config);
  const s = engine.state;
  const team = s.teams[0];
  s.players[9].onPitch = 0;
  s.players[9].card = 2;
  s.rebuildOnPitchList();
  reduce(s, team);
  assert.equal(team.formationId, '4-3-2');
  assert.equal(team.reduced, true);
  assert.equal(s.players[8].slot >= 0, true);
  assert.equal(s.players[9].slot, -1);
  s.players[10].onPitch = 0;
  s.rebuildOnPitchList();
  reduce(s, team);
  assert.equal(team.formationId, '4-3-1');
  const full = MatchEngine.create(sampleInput(1), config).state;
  reduce(full, full.teams[0]);
  assert.equal(full.teams[0].formationId, '4-3-3');
  assert.equal(full.teams[0].reduced, false);
});

test('fitness: sprinting drains more than jogging, standing recovers, dead balls recover, values clamp to 0-1', () => {
  const s = fresh();
  const [a, b, c] = [s.players[5], s.players[6], s.players[7]];
  for (const p of [a, b, c]) p.fitness = 0.8;
  a.vx = 8; // sprint
  b.vx = 3; // jog
  c.vx = 0; // walk (standing)
  updateFitness(s);
  assert.ok(a.fitness < b.fitness && b.fitness < 0.8);
  assert.ok(c.fitness > 0.8, 'standing recovers net of the walking cost');
  s.restart.state = 'DEAD_BALL';
  a.fitness = 0.5;
  updateFitness(s);
  assert.equal(a.fitness, 0.5 + s.k.weights.fitness.rec);
  a.fitness = 1;
  updateFitness(s);
  assert.equal(a.fitness, 1);
  s.restart.state = 'IN_PLAY';
  a.fitness = 0;
  a.vx = 8;
  updateFitness(s);
  assert.equal(a.fitness, 0);
});

test('fitness drain is scaled by stamina and work rate', () => {
  const s = fresh();
  const [a, b] = [s.players[5], s.players[6]];
  a.cold = { ...a.cold, attributes: { ...a.cold.attributes, stamina: 20, workRate: 10 } };
  b.cold = { ...b.cold, attributes: { ...b.cold.attributes, stamina: 5, workRate: 10 } };
  a.vx = b.vx = 8;
  updateFitness(s);
  assert.ok(a.fitness > b.fitness);
  a.fitness = b.fitness = 1;
  a.cold = { ...a.cold, attributes: { ...a.cold.attributes, stamina: 10, workRate: 20 } };
  b.cold = { ...b.cold, attributes: { ...b.cold.attributes, stamina: 10, workRate: 1 } };
  updateFitness(s);
  assert.ok(a.fitness < b.fitness);
});

test('a full scripted match keeps fitness in range and distance consistent with speed', () => {
  const engine = MatchEngine.create(sampleInput(9), config, { debug: false });
  playScripted(engine, 9);
  for (const p of engine.state.players) {
    assert.ok(p.fitness >= 0 && p.fitness <= 1);
    if (p.onPitch === 1 && p.index !== 0 && p.index !== 18) assert.ok(p.distance > 3000 && p.distance < 16000, `distance ${p.distance}`);
  }
});

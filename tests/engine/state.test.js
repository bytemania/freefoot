import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { validateMatchInput, ATTRIBUTES } from '../../src/engine/contracts/MatchInput.js';
import { buildTickConfig } from '../../src/engine/TickConfig.js';
import { getEffectiveAttribute, roleRating } from '../../src/engine/state/PlayerMatchState.js';
import { BallState } from '../../src/engine/state/BallState.js';
import { applyQueuedSubstitutions } from '../../src/engine/restarts/RestartMachine.js';
import { zoneOf } from '../../src/engine/events/MatchEvent.js';
import { config, sampleInput } from './helpers.js';

test('validateMatchInput accepts the sample input and reports each kind of error', () => {
  assert.deepEqual(validateMatchInput(sampleInput(1), config), []);
  const bad = sampleInput(1);
  bad.seed = -1;
  bad.home.players.pop();
  bad.away.players[1].id = bad.away.players[2].id;
  bad.away.players[3].number = bad.away.players[4].number;
  bad.away.players[5].attributes.pace = 21;
  delete bad.away.players[6].attributes.vision;
  bad.away.players[7].role = 'XX';
  bad.away.controlledBy = /** @type {any} */ ('robot');
  bad.away.formationId = '1-1-1';
  const errors = validateMatchInput(bad, config).join('\n');
  for (const part of ['seed', 'home.players must have 18', 'is not unique', 'attributes.pace must be an integer 1-20', 'attributes.vision is missing', 'role "XX"', 'controlledBy', 'formationId']) {
    assert.match(errors, new RegExp(part));
  }
  assert.equal(ATTRIBUTES.length, 33);
});

test('buildTickConfig converts rates to per-tick values and drops the wrappers', () => {
  const k = buildTickConfig(config);
  assert.equal(k.dt, 0.05);
  assert.equal(k.weights.fitness.c.sprint, config.weights.fitness.c.sprint.value * 0.05);
  assert.equal(k.weights.fitness.s_phys, 0.6); // not a rate
  assert.equal(k.weights.pass.p1, config.weights.pass.p1.value);
  assert.equal(k.injuries.fatigue.j0, 0.0002 * 0.05);
  assert.equal(k.weights.ball.rolling, 0.6 * 0.05);
  assert.ok(Object.isFrozen(k.weights));
});

test('getEffectiveAttribute applies the fitness and injury factors and clamps to 1-20', () => {
  const k = buildTickConfig(config);
  const engine = MatchEngine.create(sampleInput(1), config);
  const p = engine.state.players[9]; // home striker
  const { pivot, contrast } = k.weights.attributes;
  /** Raw attribute after the contrast transform. */
  const c = (/** @type {number} */ raw) => pivot + contrast * (raw - pivot);
  const base = c(p.cold.attributes.pace);
  assert.ok(Math.abs(getEffectiveAttribute(p, 'pace', k) - base) < 1e-12);
  p.fitness = 0.5; // 0.2 below the 0.7 threshold
  assert.ok(Math.abs(getEffectiveAttribute(p, 'pace', k) - base * (1 - 0.6 * 0.2)) < 1e-12);
  assert.ok(Math.abs(getEffectiveAttribute(p, 'vision', k) - c(p.cold.attributes.vision) * (1 - 0.2 * 0.2)) < 1e-12);
  p.fitness = 1;
  p.injury = 3; // HIGH
  assert.ok(Math.abs(getEffectiveAttribute(p, 'pace', k) - base * 0.5) < 1e-12);
  assert.ok(Math.abs(getEffectiveAttribute(p, 'reflexes', k) - Math.max(1, c(p.cold.attributes.reflexes) * 0.5)) < 1e-12); // goalkeeping counts as physical
  p.injury = 0;
  // Contrast pulls attributes toward the pivot: a 20 reads below 20, a 5 above 5, the pivot unchanged.
  p.cold = { ...p.cold, attributes: { ...p.cold.attributes, pace: 20, passing: 5, finishing: pivot } };
  assert.ok(Math.abs(getEffectiveAttribute(p, 'pace', k) - c(20)) < 1e-12);
  assert.ok(contrast >= 1 || (getEffectiveAttribute(p, 'pace', k) < 20 && getEffectiveAttribute(p, 'passing', k) > 5));
  assert.equal(getEffectiveAttribute(p, 'finishing', k), pivot);
});

test('roleRating is 0.7 x primary mean + 0.3 x secondary mean', () => {
  const attrs = Object.fromEntries(ATTRIBUTES.map((a) => [a, 10]));
  attrs.finishing = 20;
  const striker = { role: 'ST', attributes: attrs };
  // ST primary: finishing, composure, offTheBall, pace, acceleration -> (20+10*4)/5 = 12; secondary 10
  assert.ok(Math.abs(roleRating(striker, config.roles) - (0.7 * 12 + 0.3 * 10)) < 1e-12);
});

test('BallState.heightAt follows the parabola 4 * peak * s * (1 - s)', () => {
  const b = new BallState();
  assert.equal(b.heightAt(10), 0);
  b.flight = { launchTick: 10, x0: 0, y0: 0, x1: 20, y1: 0, flightTicks: 20, peak: 8 };
  assert.equal(b.heightAt(10), 0);
  assert.equal(b.heightAt(20), 8);
  assert.equal(b.heightAt(30), 0);
  assert.equal(b.heightAt(5), 0);
  assert.equal(b.heightAt(40), 0);
});

test('substitute swaps onPitch flags, hands over the slot and keeps the on-pitch list ascending', () => {
  const engine = MatchEngine.create(sampleInput(1), config);
  const s = engine.state;
  const out = s.players[9];
  const incoming = s.players[16];
  const slot = out.slot;
  s.substitute(9, 16);
  assert.equal(out.onPitch, 0);
  assert.equal(out.slot, -1);
  assert.equal(incoming.onPitch, 1);
  assert.equal(incoming.slot, slot);
  assert.equal(incoming.x, out.x);
  assert.deepEqual(s.onPitchList.filter((i) => i < 18), [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 16]);
  assert.equal(s.onPitchList.length, 22);
});

test('queued substitutions apply on entering a dead ball, in order, and count toward the 5', () => {
  const engine = MatchEngine.create(sampleInput(1), config);
  const s = engine.state;
  s.tick = 3;
  s.pendingSubs.push({ seq: 2, teamIndex: 1, outIndex: 27, inIndex: 30 }, { seq: 1, teamIndex: 0, outIndex: 9, inIndex: 12 });
  applyQueuedSubstitutions(s);
  assert.deepEqual(s.tickEvents.map((e) => [e.type, e.teamIndex, e.actorIndex, e.secondaryIndices[0]]), [
    ['SUBSTITUTION', 0, 9, 12],
    ['SUBSTITUTION', 1, 27, 30],
  ]);
  assert.deepEqual(s.teams.map((t) => t.subsUsed), [1, 1]);
  assert.equal(s.pendingSubs.length, 0);
});

test('zoneOf: 6 x 3 grid relative to the attacking side', () => {
  assert.equal(zoneOf(1, 1, 1), 1);
  assert.equal(zoneOf(1, 67, 1), 3);
  assert.equal(zoneOf(104, 67, 1), 18);
  assert.equal(zoneOf(104, 67, -1), 1); // attacking toward x = 0: x = 104 is its own end, channels mirror
  assert.equal(zoneOf(1, 1, -1), 18);
  assert.equal(zoneOf(-1, -1, 1), -1);
});

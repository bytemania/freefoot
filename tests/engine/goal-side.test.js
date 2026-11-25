// @ts-nocheck -- scene-building helpers over engine internals; the engine code they exercise is fully type-checked.
// Slice 19: markers and the back line stay goal-side of the attackers they track, except on a genuine breakaway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { applyIntent, updateDefensiveLines } from '../../src/engine/decisions/CarrierDecision.js';
import { ACTION, along } from '../../src/engine/decisions/Perception.js';
import { computeAnchors } from '../../src/engine/tactics/Formation.js';
import { config, sampleInput } from './helpers.js';

const GS = config.weights.goalSide;

/** Team 1 has the ball in midfield; returns helpers in team 0's own frame. */
function scene(seed = 6) {
  const engine = MatchEngine.create(sampleInput(seed, { homeControl: 'ai', awayControl: 'ai' }), config);
  const s = engine.state;
  engine.step(100);
  s.restart.state = 'IN_PLAY';
  const dir = s.attackDir(0);
  const at = (a) => (dir > 0 ? a : 105 - a); // team 0 frame -> pitch x
  const ownGoal = { x: dir > 0 ? 0 : 105, y: 34 };
  const distGoal = (p) => Math.hypot(p.x - ownGoal.x, p.y - ownGoal.y);
  const carrier = s.players[24];
  carrier.x = carrier.prevX = at(55);
  carrier.y = carrier.prevY = 34;
  s.ball.owner = carrier.index;
  s.ball.pass = null;
  s.ball.x = carrier.x;
  s.ball.y = carrier.y;
  s.teams[0].phase = 3; // DEFEND
  computeAnchors(s, s.teams[0]);
  computeAnchors(s, s.teams[1]);
  updateDefensiveLines(s);
  return { engine, s, at, dir, ownGoal, distGoal, carrier };
}

/** The deepest centre-back / full-back anchor of team 0, in its own frame. */
function lineOf(s) {
  const slots = config.tactics.formations[s.teams[0].formationId].slots;
  let line = Infinity;
  for (let i = 0; i < 18; i++) {
    const q = s.players[i];
    if (q.onPitch === 1 && q.slot >= 0 && ['CB', 'FB'].includes(slots[q.slot].role)) line = Math.min(line, along(s, 0, q.tx));
  }
  return line;
}

test('a marker in the defensive third stands between the attacker and its own goal, not ahead of him', () => {
  const { s, at, distGoal } = scene();
  const line = lineOf(s);
  const marker = s.players[2];
  const attacker = s.players[27];
  for (const [a, y] of [[line + 6, 20], [line + 4, 50], [line + 8, 34]]) {
    attacker.x = at(a);
    attacker.y = y;
    // The marker has drifted ahead of the attacker (up the pitch): the target must bring it back goal-side.
    marker.x = at(a + 3);
    marker.y = y;
    marker.pendingAction = ACTION.MARK;
    marker.markTarget = attacker.index;
    applyIntent(s, marker, s.ball.owner);
    const target = { x: marker.tx, y: marker.ty };
    assert.ok(distGoal(target) < distGoal(attacker), `target ${distGoal(target).toFixed(2)} m from goal, attacker ${distGoal(attacker).toFixed(2)} m`);
    const gap = Math.hypot(target.x - attacker.x, target.y - attacker.y);
    assert.ok(gap > 1 && gap <= GS.markGap.value + 1e-9, `${gap.toFixed(2)} m from the attacker`);
    // Inside rather than outside: a wide attacker is marked from the goal side of his inside shoulder.
    if (y !== 34) assert.ok(Math.abs(target.y - 34) <= Math.abs(attacker.y - 34) + 1e-9);
  }
});

test('the marker holds the line instead of dropping under it for an attacker standing on it', () => {
  const { s, at } = scene();
  const line = lineOf(s);
  const marker = s.players[3];
  const attacker = s.players[28];
  attacker.x = at(line + 0.5);
  attacker.y = 30;
  marker.pendingAction = ACTION.MARK;
  marker.markTarget = attacker.index;
  applyIntent(s, marker, s.ball.owner);
  assert.ok(Math.abs(along(s, 0, marker.tx) - line) < 1e-9, 'clamped to the line height');
});

test('a striker clear behind the high line keeps his lead: the chasing defender makes a recovery run, no clamp', () => {
  const { engine, s, at, distGoal } = scene();
  const line = lineOf(s);
  const striker = s.players[27];
  const defender = s.players[2];
  // Through on goal: the striker has the ball well behind the line, the defender a few metres behind him.
  striker.x = striker.prevX = at(line - 8);
  striker.y = striker.prevY = 34;
  s.ball.owner = striker.index;
  s.ball.x = striker.x;
  s.ball.y = striker.y;
  defender.x = defender.prevX = at(line - 3);
  defender.y = defender.prevY = 36;
  defender.pendingAction = ACTION.MARK;
  defender.markTarget = striker.index;
  applyIntent(s, defender, striker.index);
  assert.ok(along(s, 0, defender.tx) < line - GS.breakawayMargin.value, 'the target is not pulled back up to the line');
  assert.ok(distGoal({ x: defender.tx, y: defender.ty }) < distGoal(striker), 'a recovery run toward the goal-side point');
  // Over the next half second of play the striker is still the one nearer goal.
  for (let i = 0; i < 10; i++) {
    engine.step(1);
    if (s.ball.owner !== striker.index) break;
    assert.ok(distGoal(striker) < distGoal(defender), `tick ${i}: striker ${distGoal(striker).toFixed(1)} m, defender ${distGoal(defender).toFixed(1)} m`);
  }
});

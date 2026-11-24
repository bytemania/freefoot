// @ts-nocheck -- scene-building helpers over engine internals; the engine code they exercise is fully type-checked.
// Slice 16: pressured touchline clearances and the phase-driven formation shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { decideCarrier } from '../../src/engine/decisions/CarrierDecision.js';
import { giveBall } from '../../src/engine/decisions/Actions.js';
import { ACTION } from '../../src/engine/decisions/Perception.js';
import { PHASE } from '../../src/engine/state/TeamState.js';
import { computeAnchors } from '../../src/engine/tactics/Formation.js';
import { config, sampleInput } from './helpers.js';

/** A team-0 defender pinned to the touchline in his own third, two opponents on him, team-mates all marked. */
function pinned(seed) {
  const engine = MatchEngine.create(sampleInput(seed, { homeControl: 'ai', awayControl: 'ai' }), config);
  const s = engine.state;
  engine.step(100);
  s.restart.state = 'IN_PLAY';
  const dir = s.attackDir(0);
  const at = (a) => (dir > 0 ? a : 105 - a);
  for (const i of s.onPitchList) {
    const p = s.players[i];
    p.x = p.prevX = p.tx = at(p.team === 0 ? 30 + (i % 9) : 40 + (i % 9));
    p.y = p.prevY = p.ty = 10 + (i % 11) * 4.5;
    p.vx = p.vy = 0;
    p.pendingAction = ACTION.HOLD;
  }
  const carrier = s.players[1];
  carrier.x = carrier.prevX = at(14);
  carrier.y = carrier.prevY = 3;
  // Two opponents on the carrier, and one on top of every team-mate.
  s.players[19].x = s.players[19].prevX = at(15);
  s.players[19].y = s.players[19].prevY = 4.5;
  s.players[20].x = s.players[20].prevX = at(13);
  s.players[20].y = s.players[20].prevY = 4.5;
  for (const m of s.onPitchList) {
    if (s.players[m].team !== 0 || m === 1) continue;
    const o = s.players[18 + 1 + ((m * 7) % 9)];
    if (o === s.players[19] || o === s.players[20]) continue;
    o.x = o.prevX = s.players[m].x + 0.8;
    o.y = o.prevY = s.players[m].y;
  }
  s.ball.pass = null;
  s.ball.x = carrier.x;
  s.ball.y = carrier.y;
  return { engine, s, carrier, at };
}

test('a defender pinned to the touchline in his own third clears rather than risks a pass', () => {
  let clears = 0;
  let into = 0;
  const trials = 20;
  for (let t = 0; t < trials; t++) {
    const { s, carrier } = pinned(40 + t);
    giveBall(s, carrier.index, false);
    carrier.decisionTimer = 0;
    decideCarrier(s, carrier);
    // A clearance is a kick with no pass in flight (a pass would set `ball.pass`).
    if (s.ball.owner < 0 && s.ball.pass === null) {
      clears++;
      // Aimed beyond the touchline (a throw-in) for most of them: the ball travels toward y < 0.
      if (s.ball.vy < 0) into++;
    }
  }
  assert.ok(clears / trials >= 0.6, `${clears} of ${trials} cleared`);
  assert.ok(into >= 1, 'some clearances head for touch');
});

test('anchors widen the centre-backs in build-up and hold the front line high in the final third', () => {
  const engine = MatchEngine.create(sampleInput(5, { homeControl: 'ai', awayControl: 'ai' }), config);
  const s = engine.state;
  engine.step(100);
  s.restart.state = 'IN_PLAY';
  const team = s.teams[0];
  const slots = config.tactics.formations[team.formationId].slots;
  const dir = s.attackDir(0);
  const own = (p) => (dir > 0 ? p.x : 105 - p.x);
  const ownY = (p) => (dir > 0 ? p.y : 68 - p.y);
  const shapeAt = (phase) => {
    team.phase = phase;
    computeAnchors(s, team);
    const out = [];
    for (let i = 0; i < 18; i++) {
      const p = s.players[i];
      if (p.onPitch === 1 && p.slot >= 0) out.push({ role: slots[p.slot].role, x: own({ x: p.tx }), y: ownY({ y: p.ty }) });
    }
    return out;
  };
  const build = shapeAt(PHASE.BUILD_UP);
  const prog = shapeAt(PHASE.PROGRESSION);
  const final = shapeAt(PHASE.FINAL_THIRD);
  const cbSpan = (rows) => {
    const ys = rows.filter((r) => r.role === 'CB').map((r) => r.y);
    return Math.max(...ys) - Math.min(...ys);
  };
  assert.ok(cbSpan(build) > cbSpan(prog) + 1, 'centre-backs are wider in build-up');
  const minX = config.weights.phaseShape.finalThirdMinX.value;
  for (const r of final.filter((r) => r.role === 'ST' || r.role === 'W')) assert.ok(r.x >= minX - 1e-9, `${r.role} at ${r.x}`);
  const sumFront = (rows) => rows.filter((r) => r.role === 'ST' || r.role === 'W').reduce((a, r) => a + r.x, 0);
  assert.ok(sumFront(final) >= sumFront(prog), 'the front line is not deeper in the final third');
});

test('save and restore mid-match with the new shape and clearance rules: same final hash', () => {
  const input = sampleInput(11, { homeControl: 'ai', awayControl: 'ai' });
  const a = MatchEngine.create(input, config);
  a.step(3000);
  const saved = JSON.parse(JSON.stringify(a.serialize()));
  const b = MatchEngine.fromState(saved, input, config);
  assert.equal(b.hash(), a.hash());
  a.step(3000);
  b.step(3000);
  assert.equal(b.hash(), a.hash());
});

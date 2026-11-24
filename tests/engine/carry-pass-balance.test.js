// @ts-nocheck -- scene-building helpers over engine internals; the engine code they exercise is fully type-checked.
// Slice 15: an unpressed carrier settles before acting, and a routine open pass between team-mates completes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { giveBall, launchPass } from '../../src/engine/decisions/Actions.js';
import { ACTION } from '../../src/engine/decisions/Perception.js';
import { config, sampleInput } from './helpers.js';

const SETTLE = config.weights.decision.settleTicks.value;
const SETTLE_PRESSED = config.weights.decision.settlePressureTicks.value;

/** Everyone parked on the edges; returns the carrier (team 0), a team-mate and the nearest opponent. */
function scene(seed) {
  const engine = MatchEngine.create(sampleInput(seed, { homeControl: 'ai', awayControl: 'ai' }), config);
  const s = engine.state;
  engine.step(100);
  s.restart.state = 'IN_PLAY';
  const dir = s.attackDir(0);
  const at = (a) => (dir > 0 ? a : 105 - a);
  for (const i of s.onPitchList) {
    const p = s.players[i];
    // Team-mates in their own half, opponents behind the receiver (so a ball to him is onside).
    p.x = p.prevX = p.tx = at(p.team === 0 ? 5 + (i % 18) * 1.2 : 98 - (i % 18) * 0.5);
    p.y = p.prevY = p.ty = i < 18 ? 3 : 65;
    p.vx = p.vy = 0;
    p.pendingAction = ACTION.HOLD;
  }
  const carrier = s.players[4];
  const mate = s.players[7];
  const opp = s.players[22];
  carrier.x = carrier.prevX = at(50);
  carrier.y = carrier.prevY = 34;
  mate.x = mate.prevX = mate.tx = at(65);
  mate.y = mate.prevY = mate.ty = 34;
  s.ball.pass = null;
  return { engine, s, carrier, mate, opp, at };
}

test('an unpressed new owner settles for the full settle time; a pressed one gets rid of it sooner', () => {
  assert.ok(SETTLE > SETTLE_PRESSED);
  const free = scene(3);
  giveBall(free.s, free.carrier.index, false);
  assert.equal(free.carrier.decisionTimer, SETTLE);
  const pressed = scene(3);
  pressed.opp.x = pressed.opp.prevX = pressed.at(51);
  pressed.opp.y = pressed.opp.prevY = 34;
  giveBall(pressed.s, pressed.carrier.index, false);
  assert.equal(pressed.carrier.decisionTimer, SETTLE_PRESSED);
  // The unpressed carrier keeps the ball, going nowhere, until the timer runs out.
  free.opp.x = free.opp.prevX = free.at(95);
  let kept = 0;
  while (free.s.ball.owner === free.carrier.index && kept < SETTLE + 5) {
    free.engine.step(1);
    kept++;
  }
  assert.ok(kept >= SETTLE - 5, `kept the ball ${kept} ticks`);
});

test('a routine open pass between team-mates completes nine times in ten', () => {
  let done = 0;
  const trials = 30;
  for (let trial = 0; trial < trials; trial++) {
    const { engine, s, carrier, mate } = scene(10 + trial);
    giveBall(s, carrier.index, false);
    launchPass(s, carrier, mate.index, 'SHORT');
    let ticks = 0;
    while (s.ball.pass !== null && ticks < 200) {
      engine.step(1);
      ticks++;
    }
    if (s.ball.owner === mate.index || (s.ball.owner < 0 && s.ball.lastTouch === mate.index)) done++;
  }
  assert.ok(done / trials >= 0.85, `${done} of ${trials} completed`);
});

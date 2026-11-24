// @ts-nocheck -- scene-building helpers over engine internals; the engine code they exercise is fully type-checked.
// Team tactical phase, the shared support spots, and their serialization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { PHASE } from '../../src/engine/state/TeamState.js';
import { updatePhases } from '../../src/engine/tactics/Phase.js';
import { updateSupportSpots } from '../../src/engine/decisions/OffBallDecision.js';
import { ACTION } from '../../src/engine/decisions/Perception.js';
import { config, sampleInput } from './helpers.js';

const TRANSITION = config.weights.offBall.transitionTicks.value;

function engineAt() {
  const engine = MatchEngine.create(sampleInput(2, { homeControl: 'ai', awayControl: 'ai' }), config);
  engine.step(200);
  return engine;
}

/** Puts the ball on `owner` at (x, y). */
function give(s, owner, x, y) {
  const p = s.players[owner];
  p.x = p.prevX = x;
  p.y = p.prevY = y;
  s.ball.owner = owner;
  s.ball.pass = null;
  s.ball.x = s.ball.prevX = x;
  s.ball.y = s.ball.prevY = y;
}

const HOME = 4; // an outfield home player
const AWAY = 22;

test('phase: possession, a turnover, progression and the final third', () => {
  const engine = engineAt();
  const s = engine.state;
  const [home, away] = s.teams;
  const along0 = (x) => (s.attackDir(0) > 0 ? x : 105 - x);
  const xAt = (a) => (s.attackDir(0) > 0 ? a : 105 - a);
  // Home has the ball deep: build-up (after the transition from wherever play was, give the clock time).
  home.phase = PHASE.PROGRESSION;
  give(s, HOME, xAt(20), 34);
  updatePhases(s);
  assert.equal(home.phase, PHASE.BUILD_UP);
  assert.equal(away.phase === PHASE.DEFEND || away.phase === PHASE.TRANSITION_DEF, true);
  // Up the pitch: progression, then the final third.
  give(s, HOME, xAt(55), 34);
  updatePhases(s);
  assert.equal(home.phase, PHASE.PROGRESSION);
  give(s, HOME, xAt(85), 34);
  updatePhases(s);
  assert.equal(home.phase, PHASE.FINAL_THIRD);
  assert.equal(along0(s.players[HOME].x) > 68, true);
  // Away wins it: away transitions to attack, home to defence-in-transition, for transitionTicks.
  give(s, AWAY, xAt(80), 34);
  updatePhases(s);
  assert.equal(away.phase, PHASE.TRANSITION_ATT);
  assert.equal(home.phase, PHASE.TRANSITION_DEF);
  assert.equal(away.phaseTick, 0);
  for (let t = 0; t < TRANSITION / 5 - 1; t++) updatePhases(s);
  assert.equal(away.phase, PHASE.TRANSITION_ATT, 'still in the transition');
  updatePhases(s);
  assert.notEqual(away.phase, PHASE.TRANSITION_ATT, 'the transition has run its course');
  assert.equal(home.phase, PHASE.DEFEND);
  // A loose ball changes nothing.
  s.ball.owner = -1;
  const before = [home.phase, away.phase];
  updatePhases(s);
  assert.deepEqual([home.phase, away.phase], before);
});

/** Everyone out of the way, a home carrier at (50, 34), and three home midfielders / wingers near it. */
function supportScene() {
  const engine = engineAt();
  const s = engine.state;
  const dir = s.attackDir(0);
  const at = (a) => (dir > 0 ? a : 105 - a);
  for (const i of s.onPitchList) {
    const p = s.players[i];
    p.x = p.prevX = p.tx = at(3 + (i % 18) * 1.5);
    p.y = p.prevY = p.ty = i < 18 ? 2 : 66;
    p.vx = p.vy = 0;
    p.pendingAction = ACTION.HOLD;
  }
  const carrier = s.players[HOME];
  carrier.x = carrier.prevX = at(50);
  carrier.y = carrier.prevY = 34;
  s.ball.owner = HOME;
  s.ball.pass = null;
  s.teams[0].phase = PHASE.PROGRESSION;
  // Eligible supporters: whoever fills MF, W or ST slots; put three of them around the carrier.
  const eligible = s.onPitchList.filter((i) => {
    const p = s.players[i];
    if (p.team !== 0 || i === HOME || p.isKeeper === 1) return false;
    const role = s.config.tactics.formations[s.teams[0].formationId].slots[p.slot]?.role ?? p.cold.role;
    return role === 'MF' || role === 'W' || role === 'ST';
  });
  assert.ok(eligible.length >= 3);
  return { engine, s, at, carrier, eligible };
}

test('support spots: an open lane beats a blocked, crowded one; only eligible supporters are assigned', () => {
  const { s, at, carrier, eligible } = supportScene();
  // Put the whole away team in a wall straight ahead of the carrier, leaving the flanks open.
  const away = s.onPitchList.filter((i) => s.players[i].team === 1 && s.players[i].isKeeper !== 1);
  away.forEach((i, n) => {
    const p = s.players[i];
    p.x = p.prevX = at(60 + (n % 2));
    p.y = p.prevY = 22 + n * 2.4;
  });
  // Park the supporters far off, then stand one on each ring point in turn until the best spot finds a taker.
  for (const e of eligible) {
    const p = s.players[e];
    p.x = p.prevX = at(2);
    p.y = p.prevY = 2;
  }
  const t = s.teams[0];
  const ring = [];
  for (const r of [9, 18]) for (let a = 0; a < 8; a++) ring.push([carrier.x + Math.cos((a * Math.PI) / 4) * r, carrier.y + Math.sin((a * Math.PI) / 4) * r]);
  for (const [x, y] of ring) {
    const p = s.players[eligible[0]];
    p.x = p.prevX = x;
    p.y = p.prevY = y;
    updateSupportSpots(s, 0);
    if (t.supportPlayer[0] >= 0 || t.supportPlayer[1] >= 0) break;
  }
  assert.ok(t.supportPlayer[0] >= 0 || t.supportPlayer[1] >= 0, 'a supporter is assigned a spot');
  for (const k of [0, 1]) {
    if (t.supportPlayer[k] < 0) continue;
    assert.ok(eligible.includes(t.supportPlayer[k]));
    const d = Math.hypot(t.supportX[k] - carrier.x, t.supportY[k] - carrier.y);
    assert.ok(d >= 8.9 && d <= 18.1, `spot ${d} m from the carrier`);
    // Not in the wall: clear of every away player.
    for (const i of away) assert.ok(Math.hypot(t.supportX[k] - s.players[i].x, t.supportY[k] - s.players[i].y) > 2);
  }
  // The carrier is never a supporter, and no player holds both spots.
  assert.notEqual(t.supportPlayer[0], HOME);
  if (t.supportPlayer[1] >= 0) assert.notEqual(t.supportPlayer[0], t.supportPlayer[1]);
  // Without the ball, nothing is assigned.
  s.ball.owner = AWAY;
  updateSupportSpots(s, 0);
  assert.deepEqual(t.supportPlayer, [-1, -1]);
});

test('support spots: hysteresis keeps the holder and the spot when a rival is only slightly nearer', () => {
  const { s, at, eligible } = supportScene();
  const [a, b] = eligible;
  for (const i of s.onPitchList) if (s.players[i].team === 1) s.players[i].x = s.players[i].prevX = at(95);
  const pa = s.players[a];
  const pb = s.players[b];
  pb.x = pb.prevX = at(2);
  pb.y = pb.prevY = 2;
  const t = s.teams[0];
  const carrier = s.players[HOME];
  for (const r of [9, 18]) {
    for (let k = 0; k < 8 && t.supportPlayer[0] < 0 && t.supportPlayer[1] < 0; k++) {
      pa.x = pa.prevX = carrier.x + Math.cos((k * Math.PI) / 4) * r;
      pa.y = pa.prevY = carrier.y + Math.sin((k * Math.PI) / 4) * r;
      updateSupportSpots(s, 0);
    }
  }
  const slot = t.supportPlayer[0] >= 0 ? 0 : 1;
  const first = t.supportPlayer[slot];
  const spot = [t.supportX[slot], t.supportY[slot]];
  assert.ok(first >= 0, 'a supporter is assigned a spot');
  // Move the other candidate to just nearer to that spot than the holder (inside the hysteresis margin).
  const holder = s.players[first];
  const rival = first === a ? pb : pa;
  const dHolder = Math.hypot(holder.x - spot[0], holder.y - spot[1]);
  const ang = Math.atan2(holder.y - spot[1], holder.x - spot[0]);
  const margin = config.weights.support.hysteresisM.value;
  rival.x = rival.prevX = spot[0] + Math.cos(ang + 1.2) * (dHolder - margin / 2);
  rival.y = rival.prevY = spot[1] + Math.sin(ang + 1.2) * (dHolder - margin / 2);
  updateSupportSpots(s, 0);
  assert.ok(t.supportPlayer.includes(first), 'the holder keeps a spot');
  const k = t.supportPlayer.indexOf(first);
  assert.ok(Math.abs(t.supportX[k] - spot[0]) < 6 && Math.abs(t.supportY[k] - spot[1]) < 6, 'and the spot barely moves');
});

test('phase and support spots survive a save and restore mid-possession: same final hash', () => {
  const input = sampleInput(9, { homeControl: 'ai', awayControl: 'ai' });
  const a = MatchEngine.create(input, config);
  let tick = 0;
  let sawSpot = false;
  while (tick < 4000) {
    a.step(50);
    tick = a.tick;
    const t = a.state.teams;
    if (t[0].supportPlayer[0] >= 0 || t[1].supportPlayer[0] >= 0) {
      sawSpot = true;
      break;
    }
  }
  assert.ok(sawSpot, 'a support spot was assigned in the opening phase');
  const saved = JSON.parse(JSON.stringify(a.serialize()));
  assert.ok(saved.teams.every((t) => typeof t.phase === 'number' && Array.isArray(t.supportPlayer)));
  const b = MatchEngine.fromState(saved, input, config);
  assert.equal(b.hash(), a.hash());
  a.step(3000);
  b.step(3000);
  assert.equal(b.hash(), a.hash(), 'the restored match plays on identically');
  assert.deepEqual(b.state.teams.map((t) => [t.phase, t.phaseTick, t.supportPlayer]), a.state.teams.map((t) => [t.phase, t.phaseTick, t.supportPlayer]));
});

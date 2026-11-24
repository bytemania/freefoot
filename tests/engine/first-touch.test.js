// @ts-nocheck -- table-style checks with untyped helper lambdas; the engine code they exercise is fully type-checked.
// Branching first touch (passing.js firstTouch, contacts.js reception / heavyTouch): clean, heavy and spill from one draw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOUCH, firstTouch } from '../../src/engine/resolve/passing.js';
import { buildTickConfig } from '../../src/engine/TickConfig.js';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { ACTION } from '../../src/engine/decisions/Perception.js';
import { config, sampleInput } from './helpers.js';

const k = buildTickConfig(config).weights;
const out = { pControl: 0, controlled: false, outcome: 0, heavyFrac: 0 };

/** Outcome at the middle of the heavy band, so only the inputs decide it. */
function mid(speed, pressure, ft, tech, composure, height) {
  firstTouch(speed, pressure, ft, tech, k, 0.5, out, composure, height);
  const pControl = out.pControl;
  firstTouch(speed, pressure, ft, tech, k, 0, out, composure, height);
  return { pControl, pClean: pControl * (1 - heavyShare(speed, pressure, ft, tech, composure, height)) };
}
function heavyShare(speed, pressure, ft, tech, composure, height) {
  // Bisect u over [0, pControl] for the CLEAN / HEAVY edge, to read the share without re-implementing the formula.
  firstTouch(speed, pressure, ft, tech, k, 0.5, out, composure, height);
  const pc = out.pControl;
  let lo = 0;
  let hi = pc;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    firstTouch(speed, pressure, ft, tech, k, m, out, composure, height);
    if (out.outcome === TOUCH.CLEAN) lo = m;
    else hi = m;
  }
  return 1 - lo / pc;
}

test('high firstTouch and composure on a slow ground pass: a clean touch for most draws, never a spill', () => {
  const { pControl, pClean } = mid(6, 0.05, 18, 16, 18, 0);
  assert.ok(pControl > 0.95, `pControl ${pControl}`);
  assert.ok(pClean > 0.85, `pClean ${pClean}`);
  firstTouch(6, 0.05, 18, 16, k, 0.5, out, 18, 0);
  assert.equal(out.outcome, TOUCH.CLEAN);
  firstTouch(6, 0.05, 18, 16, k, 0.9, out, 18, 0);
  assert.notEqual(out.outcome, TOUCH.SPILL);
});

test('a hard, bouncing pass under moderate pressure: the touch is heavy inside the heavy band, sized by where the draw falls', () => {
  const { pControl, pClean } = mid(18, 0.5, 12, 12, 12, 1.2);
  assert.ok(pClean < pControl, 'a heavy band exists');
  firstTouch(18, 0.5, 12, 12, k, (pClean + pControl) / 2, out, 12, 1.2);
  assert.equal(out.outcome, TOUCH.HEAVY);
  assert.ok(out.controlled);
  assert.ok(Math.abs(out.heavyFrac - 0.5) < 1e-9);
  firstTouch(18, 0.5, 12, 12, k, pClean - 1e-6, out, 12, 1.2);
  assert.equal(out.outcome, TOUCH.CLEAN);
  firstTouch(18, 0.5, 12, 12, k, pControl + 1e-6, out, 12, 1.2);
  assert.equal(out.outcome, TOUCH.SPILL);
});

test('poor touch under heavy pressure on a fast ball: a spill for most draws', () => {
  const { pControl } = mid(22, 1, 4, 5, 4, 1.5);
  assert.ok(pControl < 0.5, `pControl ${pControl}`);
  firstTouch(22, 1, 4, 5, k, 0.9, out, 4, 1.5);
  assert.equal(out.outcome, TOUCH.SPILL);
  assert.equal(out.controlled, false);
});

test('composure helps and height hurts the control probability', () => {
  const p = (c, h) => (firstTouch(12, 0.3, 12, 12, k, 0.5, out, c, h), out.pControl);
  assert.ok(p(18, 0) > p(6, 0));
  assert.ok(p(12, 0) > p(12, 1.5));
});

/** One reception: a team-0 pass reaches a team-0 receiver moving at 4 m/s along +x, one team-1 player nearby. */
function receive(trial) {
  const engine = MatchEngine.create(sampleInput(5, { homeControl: 'ai', awayControl: 'ai' }), config);
  const s = engine.state;
  engine.step(200);
  const list = s.onPitchList.filter((i) => s.players[i].isKeeper !== 1);
  const passer = s.players[list.find((i) => s.players[i].team === 0)];
  const receiver = s.players[list.filter((i) => s.players[i].team === 0)[1]];
  const marker = s.players[list.find((i) => s.players[i].team === 1)];
  let n = 0;
  for (const i of s.onPitchList) {
    const p = s.players[i];
    if (p === passer || p === receiver || p === marker) continue;
    p.x = p.prevX = p.tx = 5 + (n % 11) * 9;
    p.y = p.prevY = p.ty = n < 11 ? 5 : 62;
    p.vx = p.vy = 0;
    p.pendingAction = ACTION.HOLD;
    n++;
  }
  const place = (p, x, y) => {
    p.x = p.prevX = p.tx = x;
    p.y = p.prevY = p.ty = y;
    p.vx = p.vy = 0;
    p.pendingAction = ACTION.HOLD;
  };
  place(passer, 40, 30);
  place(receiver, 50, 30);
  receiver.vx = 4;
  place(marker, 53, 31);
  const b = s.ball;
  b.owner = -1;
  b.flight = null;
  b.x = b.prevX = 50;
  b.y = b.prevY = 30;
  b.z = b.prevZ = 0;
  b.vx = 14;
  b.vy = 0;
  b.lastTouch = passer.index;
  b.touchTick = s.tick - 50;
  b.pass = { passer: passer.index, receiver: receiver.index, kind: 'SHORT', restart: false, accurate: true, px: 50, py: 30, tried: [] };
  s.rng[0] = (trial * 2654435761) >>> 0;
  s.rng[1] = (trial * 40503 + 7) >>> 0;
  const events = engine.step(1).events;
  return { s, receiver, events, completed: b.pass === null };
}

test('reception: clean, heavy and spill all occur, and each leaves the ball as designed', () => {
  const seen = { clean: 0, heavy: 0, spill: 0 };
  for (let trial = 1; trial < 400 && (!seen.clean || !seen.heavy || !seen.spill); trial++) {
    const { s, receiver, events } = receive(trial);
    const b = s.ball;
    const mis = events.some((e) => e.type === 'MISCONTROL');
    if (mis) {
      seen.spill++;
      assert.equal(b.owner, -1);
      assert.equal(b.pass, null, 'a spill ends the pass');
    } else if (b.owner === receiver.index) {
      seen.clean++;
      assert.equal(b.pass, null);
    } else {
      seen.heavy++;
      assert.equal(b.owner, -1, 'a heavy touch leaves the ball loose');
      assert.equal(b.pass, null, 'the pass is over');
      assert.equal(b.lastTouch, receiver.index);
      assert.equal(receiver.pendingAction, ACTION.CHASE);
      assert.ok(b.vx > 0, 'knocked on along the receiver momentum');
      const knocked = Math.hypot(b.x - receiver.x, b.y - receiver.y);
      assert.ok(b.vx > 1.4 && b.vx < 3.6 + 1, `rolling speed ${b.vx}`);
      assert.ok(knocked < 4, `ball ${knocked} m from the receiver`);
      assert.ok(!events.some((e) => e.type === 'MISCONTROL'), 'a heavy touch is not a miscontrol');
    }
  }
  assert.ok(seen.clean > 0 && seen.heavy > 0 && seen.spill > 0, JSON.stringify(seen));
});

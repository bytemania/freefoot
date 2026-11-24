// @ts-nocheck -- scene-building helpers over engine internals; the engine code they exercise is fully type-checked.
// Kinematic pass interception margin, the static xT grid, and the inspector's agreement with the pass score.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { passInterceptMargin, ACTION } from '../../src/engine/decisions/Perception.js';
import { passScore, lastPassKind } from '../../src/engine/decisions/CarrierDecision.js';
import { inspectCarrierDecision } from '../../src/engine/debug/inspect.js';
import { XT_COLUMNS, XT_GRID, XT_ROWS, xT } from '../../src/engine/decisions/xT.js';
import { config, sampleInput } from './helpers.js';

const BALL = 14; // m/s

/** Everyone parked far from the action; returns the passer (team 0) and a defender (team 1) to place. */
function scene() {
  const engine = MatchEngine.create(sampleInput(1, { homeControl: 'ai', awayControl: 'ai' }), config);
  const s = engine.state;
  s.restart.state = 'IN_PLAY';
  for (const i of s.onPitchList) {
    const p = s.players[i];
    p.x = p.prevX = 3 + (i % 36) * 2.8;
    p.y = p.prevY = i < 18 ? 2 : 66;
    p.vx = p.vy = 0;
  }
  const passer = s.players[1];
  passer.x = passer.prevX = 40;
  passer.y = passer.prevY = 34;
  const def = s.players[19];
  return { engine, s, passer, def };
}

test('passInterceptMargin: a defender who reaches the target or the lane first gives a negative margin', () => {
  const { s, passer, def } = scene();
  def.x = 58;
  def.y = 35; // beside the target, well before a 20 m ball arrives
  assert.ok(passInterceptMargin(s, passer, 60, 34, BALL) < 0, 'defender at the target');
  def.x = 50;
  def.y = 34; // in the middle of the lane
  assert.ok(passInterceptMargin(s, passer, 60, 34, BALL) < 0, 'defender in the lane');
  assert.ok(passInterceptMargin(s, passer, 60, 34, BALL, false) > passInterceptMargin(s, passer, 60, 34, BALL, true), 'a lofted ball ignores the lane');
});

test('passInterceptMargin: a defender far from the ball, or trailing a runner, leaves the ball there first', () => {
  const { s, passer, def } = scene();
  def.x = 90;
  def.y = 60;
  assert.ok(passInterceptMargin(s, passer, 60, 34, BALL) > 0, 'defender far away');
  // A runner's lead point: the defender trails behind it, moving away.
  def.x = 52;
  def.y = 34;
  def.vx = -5;
  const behind = passInterceptMargin(s, passer, 75, 34, 18);
  def.vx = 5;
  const toward = passInterceptMargin(s, passer, 75, 34, 18);
  assert.ok(toward > -5 && behind > toward, 'a defender running away from the target is slower to arrive than one running to it');
});

test('passInterceptMargin: allocation-free arithmetic returns the same number twice, and Infinity with no opponent', () => {
  const { s, passer, def } = scene();
  def.x = 55;
  def.y = 40;
  assert.equal(passInterceptMargin(s, passer, 60, 34, BALL), passInterceptMargin(s, passer, 60, 34, BALL));
  for (const i of s.onPitchList) s.players[i].team === 1 && (s.players[i].onPitch = 0);
  s.rebuildOnPitchList();
  assert.equal(passInterceptMargin(s, passer, 60, 34, BALL), Infinity);
});

test('xT: 12 x 8 grid, mirrored across the width, rising toward the central penalty area', () => {
  assert.equal(XT_GRID.length, XT_ROWS * XT_COLUMNS);
  assert.equal(XT_ROWS, 8);
  assert.equal(XT_COLUMNS, 12);
  for (let c = 0; c < XT_COLUMNS; c++) for (let r = 0; r < 4; r++) assert.equal(XT_GRID[r * XT_COLUMNS + c], XT_GRID[(7 - r) * XT_COLUMNS + c]);
  const colMean = (c) => {
    let sum = 0;
    for (let r = 0; r < XT_ROWS; r++) sum += XT_GRID[r * XT_COLUMNS + c];
    return sum / XT_ROWS;
  };
  for (let c = 1; c < XT_COLUMNS; c++) assert.ok(colMean(c) > colMean(c - 1), `column ${c} above column ${c - 1}`);
  // Central beats wide in the final third, and the penalty-area centre is the maximum.
  assert.ok(xT(100, 34) > xT(100, 3));
  assert.ok(xT(100, 34) > xT(80, 34) && xT(80, 34) > xT(50, 34) && xT(50, 34) > xT(10, 34));
  assert.equal(xT(100, 34), Math.max(...XT_GRID));
  assert.equal(xT(-5, -5), xT(0, 0), 'out-of-range points clamp');
  assert.equal(xT(110, 80), xT(104.9, 67.9));
});

test('inspectCarrierDecision: pass scores and kinds are exactly the decision\'s own', () => {
  const engine = MatchEngine.create(sampleInput(3, { homeControl: 'ai', awayControl: 'ai' }), config);
  let checked = 0;
  for (let t = 0; t < 200 && checked < 40; t++) {
    engine.step(40);
    const s = engine.state;
    const info = inspectCarrierDecision(s);
    if (info === null) continue;
    const p = s.players[info.carrierIndex];
    // The inspector reads the true offside line; recompute it the same way here.
    for (const row of info.passes) {
      const r = s.players[row.receiverIndex];
      let first = -Infinity;
      let second = -Infinity;
      for (const i of s.onPitchList) {
        const q = s.players[i];
        if (q.team === p.team) continue;
        const a = s.attackDir(p.team) > 0 ? q.x : 105 - q.x;
        if (a > first) {
          second = first;
          first = a;
        } else if (a > second) second = a;
      }
      assert.equal(row.score, passScore(s, p, r, second));
      assert.equal(row.passKind, lastPassKind());
      checked++;
    }
  }
  assert.ok(checked > 0, 'saw carriers with pass options');
});

test('a ball in behind is scored at the lead point: a runner moving off the defence is worth more than one standing still', () => {
  const { s, passer } = scene();
  const r = s.players[2];
  r.x = r.prevX = 62;
  r.y = r.prevY = 34;
  r.vx = r.vy = 0;
  r.pendingAction = ACTION.HOLD;
  const still = passScore(s, passer, r, 60);
  r.vx = 7;
  r.pendingAction = ACTION.RUN;
  const running = passScore(s, passer, r, 60);
  assert.ok(running > still, `running ${running} vs still ${still}`);
});

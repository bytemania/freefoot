// Ball-to-body blocking (contacts.js bodyBlock): a player is a vertical cylinder the ball cannot pass through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { ACTION } from '../../src/engine/decisions/Perception.js';
import { launchGround, launchProjectile, segmentCircleSpan } from '../../src/engine/ball/BallPhysics.js';
import { config, sampleInput } from './helpers.js';

const BODY_HEIGHT = config.weights.contest.bodyHeight.value;

/**
 * An in-play match with everybody parked away from the lane y = 30, two opposing outfield players
 * returned as the kicker (team 0) and defenders (team 1).
 */
function setup() {
  const engine = MatchEngine.create(sampleInput(5, { homeControl: 'ai', awayControl: 'ai' }), config);
  const s = engine.state;
  engine.step(200);
  const outfield = s.onPitchList.filter((i) => s.players[i].isKeeper !== 1);
  const kicker = s.players[/** @type {number} */ (outfield.find((i) => s.players[i].team === 0))];
  const [d1, d2] = outfield.filter((i) => s.players[i].team === 1).map((i) => s.players[i]);
  let n = 0;
  for (const i of s.onPitchList) {
    const p = s.players[i];
    if (p === kicker || p === d1 || p === d2) continue;
    p.x = p.prevX = 5 + (n % 11) * 9;
    p.y = p.prevY = n < 11 ? 5 : 62;
    p.pendingAction = ACTION.HOLD;
    n++;
  }
  for (const p of [kicker, d1, d2]) p.pendingAction = ACTION.HOLD;
  s.ball.owner = -1;
  s.ball.pass = null;
  s.ball.lastTouch = kicker.index;
  s.ball.touchTick = s.tick;
  kicker.x = kicker.prevX = 40;
  kicker.y = kicker.prevY = 30;
  return { engine, s, kicker, d1, d2 };
}

/** Park a defender at (x, 30) and stop it moving. */
function park(/** @type {any} */ p, /** @type {number} */ x, y = 30) {
  p.x = p.prevX = p.tx = x;
  p.y = p.prevY = p.ty = y;
  p.vx = p.vy = 0;
}

test('segmentCircleSpan: entry and exit fractions, misses, and a segment starting inside', () => {
  const hit = segmentCircleSpan(0, 0, 10, 0, 5, 0, 1);
  assert.ok(hit);
  assert.ok(Math.abs(hit.t0 - 0.4) < 1e-9 && Math.abs(hit.t1 - 0.6) < 1e-9);
  assert.equal(segmentCircleSpan(0, 0, 10, 0, 5, 2, 1), null);
  assert.equal(segmentCircleSpan(0, 0, 3, 0, 5, 0, 1), null, 'stops short of the circle');
  const inside = segmentCircleSpan(5, 0, 8, 0, 5.2, 0, 1);
  assert.ok(inside);
  assert.equal(inside.t0, 0);
});

test('a low ground ball through a defender is stopped or deflected, never passed through', () => {
  const { engine, s, kicker, d1 } = setup();
  park(d1, 48);
  launchGround(s, kicker.x, kicker.y, 70, 30, 20, kicker.index);
  s.ball.touchTick = s.tick;
  let past = false;
  for (let t = 0; t < 30; t++) {
    engine.step(1);
    if (s.ball.owner >= 0) break;
    if (s.ball.x > 50 && Math.abs(s.ball.y - 30) < 0.3 && s.ball.vx > 15) past = true;
  }
  assert.equal(past, false, 'the ball did not run through the defender at full speed');
  assert.ok(s.ball.owner === d1.index || s.ball.lastTouch === d1.index, 'the defender touched it');
});

test('a lofted ball over head height clears the defender', () => {
  const { engine, s, kicker, d1 } = setup();
  park(d1, 48);
  launchProjectile(s, kicker.x, kicker.y, 70, 30, 14, 9, 0, kicker.index, 0.2);
  s.ball.touchTick = s.tick;
  let zOver = Infinity;
  for (let t = 0; t < 40 && s.ball.x < 49.5; t++) {
    engine.step(1);
    if (s.ball.x > 47 && s.ball.x < 49) zOver = Math.min(zOver, s.ball.z);
    assert.equal(s.ball.owner, -1, 'nobody took the ball out of the air');
  }
  assert.ok(zOver > BODY_HEIGHT, `ball at least ${zOver.toFixed(2)} m high over the defender`);
  assert.equal(s.ball.lastTouch, kicker.index, 'the defender never touched it');
  assert.ok(s.ball.x >= 49.5, 'carried on past the defender');
});

test('the kicker does not self-block on launch, even with the ball starting inside their body', () => {
  const { engine, s, kicker } = setup();
  launchGround(s, kicker.x + 0.1, kicker.y, 70, 30, 12, kicker.index);
  s.ball.touchTick = s.tick;
  engine.step(1);
  assert.equal(s.ball.owner, -1);
  assert.equal(s.ball.lastTouch, kicker.index);
  assert.ok(s.ball.vx > 8, 'still travelling at pace');
});

test('with two defenders in line the nearer one takes the ball', () => {
  const { engine, s, kicker, d1, d2 } = setup();
  park(d1, 52);
  park(d2, 46);
  launchGround(s, kicker.x, kicker.y, 70, 30, 20, kicker.index);
  s.ball.touchTick = s.tick;
  for (let t = 0; t < 25 && s.ball.lastTouch === kicker.index && s.ball.owner < 0; t++) engine.step(1);
  assert.ok(s.ball.owner === d2.index || s.ball.lastTouch === d2.index, `nearer defender (index ${d2.index}) touched it, got ${s.ball.lastTouch}`);
});

test('body blocks are deterministic: the same set-up twice gives the same ball', () => {
  const play = () => {
    const { engine, s, kicker, d1 } = setup();
    park(d1, 48, 30.2);
    launchGround(s, kicker.x, kicker.y, 70, 30, 18, kicker.index);
    s.ball.touchTick = s.tick;
    const trace = [];
    for (let t = 0; t < 30; t++) {
      engine.step(1);
      trace.push([s.ball.x, s.ball.y, s.ball.z, s.ball.owner]);
    }
    return trace;
  };
  assert.deepEqual(play(), play());
});

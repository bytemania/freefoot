import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import {
  launchGround, launchLofted, launchProjectile, computeBallKinematics, ballHeightBand, updateBall, sweptContests, makeContestList,
  BALL_IN_PLAY, BALL_TOUCHLINE, BALL_GOAL_LINE, BALL_GOAL,
} from '../../src/engine/ball/BallPhysics.js';
import { config, sampleInput } from './helpers.js';

/** An engine with every player parked far from the action (y = 2), kicker is home player 9. */
function setup() {
  const engine = MatchEngine.create(sampleInput(1), config);
  const s = engine.state;
  for (const p of s.players) {
    p.x = p.prevX = 52;
    p.y = p.prevY = 2;
  }
  s.tick = 100;
  return s;
}

/**
 * Runs the ball tick by tick and returns the ticks (offsets from launch) at which `index` could contest it.
 * @param {any} s
 * @param {number} index
 * @param {number} [maxTicks]
 */
function contestTicks(s, index, maxTicks = 200) {
  const out = makeContestList();
  /** @type {{t: number, h: number, x: number, y: number}[]} */
  const hits = [];
  for (let t = 1; t <= maxTicks; t++) {
    s.tick++;
    updateBall(s, s.k.dt);
    sweptContests(s, out);
    for (let i = 0; i < out.count; i++) if (out.player[i] === index) hits.push({ t, h: out.height[i], x: out.x[i], y: out.y[i] });
    if (s.ballStatus.code !== BALL_IN_PLAY) break;
  }
  return hits;
}

test('a 30 m/s ground pass past a defender standing on its path is contested (no tunnelling)', () => {
  const s = setup();
  const defender = s.players[18 + 4];
  defender.x = 40.4;
  defender.y = 34.3;
  launchGround(s, 30, 34, 60, 34, 30, 9);
  const hits = contestTicks(s, defender.index, 40);
  assert.ok(hits.length >= 1, 'the defender must get a chance to contest');
  assert.ok(Math.abs(hits[0].x - 40.4) < 1.6, `contact point near the defender, got ${hits[0].x}`);
});

test('a defender well off the path, and the kicker\'s own team, do not contest', () => {
  const s = setup();
  s.players[18 + 4].x = 40;
  s.players[18 + 4].y = 38; // 4 m off the path
  const mate = s.players[8];
  mate.x = 40;
  mate.y = 34;
  launchGround(s, 30, 34, 60, 34, 30, 9);
  assert.equal(contestTicks(s, 22, 40).length, 0);
  const s2 = setup();
  const mate2 = s2.players[8];
  mate2.x = 40;
  mate2.y = 34;
  launchGround(s2, 30, 34, 60, 34, 30, 9);
  assert.equal(contestTicks(s2, 8, 40).length, 0);
});

test('a lofted cross over a defender is contested only where heightAt is under reach', () => {
  const s = setup();
  launchLofted(s, 20, 34, 40, 34, 20, 4, 9); // 20 m at 20 m/s: 20 ticks, peak 4 m
  const mid = s.players[18 + 3];
  mid.x = 30;
  mid.y = 34;
  const nearLaunch = s.players[18 + 5];
  nearLaunch.x = 21;
  nearLaunch.y = 34;
  const nearLanding = s.players[18 + 6];
  nearLanding.x = 39;
  nearLanding.y = 34;
  const out = makeContestList();
  /** @type {Record<number, number>} */
  const seen = {};
  for (let t = 0; t < 22; t++) {
    s.tick++;
    updateBall(s, s.k.dt);
    sweptContests(s, out);
    for (let i = 0; i < out.count; i++) seen[out.player[i]] = Math.max(seen[out.player[i]] ?? 0, 1);
  }
  assert.equal(seen[mid.index], undefined, 'the ball is about 4 m up over the midfielder');
  assert.equal(seen[nearLaunch.index], 1, 'low near the launch');
  assert.equal(seen[nearLanding.index], 1, 'low near the landing');
});

test('heightAt over the flight matches the parabola, and the ball lands and rolls on', () => {
  const s = setup();
  launchLofted(s, 20, 34, 40, 34, 20, 4, 9);
  assert.equal(s.ball.flight?.flightTicks, 20);
  for (let t = 1; t <= 10; t++) {
    s.tick++;
    updateBall(s, s.k.dt);
  }
  assert.equal(s.ball.height, 4); // halfway: 4 * 4 * 0.5 * 0.5
  assert.ok(Math.abs(s.ball.x - 30) < 1e-9);
  for (let t = 1; t <= 10; t++) {
    s.tick++;
    updateBall(s, s.k.dt);
  }
  assert.equal(s.ball.flight, null);
  assert.equal(s.ball.x, 40);
  assert.ok(Math.abs(s.ball.vx - 20 * 0.3) < 1e-9, 'keeps the landingKeep fraction of its horizontal speed');
});

test('a rolling ball slows down and stops', () => {
  const s = setup();
  launchGround(s, 30, 34, 60, 34, 10, 9);
  let prev = 10;
  for (let t = 0; t < 400; t++) {
    s.tick++;
    updateBall(s, s.k.dt);
    const v = Math.hypot(s.ball.vx, s.ball.vy);
    assert.ok(v <= prev + 1e-12);
    prev = v;
  }
  assert.equal(prev, 0);
  assert.ok(s.ball.x > 30 && s.ball.x < 60);
});

test('out of play: touchline, goal line, and goal between the posts under the bar', () => {
  /** @param {(s: any) => void} launch */
  const run = (launch) => {
    const s = setup();
    launch(s);
    for (let t = 0; t < 300 && s.ballStatus.code === BALL_IN_PLAY; t++) {
      s.tick++;
      updateBall(s, s.k.dt);
    }
    return s;
  };
  const touch = run((s) => launchGround(s, 50, 60, 50, 80, 12, 9));
  assert.equal(touch.ballStatus.code, BALL_TOUCHLINE);
  assert.equal(touch.ballStatus.side, 1);
  assert.equal(touch.ball.y, 68);

  const wide = run((s) => launchGround(s, 90, 34, 110, 50, 20, 9));
  assert.equal(wide.ballStatus.code, BALL_GOAL_LINE);
  assert.equal(wide.ballStatus.side, 1);

  const goal = run((s) => launchGround(s, 90, 34, 110, 35, 20, 9));
  assert.equal(goal.ballStatus.code, BALL_GOAL);
  assert.equal(goal.ballStatus.side, 1);
  assert.equal(goal.ball.x, 105);
  assert.equal(goal.ball.vx, 0);

  const ownEnd = run((s) => launchGround(s, 10, 34, -10, 33, 20, 9));
  assert.equal(ownEnd.ballStatus.code, BALL_GOAL);
  assert.equal(ownEnd.ballStatus.side, 0);

  const over = run((s) => launchLofted(s, 90, 34, 112, 34, 20, 12, 9)); // 12 m peak, still high at the line
  assert.equal(over.ballStatus.code, BALL_GOAL_LINE);
});

test('a carried ball sits on its owner', () => {
  const s = setup();
  s.players[9].x = 33;
  s.players[9].y = 12;
  s.ball.owner = 9;
  s.tick++;
  updateBall(s, s.k.dt);
  assert.deepEqual([s.ball.x, s.ball.y, s.ball.vx, s.ball.vy, s.ball.z, s.ball.vz], [33, 12, 0, 0, 0, 0]);
});

test('3D projectile integration tracks continuous z/vz with dipped free kick clearing 9.15m wall and dipping under 2.44m bar', () => {
  const s = setup();
  const accelZ = s.k.weights.ball.gravity + s.k.weights.setPieces.fkDipAccel;
  const kin = computeBallKinematics(22, 0.12, 1.85, 25, accelZ);
  launchProjectile(s, 83, 34, 105, 34, 25, kin.vz0, s.k.weights.setPieces.fkDipAccel, 9, 0.12);

  let zAtWall = 0;
  for (let t = 0; t < 30 && s.ballStatus.code === BALL_IN_PLAY; t++) {
    s.tick++;
    updateBall(s, s.k.dt);
    if (s.ball.x >= 92.15 && zAtWall === 0) zAtWall = s.ball.z;
  }
  assert.ok(zAtWall > 2.2, `expected dipped FK to clear 9.15m wall, got z=${zAtWall.toFixed(2)}`);
  assert.ok(s.ball.maxZ <= 3.5 && s.ballStatus.code === BALL_GOAL, 'dipped FK should finish under the 2.44m crossbar');
  assert.equal(ballHeightBand(0.1), 'GROUND');
  assert.equal(ballHeightBand(0.6), 'LOW');
  assert.equal(ballHeightBand(1.2), 'WAIST');
  assert.equal(ballHeightBand(2.0), 'HEAD');
  assert.equal(ballHeightBand(3.0), 'HIGH');
  assert.equal(ballHeightBand(3.0, true), 'OVER_BAR');
});

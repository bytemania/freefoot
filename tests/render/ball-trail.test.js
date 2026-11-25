// The ball on shots and goals (src/render/ballTrail.js, src/ui/pitchAnimations.js `goalBallAt`): a fast ball draws a
// short motion trail (cleared on dead balls and time jumps); a goal's ball flies from the strike into the net and
// rests there through the celebration, so it never vanishes before the kick-off reset (the engine resolves a shot at
// the strike: on the engine's pitch the ball never travels to the goal).
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { BallTrail } from '../../src/render/ballTrail.js';
import { ANIM_MS, NET_DEPTH, goalBallAt, goalBallTrail } from '../../src/ui/pitchAnimations.js';
import { cuesForEvents } from '../../src/runtime/animationCues.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { SNAP_BALL } from '../../src/engine/MatchEngine.js';
import { generateSquad } from '../../src/shared/squadgen.js';

const FPS = 60;

test('the trail: none for a slow ball, a fading streak behind a fast one, cleared on a dead ball, a seek or a teleport', () => {
  const trail = new BallTrail();
  // A slow pass, 6 m/s.
  for (let f = 0; f < 30; f++) trail.push(f / FPS, 50 + (6 * f) / FPS, 30, 0);
  assert.equal(trail.trail().strength, 0);
  assert.deepEqual(trail.trail().points, []);
  // A shot, 28 m/s.
  trail.reset();
  for (let f = 0; f < 30; f++) trail.push(1 + f / FPS, 70 + (28 * f) / FPS, 30, 0.5);
  const t = trail.trail();
  assert.equal(t.strength, 1);
  assert.ok(t.points.length >= 10, `${t.points.length} trail points`);
  // Newest first, fading with age, all behind the ball and within the last 0.22 s.
  const ballX = 70 + (28 * 29) / FPS;
  for (let i = 0; i < t.points.length; i++) {
    assert.ok(t.points[i].x < ballX && ballX - t.points[i].x <= 28 * 0.23, `point ${i} behind the ball`);
    if (i > 0) assert.ok(t.points[i].age >= t.points[i - 1].age && t.points[i].x < t.points[i - 1].x);
  }
  // The same frame drawn again (paused) changes nothing.
  trail.push(1 + 29 / FPS, ballX, 30, 0.5);
  assert.equal(trail.trail().points.length, t.points.length);
  // A dead ball (placed for the restart) clears it.
  trail.push(2, ballX, 30, 0, false);
  assert.deepEqual(trail.trail().points, []);
  // Time going back (a replay or seek) clears it.
  for (let f = 0; f < 10; f++) trail.push(3 + f / FPS, 40 + (30 * f) / FPS, 20, 0);
  assert.ok(trail.trail().points.length > 0);
  trail.push(1, 40, 20, 0);
  assert.deepEqual(trail.trail().points, []);
  // A jump further than a shot could go (a kick-off reset) restarts it there.
  for (let f = 0; f < 10; f++) trail.push(5 + f / FPS, 40 + (30 * f) / FPS, 20, 0);
  trail.push(5 + 10 / FPS, 100, 60, 0);
  assert.deepEqual(trail.trail().points, []);
  // A saved shot (the ball in the keeper's hands the next tick: a 20 m jump) draws its streak.
  trail.reset();
  trail.push(7, 80, 34, 0.3);
  trail.push(7 + 1 / 20, 100, 36, 0.3);
  assert.equal(trail.trail().strength, 1);
  assert.equal(trail.trail().points.length, 1);
});

/** A goal cue for a 20 m shot into the top-right of the x = 105 goal. */
function shotGoal() {
  const pre = new Float64Array(11 + 12 * 36);
  pre[SNAP_BALL] = pre[SNAP_BALL + 2] = 85;
  pre[SNAP_BALL + 1] = pre[SNAP_BALL + 3] = 30;
  const events = [
    { type: 'SHOT', tick: 900, actorIndex: 9, teamIndex: 0, x: 85, y: 30, secondaryIndices: [], meta: { result: 'ON_TARGET', goalY: 2.5, goalZ: 1.8, vShot: 26 } },
    { type: 'GOAL', tick: 900, actorIndex: 9, teamIndex: 0, x: 85, y: 30, secondaryIndices: [], meta: { kind: 'OPEN_PLAY', z: 1.8 } },
  ];
  return /** @type {any} */ (cuesForEvents(/** @type {any} */ (events), pre)[0]);
}

test('a goal: the ball flies from the strike to the goal line at the shot speed, into the net, and rests there', () => {
  const cue = shotGoal();
  assert.deepEqual(cue.ball, { fromX: 85, fromY: 30, fromZ: 0, lineX: 105, lineY: 36.5, lineZ: 1.8, speed: 26 });
  const start = goalBallAt(cue, 0);
  assert.deepEqual([start.x, start.y, start.phase], [85, 30, 'flight']);
  // 20.4 m at 26 m/s: on the line about 0.79 s of match time later, drawn in at most 650 ms.
  let crossed = -1;
  let prevX = -Infinity;
  for (let ms = 0; ms <= ANIM_MS.GOAL; ms += 10) {
    const p = goalBallAt(cue, ms);
    assert.ok(p.x >= prevX - 1e-9, `${ms} ms: the ball only moves toward the goal`);
    prevX = p.x;
    if (crossed < 0 && p.x >= 105) crossed = ms;
    assert.ok(p.x <= 105 + NET_DEPTH + 1e-9, 'never through the back of the net');
  }
  assert.ok(crossed > 0 && crossed <= 660, `over the line after ${crossed} ms`);
  // In the net well before the celebration ends (the kick-off reset), at rest on the ground, inside the posts.
  for (const ms of [crossed + 500, ANIM_MS.GOAL * 0.75, ANIM_MS.GOAL - 1]) {
    const p = goalBallAt(cue, ms);
    assert.equal(p.phase, 'rest');
    assert.ok(Math.abs(p.x - (105 + NET_DEPTH)) < 1e-9 && Math.abs(p.y - 34) <= 3.4 && p.h === 0, `${ms} ms: in the net (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  }
  // A fast trail behind it in flight, none at rest.
  const mid = goalBallAt(cue, crossed / 2);
  assert.ok(mid.speed > 20);
  const tr = goalBallTrail(cue, crossed / 2);
  assert.ok(tr.length >= 4 && tr.every((q) => q.x < mid.x), 'the trail is behind the ball');
  assert.deepEqual(goalBallTrail(cue, ANIM_MS.GOAL - 1), []);
});

test('a goal at the x = 0 end and a ball that crossed the line on its own (no shot) fly into the right net', () => {
  const pre = new Float64Array(11 + 12 * 36);
  pre[SNAP_BALL] = 2.4;
  pre[SNAP_BALL + 2] = 1.2; // 1.2 m in a tick: 24 m/s toward x = 0
  pre[SNAP_BALL + 1] = pre[SNAP_BALL + 3] = 33;
  const cue = /** @type {any} */ (cuesForEvents(/** @type {any} */ ([{ type: 'GOAL', tick: 50, actorIndex: 20, teamIndex: 1, x: 0, y: 33.2, secondaryIndices: [], meta: { kind: 'OWN_GOAL', z: 0 } }]), pre)[0]);
  assert.equal(cue.ball.lineX, 0);
  assert.equal(cue.ball.lineY, 33.2);
  assert.ok(Math.abs(cue.ball.speed - 24) < 1e-9);
  const rest = goalBallAt(cue, ANIM_MS.GOAL - 1);
  assert.ok(Math.abs(rest.x + NET_DEPTH) < 1e-9 && rest.phase === 'rest');
});

test('a real goal: its cue carries the strike and the point it crossed the line, inside the goal mouth', () => {
  const seed = 5;
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  const ctrl = new MatchController({ input: { v: 1, seed, configHash, home, away }, config, mode: 'full', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  ctrl.setSpeed(8);
  /** @type {any} */
  let cue = null;
  for (let i = 0; i < 300000 && cue === null && ctrl.playbackState !== 'FULL_TIME'; i++) {
    if (ctrl.playbackState === 'HALF_TIME' || ctrl.playbackState === 'PAUSED_FORCED') ctrl.continue();
    const f = ctrl.tickFrame(1 / 60);
    cue = f.animations.find((/** @type {any} */ a) => a.kind === 'GOAL') ?? null;
  }
  assert.ok(cue, 'a goal was scored');
  assert.ok(cue.ball.lineX === 0 || cue.ball.lineX === 105);
  assert.ok(Math.abs(cue.ball.lineY - 34) <= 3.66, `crossed at y ${cue.ball.lineY.toFixed(2)}`);
  assert.ok(Math.hypot(cue.ball.fromX - cue.x, cue.ball.fromY - cue.y) < 3, 'from the scorer\'s feet');
  const end = goalBallAt(cue, ANIM_MS.GOAL - 1);
  assert.ok(end.phase === 'rest' && Math.abs(end.y - 34) <= 3.4);
  ctrl.destroy();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { SNAP_LEN, SNAP_PLAYERS, SNAP_PLAYER_STRIDE } from '../../src/engine/MatchEngine.js';
import { ANIMATION_HOLD_SECONDS, AUTO_FAST_SPEED, MatchController, isSetPieceSetup } from '../../src/runtime/MatchController.js';
import {
  ANIM_MS, CELEBRATION_RADIUS, PitchAnimations, TUNNEL, celebrationCorner, celebrationPositions, cuesForEvents, entryPosition, exitPosition, snapPlayer,
} from '../../src/ui/pitchAnimations.js';
import { generateSquad } from '../../src/shared/squadgen.js';

function makeInput(seed = 5) {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'human' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return { v: /** @type {const} */ (1), seed, configHash, home, away };
}

/** @param {any} [mode] */
function controller(mode = 'full') {
  return new MatchController({ input: makeInput(), config, mode, schedule: () => 1, cancelSchedule: () => {} });
}

/**
 * A snapshot with the given players on the pitch at the given spots.
 * @param {Record<number, [number, number]>} at
 */
function snapshotWith(at) {
  const snap = new Float64Array(SNAP_LEN);
  for (const [i, [x, y]] of Object.entries(at)) {
    const o = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * Number(i);
    snap[o] = snap[o + 2] = x;
    snap[o + 1] = snap[o + 3] = y;
    snap[o + 4] = 1;
    snap[o + 5] = Number(i) < 18 ? 0 : 1;
  }
  return snap;
}

const ev = (/** @type {Record<string, any>} */ e) => /** @type {any} */ ({ secondaryIndices: [], meta: {}, x: 50, y: 30, tick: 100, teamIndex: 0, ...e });

test('cuesForEvents: a goal (with the pre-goal snapshot), a red card and a substitution each get an animation cue', () => {
  const pre = snapshotWith({ 9: [96, 30] });
  const cues = cuesForEvents(
    [
      ev({ type: 'SHOT', actorIndex: 9 }),
      ev({ type: 'GOAL', actorIndex: 9, x: 105, y: 33, meta: { kind: 'OPEN_PLAY' } }),
      ev({ type: 'RED_CARD', actorIndex: 22, teamIndex: 1, x: 40, y: 20 }),
      ev({ type: 'SUBSTITUTION', actorIndex: 7, secondaryIndices: [13], x: 60, y: 10 }),
      ev({ type: 'PASS', actorIndex: 3 }),
    ],
    pre,
  );
  assert.deepEqual(cues.map((c) => c.kind), ['GOAL', 'RED_CARD', 'SUBSTITUTION']);
  const goal = /** @type {any} */ (cues[0]);
  assert.equal(goal.actor, 9);
  assert.equal(goal.team, 0);
  assert.ok(goal.snapshot && goal.snapshot !== pre, 'a copy of the pre-goal positions');
  assert.equal(snapPlayer(goal.snapshot, 9).x, 96);
  assert.deepEqual([/** @type {any} */ (cues[2]).actor, /** @type {any} */ (cues[2]).incoming], [7, 13]);
  // An own goal celebrates for the other team, with no "scorer".
  const og = /** @type {any} */ (cuesForEvents([ev({ type: 'GOAL', actorIndex: 20, teamIndex: 1, meta: { kind: 'OWN_GOAL' } })], pre)[0]);
  assert.deepEqual([og.team, og.actor], [0, -1]);
});

test('celebration: the scorer runs to the corner flag and nearby team-mates converge on them; far players stay put', () => {
  // Home scored at the x = 105 end; scorer at (96, 30), two team-mates near, one far back, an opponent near.
  const snap = snapshotWith({ 9: [96, 30], 10: [90, 40], 8: [85, 20], 2: [30, 30], 20: [97, 32] });
  const cue = /** @type {any} */ (cuesForEvents([ev({ type: 'GOAL', actorIndex: 9, x: 105, y: 33, meta: { kind: 'OPEN_PLAY' } })], snap)[0]);
  const corner = celebrationCorner(cue, { x: 96, y: 30 });
  assert.deepEqual(corner, { x: 103.5, y: 1.5 });
  const start = celebrationPositions(cue, snap, 0);
  const end = celebrationPositions(cue, snap, 1);
  assert.deepEqual(start.get(9), { x: 96, y: 30 });
  const s = /** @type {{x: number, y: number}} */ (end.get(9));
  assert.ok(Math.hypot(s.x - corner.x, s.y - corner.y) < 4, `the scorer reaches the flag (${s.x.toFixed(1)}, ${s.y.toFixed(1)})`);
  for (const mate of [10, 8]) {
    const m = /** @type {{x: number, y: number}} */ (end.get(mate));
    assert.ok(Math.hypot(m.x - s.x, m.y - s.y) < 3, `team-mate ${mate} joins the scorer`);
  }
  assert.equal(end.has(2), false, `a team-mate more than ${CELEBRATION_RADIUS} m away does not`);
  assert.equal(end.has(20), false, 'opponents do not celebrate');
  // Monotonic progress toward the flag.
  let last = Infinity;
  for (let k = 0; k <= 10; k++) {
    const p = /** @type {{x: number, y: number}} */ (celebrationPositions(cue, snap, k / 10).get(9));
    const d = Math.hypot(p.x - corner.x, p.y - corner.y);
    assert.ok(d <= last + 1e-9);
    last = d;
  }
});

test('exit and entry paths: the sent-off or substituted player walks to the tunnel; the substitute comes on from it', () => {
  assert.deepEqual(exitPosition({ x: 30, y: 50 }, 0), { x: 30, y: 50 });
  const out = exitPosition({ x: 30, y: 50 }, 1);
  assert.ok(Math.abs(out.x - TUNNEL.x) < 1e-9 && out.y < 0, 'off the pitch at the halfway touchline');
  const inStart = entryPosition({ x: 70, y: 40 }, 0);
  assert.ok(Math.abs(inStart.x - TUNNEL.x) < 1e-9 && inStart.y < 0);
  assert.deepEqual(entryPosition({ x: 70, y: 40 }, 1), { x: 70, y: 40 });
});

test('PitchAnimations plays each cue for its fixed time; a new goal replaces a running celebration', () => {
  let now = 1000;
  const anims = new PitchAnimations(() => now);
  const snap = snapshotWith({ 9: [96, 30] });
  anims.ingest(cuesForEvents([ev({ type: 'GOAL', actorIndex: 9, meta: { kind: 'OPEN_PLAY' } }), ev({ type: 'SUBSTITUTION', actorIndex: 7, secondaryIndices: [13] })], snap));
  assert.equal(anims.busy, true);
  now += ANIM_MS.SUBSTITUTION / 2;
  const mid = anims.active();
  assert.deepEqual(mid.map((a) => a.cue.kind), ['GOAL', 'SUBSTITUTION']);
  assert.ok(Math.abs(/** @type {number} */ (mid.find((a) => a.cue.kind === 'SUBSTITUTION')?.progress) - 0.5) < 1e-9);
  anims.ingest(cuesForEvents([ev({ type: 'GOAL', actorIndex: 10, meta: { kind: 'OPEN_PLAY' } })], snap));
  assert.equal(anims.active().filter((a) => a.cue.kind === 'GOAL').length, 1);
  now += ANIM_MS.GOAL + 1;
  assert.deepEqual(anims.active(), []);
  assert.equal(anims.busy, false);
});

for (const [type, extra] of /** @type {[string, Record<string, any>][]} */ ([
  ['GOAL', { actorIndex: 9, meta: { kind: 'OPEN_PLAY' } }],
  ['RED_CARD', { actorIndex: 22, teamIndex: 1, meta: { secondYellow: false } }],
  ['SUBSTITUTION', { actorIndex: 7, secondaryIndices: [13] }],
])) {
  test(`a ${type} holds live playback still while its animation plays, then play resumes`, () => {
    const ctrl = controller('full');
    ctrl.play();
    const pre = ctrl.snapshot.slice();
    let calls = 0;
    ctrl.engine.step = () => {
      calls++;
      return { ticksRun: 1, events: calls === 1 ? [ev({ type, tick: 1, ...extra })] : [], stoppedFor: null };
    };
    // A 4x frame budgets several ticks: the batch stops on the event.
    ctrl.setSpeed(4);
    const frame = ctrl.tickFrame(1 / 20);
    assert.equal(calls, 1, 'the batch ends on the animated event');
    assert.equal(frame.animations.length, 1);
    assert.equal(frame.animations[0].kind, type);
    if (type === 'GOAL') assert.deepEqual([.../** @type {any} */ (frame.animations[0]).snapshot], [...pre], 'the celebration draws the pre-goal positions');
    const hold = /** @type {Record<string, number>} */ (ANIMATION_HOLD_SECONDS)[type];
    assert.equal(ctrl.animationHold, hold);
    // While the hold lasts no tick runs, at any speed.
    let frames = 0;
    while (ctrl.animationHold > 0 && frames++ < 1000) {
      const f = ctrl.tickFrame(1 / 60);
      assert.equal(f.newEvents.length, 0);
    }
    assert.equal(calls, 1);
    assert.ok(Math.abs(frames - hold * 60) <= 1, `held for ${frames} frames (${hold} s)`);
    ctrl.tickFrame(1 / 20);
    assert.ok(calls > 1, 'play resumes after the animation');
    ctrl.destroy();
  });
}

test('Auto Highlights holds the goal celebration at 1x; Best Moments and the debug viewer never hold', () => {
  const ctrl = controller('auto_highlights');
  ctrl.play();
  assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED);
  let calls = 0;
  ctrl.engine.step = () => {
    calls++;
    return { ticksRun: 1, events: calls === 3 ? [ev({ type: 'GOAL', actorIndex: 9, meta: { kind: 'OPEN_PLAY' } })] : [], stoppedFor: null };
  };
  ctrl.tickFrame(1 / 60);
  assert.equal(calls, 3);
  assert.equal(ctrl.animationHold, ANIMATION_HOLD_SECONDS.GOAL);
  assert.equal(ctrl.getEffectiveSpeed(), 1);
  assert.equal(ctrl.tickFrame(1 / 60).autoPacing, 'WATCH');
  ctrl.destroy();

  const dbg = controller('debug');
  dbg.engine.step = () => ({ ticksRun: 1, events: [ev({ type: 'GOAL', actorIndex: 9, meta: { kind: 'OPEN_PLAY' } })], stoppedFor: null });
  const f = dbg.stepTicks(1);
  assert.equal(f.animations[0].kind, 'GOAL', 'the debug viewer still animates');
  assert.equal(dbg.animationHold, 0);
  dbg.destroy();
});

test('a substitution made at once at a stoppage animates; while paused nothing is held', () => {
  const ctrl = controller('full');
  const s = ctrl.engine.state;
  assert.equal(s.restart.state, 'DEAD_BALL');
  /** @type {any[]} */
  const frames = [];
  ctrl.onFrame = (fr) => frames.push(fr);
  const res = ctrl.queueCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: 7, inIndex: 13 } });
  assert.equal(res.ok, true);
  const last = frames.at(-1);
  assert.deepEqual(last.animations.map((/** @type {any} */ c) => [c.kind, c.actor, c.incoming]), [['SUBSTITUTION', 7, 13]]);
  assert.equal(ctrl.animationHold, 0, 'paused: no hold');
  // The pitch and bench lists update on the same call.
  assert.equal(s.players[7].onPitch, 0);
  assert.equal(s.players[13].onPitch, 1);
  assert.ok(s.onPitchList.includes(13) && !s.onPitchList.includes(7));
  // Playing at a dead ball: the substitution holds play for its animation.
  ctrl.play();
  ctrl.queueCommand({ issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: 8, inIndex: 14 } });
  assert.equal(ctrl.animationHold, ANIMATION_HOLD_SECONDS.SUBSTITUTION);
  ctrl.destroy();
});

test('set pieces being set up play at 1x in Auto Highlights: corners, penalties and attacking-half free kicks', () => {
  const ctrl = controller('auto_highlights');
  const s = ctrl.engine.state;
  s.restart.state = 'DEAD_BALL';
  for (const kind of ['CORNER', 'PENALTY']) {
    s.restart.kind = kind;
    assert.equal(isSetPieceSetup(s), true, kind);
  }
  s.restart.kind = 'FREE_KICK';
  s.restart.teamIndex = 0; // home attacks x = 105 in the first half
  s.restart.x = 70;
  assert.equal(isSetPieceSetup(s), true, 'attacking-half free kick');
  s.restart.x = 30;
  assert.equal(isSetPieceSetup(s), false, 'own-half free kick');
  for (const kind of ['THROW_IN', 'GOAL_KICK', 'KICK_OFF']) {
    s.restart.kind = kind;
    assert.equal(isSetPieceSetup(s), false, kind);
  }
  s.restart.state = 'IN_PLAY';
  s.restart.kind = 'CORNER';
  assert.equal(isSetPieceSetup(s), false, 'only before the kick');

  // The 60x batch stops on the tick a corner is awarded, and the setup plays live.
  ctrl.play();
  s.ball.x = 52.5;
  s.ball.owner = -1;
  s.ball.pass = null;
  assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED);
  let calls = 0;
  ctrl.engine.step = () => {
    calls++;
    if (calls === 4) {
      s.restart.state = 'DEAD_BALL';
      s.restart.kind = 'CORNER';
    }
    return { ticksRun: 1, events: [], stoppedFor: null };
  };
  const frame = ctrl.tickFrame(1 / 60);
  assert.equal(calls, 4);
  assert.equal(frame.autoPacing, 'WATCH');
  assert.equal(frame.restart.kind, 'CORNER', 'the frame tells the pitch which set piece to draw');
  assert.equal(ctrl.getEffectiveSpeed(), 1);
  ctrl.destroy();
});

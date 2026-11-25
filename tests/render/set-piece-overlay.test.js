// The yellow set-piece overlay (the 9.15 m ring round a free kick or corner, the penalty box and arc) follows the
// restart of the frame on screen (src/ui/pitchAnimations.js `setPieceOverlay`, drawn by PitchCanvasView): only while
// that stoppage is on, gone the frame play resumes, and in a replay or an Auto Highlights pre-roll taken from the
// recorded frame (runtime/RenderRing.js keeps each frame's restart), never read ahead from the live engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { MatchController } from '../../src/runtime/MatchController.js';
import { RenderRing } from '../../src/runtime/RenderRing.js';
import { SNAP_LEN, FLAG_DEAD_BALL } from '../../src/engine/MatchEngine.js';
import { setPieceOverlay } from '../../src/ui/pitchAnimations.js';
import { generateSquad } from '../../src/shared/squadgen.js';

/** @param {number} seed */
function makeInput(seed) {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'ai' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return { v: /** @type {const} */ (1), seed, configHash, home, away };
}

/** @param {any} r */
const isSetPiece = (r) => r.state === 'DEAD_BALL' && (r.kind === 'FREE_KICK' || r.kind === 'CORNER' || r.kind === 'PENALTY');

test('setPieceOverlay: a ring for a free kick or corner, the box for a penalty, only at a dead ball', () => {
  assert.deepEqual(setPieceOverlay({ state: 'DEAD_BALL', kind: 'FREE_KICK', x: 70, y: 20 }), { kind: 'RING', x: 70, y: 20, top: true });
  assert.deepEqual(setPieceOverlay({ state: 'DEAD_BALL', kind: 'CORNER', x: 0, y: 68 }), { kind: 'RING', x: 0, y: 68, top: false });
  assert.deepEqual(setPieceOverlay({ state: 'DEAD_BALL', kind: 'PENALTY', x: 94, y: 34 }), { kind: 'PENALTY', x: 94, y: 34, top: true });
  for (const kind of ['FREE_KICK', 'CORNER', 'PENALTY']) assert.equal(setPieceOverlay({ state: 'IN_PLAY', kind, x: 70, y: 20 }), null, `${kind} once play resumes`);
  for (const kind of ['KICK_OFF', 'THROW_IN', 'GOAL_KICK', 'DROP_BALL']) assert.equal(setPieceOverlay({ state: 'DEAD_BALL', kind, x: 50, y: 0 }), null, kind);
  assert.equal(setPieceOverlay(null), null);
});

test('the RenderRing keeps each frame\'s restart and carrier; an unknown frame falls back to the snapshot flag', () => {
  const ring = new RenderRing(4);
  const snap = new Float64Array(SNAP_LEN);
  const state = (/** @type {string} */ st, /** @type {string} */ kind, /** @type {number} */ owner) => ({ restart: { state: st, kind, teamIndex: 1, x: 80, y: 10, direct: true, taker: 22 }, ball: { owner } });
  ring.push(snap, 10, 0, 0, state('IN_PLAY', 'FREE_KICK', 7));
  ring.push(snap, 11, 0, 0, state('DEAD_BALL', 'CORNER', -1));
  assert.deepEqual(ring.viewAt(10).restart.state, 'IN_PLAY');
  assert.equal(ring.viewAt(10).owner, 7);
  assert.deepEqual(ring.viewAt(11), { restart: { state: 'DEAD_BALL', kind: 'CORNER', teamIndex: 1, x: 80, y: 10, direct: true, taker: 22 }, owner: -1 });
  const dead = new Float64Array(SNAP_LEN);
  dead[5] = FLAG_DEAD_BALL;
  assert.deepEqual(ring.viewAt(99, dead).restart.state, 'DEAD_BALL', 'evicted: the dead-ball flag, with no set piece');
  assert.equal(setPieceOverlay(ring.viewAt(99, dead).restart), null);
  ring.clear();
  assert.equal(ring.viewAt(11).restart.state, 'IN_PLAY');
});

test('live play: the overlay shows from the stoppage and clears the frame play resumes; a replay of the build-up shows none; a seek shows the restart of the tick sought', () => {
  const ctrl = new MatchController({ input: makeInput(5), config, mode: 'full', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  ctrl.setSpeed(4);
  /** Frames until `pred`, continuing past half-time. @param {(f: any) => boolean} pred */
  const until = (pred, max = 200000) => {
    for (let i = 0; i < max; i++) {
      if (ctrl.playbackState === 'HALF_TIME' || ctrl.playbackState === 'PAUSED_FORCED') ctrl.continue();
      const f = ctrl.tickFrame(1 / 60);
      if (pred(f)) return f;
      assert.notEqual(ctrl.playbackState, 'FULL_TIME', 'no set piece before full time');
    }
    throw new Error('not reached');
  };
  // Live: the first set piece at least 20 s in (so the replay has some build-up before it).
  const atStop = until((f) => f.tick > 400 && isSetPiece(f.restart) && setPieceOverlay(f.restart) !== null);
  const stopTick = atStop.tick;
  assert.equal(atStop.shownTick, atStop.tick, 'a live frame shows the live tick');
  const over = setPieceOverlay(atStop.restart);
  assert.ok(over && over.x === ctrl.engine.state.restart.x && over.y === ctrl.engine.state.restart.y, 'drawn at the restart spot');
  // Let the stoppage run on for a moment (the players jog into position), still dead.
  for (let i = 0; i < 30 && isSetPiece(ctrl.engine.state.restart); i++) ctrl.tickFrame(1 / 60);
  assert.ok(isSetPiece(ctrl.engine.state.restart), 'still at the set piece');
  // The first frame of the stoppage: earlier frames had play live.
  let firstDead = stopTick;
  while (ctrl.ring.viewAt(firstDead - 1).restart.state === 'DEAD_BALL') firstDead--;

  // Tap-to-replay now, while the live engine still waits on the set piece.
  assert.ok(ctrl.replayLastMoments());
  let before = 0;
  let during = 0;
  for (let i = 0; i < 5000 && ctrl.playbackState === 'REPLAY'; i++) {
    const f = ctrl.tickFrame(1 / 60);
    if (ctrl.playbackState !== 'REPLAY' && f.playbackState !== 'REPLAY') break;
    assert.ok(setPieceOverlay(ctrl.engine.state.restart) !== null, 'the live engine is at the set piece all along');
    const shown = f.shownTick;
    assert.deepEqual(f.restart, ctrl.ring.viewAt(shown, f.renderSnapshot).restart, 'the restart of the frame shown');
    if (shown < firstDead) {
      before++;
      assert.equal(setPieceOverlay(f.restart), null, `replayed tick ${shown}: no overlay before the stoppage (tick ${firstDead})`);
    } else if (isSetPiece(f.restart)) {
      during++;
    }
  }
  assert.ok(before > 100, `the replay showed the build-up (${before} frames)`);
  assert.ok(during > 0, 'and the stoppage, with its overlay');

  // Back live: play resumes and the overlay clears on that very frame.
  const resumed = until((f) => f.playbackState === 'FULL_MATCH' && f.restart.state === 'IN_PLAY');
  assert.equal(setPieceOverlay(resumed.restart), null);

  // A seek back to before the stoppage: the frame shows that tick's restart, with no overlay.
  ctrl.seekToTick(firstDead - 40);
  const seeked = ctrl.buildFrame([]);
  assert.equal(seeked.shownTick, firstDead - 40);
  assert.equal(seeked.restart.state, 'IN_PLAY');
  assert.equal(setPieceOverlay(seeked.restart), null);
  ctrl.destroy();
});

test('an Auto Highlights pre-roll draws each recorded frame with its own restart, not the live engine\'s', () => {
  const ctrl = new MatchController({ input: makeInput(5), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  let preRollFrames = 0;
  let aheadHidden = 0;
  for (let i = 0; i < 400000 && aheadHidden < 60; i++) {
    if (ctrl.playbackState === 'HALF_TIME' || ctrl.playbackState === 'PAUSED_FORCED') {
      ctrl.continue();
      continue;
    }
    if (ctrl.playbackState === 'FULL_TIME') break;
    const f = ctrl.tickFrame(1 / 60);
    if (!f.preRoll) continue;
    preRollFrames++;
    assert.deepEqual(f.restart, ctrl.ring.viewAt(f.shownTick, f.renderSnapshot).restart);
    // The live engine is already past the moment (e.g. at the kick-off dead ball after a goal) while the build-up
    // plays: the frame carries the restart of the recorded tick, not the live one.
    if (ctrl.engine.state.restart.state !== f.restart.state) aheadHidden++;
  }
  assert.ok(preRollFrames > 0, 'a pre-roll played');
  assert.ok(aheadHidden > 0, `the pre-roll drew the recorded restart, not the live one (${aheadHidden} frames)`);
  ctrl.destroy();
});

test('wallLine: the defenders on the wall line of a direct free kick, for either goal; nothing otherwise', async () => {
  const { wallLine } = await import('../../src/ui/pitchAnimations.js');
  const { SNAP_PLAYERS, SNAP_PLAYER_STRIDE } = await import('../../src/engine/MatchEngine.js');
  /** @param {Record<number, [number, number, number?]>} at  index: [x, y, isKeeper] */
  const snapWith = (at) => {
    const snap = new Float64Array(SNAP_LEN);
    for (const [i, [x, y, gk]] of Object.entries(at)) {
      const o = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * Number(i);
      snap[o + 2] = x;
      snap[o + 3] = y;
      snap[o + 4] = 1;
      snap[o + 5] = Number(i) < 18 ? 0 : 1;
      snap[o + 8] = gk ?? 0;
    }
    return snap;
  };
  // Home free kick at (80, 34) toward x = 105: away wall at x = 89.75; an away player elsewhere; the keeper; a home player.
  const fk = { state: 'DEAD_BALL', kind: 'FREE_KICK', direct: true, teamIndex: 0, x: 80, y: 34 };
  const snap = snapWith({ 20: [89.75, 33.25], 21: [89.75, 34], 22: [89.75, 34.75], 23: [70, 20], 18: [104, 35, 1], 9: [89.75, 36] });
  assert.deepEqual(wallLine(fk, snap), { ids: [20, 21, 22], ax: -0, ay: 1 });
  // Away free kick toward x = 0: the home wall.
  const away = { ...fk, teamIndex: 1, x: 25, y: 34 };
  const snap2 = snapWith({ 2: [15.25, 33.6], 3: [15.25, 34.4], 20: [15.25, 35] });
  assert.deepEqual(wallLine(away, snap2)?.ids, [2, 3]);
  // An indirect free kick, a corner, or play resumed: no wall.
  assert.equal(wallLine({ ...fk, direct: false }, snap), null);
  assert.equal(wallLine({ ...fk, kind: 'CORNER' }, snap), null);
  assert.equal(wallLine({ ...fk, state: 'IN_PLAY' }, snap), null);
});

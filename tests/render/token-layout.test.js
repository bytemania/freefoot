// Render-only token layout (src/render/tokenLayout.js, used by the pitch canvas): temporal smoothing
// of the drawn positions and rotation-free decluttering of overlapping tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { TokenLayout } from '../../src/render/tokenLayout.js';
import { config, sampleInput } from '../engine/helpers.js';

const N = 36;
const MIN = 2.5; // minimum centre distance (m): 1.75 token radii at ~1.43 m per radius
const FPS = 60;
const DTF = 1 / FPS;

/** A layout fed one frame per call; positions per slot in metres. */
function harness() {
  const layout = new TokenLayout(N);
  const tx = new Float64Array(N);
  const ty = new Float64Array(N);
  let t = 10;
  return {
    layout,
    tx,
    ty,
    /** @param {number[]} ids @param {{pinned?: number, dt?: number, at?: number}} [o] */
    frame(ids, { pinned = -1, dt = DTF, at } = {}) {
      t = at ?? t + dt;
      layout.update(ids, tx, ty, { simTime: t, wallTime: t, minDist: MIN, pinned });
      return ids.map((i) => [layout.outX[i], layout.outY[i]]);
    },
  };
}

const dist = (/** @type {number[]} */ a, /** @type {number[]} */ b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

test('two players at nearly the same spot separate cleanly, symmetrically, and stay so', () => {
  const h = harness();
  h.tx[0] = 50;
  h.ty[0] = 30;
  h.tx[1] = 50.1;
  h.ty[1] = 30.05; // 0.11 m apart
  let out = h.frame([0, 1]);
  for (let f = 0; f < 30; f++) out = h.frame([0, 1]);
  assert.ok(dist(out[0], out[1]) >= MIN - 1e-6, `centres ${dist(out[0], out[1]).toFixed(3)} m apart`);
  const mid = [(out[0][0] + out[1][0]) / 2, (out[0][1] + out[1][1]) / 2];
  assert.ok(Math.abs(mid[0] - 50.05) < 1e-9 && Math.abs(mid[1] - 30.025) < 1e-9, 'both move, the pair stays centred');

  // Exactly coincident: split across the pitch (+y = drawn to the right), the higher slot on the +y side.
  const c = harness();
  c.tx[3] = c.tx[7] = 60;
  c.ty[3] = c.ty[7] = 20;
  const first = c.frame([3, 7]);
  assert.ok(dist(first[0], first[1]) >= MIN - 1e-6, 'separated from the first frame');
  assert.ok(first[0][1] < first[1][1] && first[0][0] === first[1][0], 'split along y, lower slot first');

  // A pinned ball carrier does not move; the other token takes the whole push.
  const p = harness();
  p.tx[0] = 40;
  p.ty[0] = 30;
  p.tx[1] = 40.4;
  p.ty[1] = 30.2;
  let po = p.frame([0, 1], { pinned: 0 });
  for (let f = 0; f < 30; f++) po = p.frame([0, 1], { pinned: 0 });
  assert.deepEqual(po[0], [40, 30], 'the carrier stays at the ball');
  assert.ok(dist(po[0], po[1]) >= MIN - 1e-6);
});

test('a crowded goalmouth scramble untangles; a far player is untouched', () => {
  const h = harness();
  const spots = [
    [100, 30],
    [100.2, 30.1],
    [99.9, 29.8],
    [100.1, 30.3],
    [100.3, 29.9],
    [80, 10],
  ];
  spots.forEach(([x, y], i) => {
    h.tx[i] = x;
    h.ty[i] = y;
  });
  const ids = [0, 1, 2, 3, 4, 5];
  let out = h.frame(ids);
  for (let f = 0; f < 30; f++) out = h.frame(ids);
  let worst = Infinity;
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) worst = Math.min(worst, dist(out[i], out[j]));
  assert.ok(worst >= MIN * 0.75, `the scramble is legible: closest centres ${worst.toFixed(2)} m (min ${MIN})`);
  assert.deepEqual(out[5], [80, 10], 'a far player is untouched');
});

/**
 * Runs player 1 past a standing player 0 along +x at `speed`, `lateral` metres to the side, and
 * returns the drawn positions frame by frame.
 * @param {number} lateral
 * @param {number} [speed]
 */
function passBy(lateral, speed = 6) {
  const h = harness();
  h.tx[0] = 50;
  h.ty[0] = 34;
  /** @type {number[][][]} */
  const path = [];
  for (let f = 0; f <= 2.5 * FPS; f++) {
    h.tx[1] = 42.5 + speed * f * DTF;
    h.ty[1] = 34 + lateral;
    path.push(h.frame([0, 1]));
  }
  return { h, path };
}

for (const lateral of [0.4, 0]) {
  test(`a runner passing a standing player ${lateral ? `${lateral} m to the side` : 'dead-on'} slides by on one side, without orbiting`, () => {
    const { path } = passBy(lateral);
    let minGap = Infinity;
    let side = 0;
    let prevAngle = NaN;
    let maxTurn = 0;
    let maxStandingStep = 0;
    for (let f = 0; f < path.length; f++) {
      const [a, b] = path[f];
      minGap = Math.min(minGap, dist(a, b));
      // The standing player is only nudged sideways, never shoved back and then forward.
      assert.ok(Math.abs(a[0] - 50) < 0.05, `frame ${f}: standing player drawn at x ${a[0].toFixed(3)}`);
      if (f > 0) {
        assert.ok(b[0] > path[f - 1][1][0], `frame ${f}: the runner's drawn x keeps increasing`);
        maxStandingStep = Math.max(maxStandingStep, dist(a, path[f - 1][0]));
      }
      // The runner stays on one side of the standing player for the whole pass.
      const lat = b[1] - a[1];
      if (Math.abs(lat) > 0.05) {
        if (side === 0) side = Math.sign(lat);
        assert.equal(Math.sign(lat), side, `frame ${f}: the runner switched sides`);
      }
      // The bearing from one token to the other sweeps smoothly: no snap.
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (Number.isFinite(prevAngle)) {
        let turn = Math.abs(angle - prevAngle);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        maxTurn = Math.max(maxTurn, turn);
      }
      prevAngle = angle;
    }
    assert.ok(minGap >= MIN * 0.8, `no full overlap: closest drawn centres ${minGap.toFixed(2)} m`);
    assert.ok(maxTurn < 0.12, `bearing turns at most ${maxTurn.toFixed(3)} rad a frame`);
    assert.ok(maxStandingStep < 0.06, `the standing token moves at most ${maxStandingStep.toFixed(3)} m a frame`);
    if (lateral > 0) assert.equal(side, 1, 'the runner passes on the side it was already on');
  });
}

test('the same pass gives the same drawing (deterministic, slot order breaks the dead-on tie)', () => {
  const a = passBy(0).path.flat(2);
  const b = passBy(0).path.flat(2);
  assert.deepEqual(a, b);
});

test('smoothing: a runner at constant speed is drawn without lag, a sharp turn is eased, a long jump snaps', () => {
  const h = harness();
  h.tx[4] = 30;
  h.ty[4] = 30;
  h.frame([4]);
  // 1 s straight along +x at 7 m/s: drawn exactly on the target (feed-forward, no trailing).
  for (let f = 1; f <= FPS; f++) {
    h.tx[4] = 30 + 7 * f * DTF;
    const [[x, y]] = h.frame([4]);
    if (f > 30) assert.ok(Math.abs(x - h.tx[4]) < 0.02 && Math.abs(y - 30) < 1e-9, `frame ${f}: drawn ${x.toFixed(3)} for ${h.tx[4].toFixed(3)}`);
  }
  // A 90-degree turn: the engine velocity flips at once, the drawn velocity turns over a few frames.
  let prev = [h.layout.outX[4], h.layout.outY[4]];
  let prevV = [7 * DTF, 0];
  let maxDv = 0;
  const x0 = h.tx[4];
  for (let f = 1; f <= 20; f++) {
    h.ty[4] = 30 + 7 * f * DTF;
    const [cur] = h.frame([4]);
    const v = [cur[0] - prev[0], cur[1] - prev[1]];
    maxDv = Math.max(maxDv, Math.hypot(v[0] - prevV[0], v[1] - prevV[1]));
    prev = cur;
    prevV = v;
  }
  assert.ok(maxDv < 0.5 * 7 * DTF * Math.SQRT2, `drawn velocity changes by at most ${(maxDv / DTF).toFixed(2)} m/s a frame (a raw corner would be 9.9)`);
  assert.ok(Math.abs(h.layout.outX[4] - x0) < 0.25, 'the corner is rounded, not overshot far');
  // A 10 m jump (kick-off reset, substitution) is drawn at once.
  h.tx[4] = 52.5;
  h.ty[4] = 34;
  const [[jx, jy]] = h.frame([4]);
  assert.deepEqual([jx, jy], [52.5, 34]);
});

test('seeking back or leaping forward resets the layout: nothing trails across a time jump', () => {
  const { h } = passBy(0.4);
  // Mid-pass state: smoothed velocities and separation offsets in place. Now a replay rewinds the
  // shown time 5 s and both players are 1-2 m from where they were drawn (under the snap distance).
  h.tx[0] = 51;
  h.ty[0] = 35;
  h.tx[1] = 49;
  h.ty[1] = 30;
  const rewound = h.frame([0, 1], { at: 7 });
  assert.deepEqual(rewound, [
    [51, 35],
    [49, 30],
  ]);
  // Continuing play from there is smooth again (no reset per frame at 1x).
  h.tx[1] += 0.1;
  const next = h.frame([0, 1]);
  assert.ok(Math.abs(next[1][0] - 49.1) < 0.2);

  // A forward leap of more than a second of match time (a pre-roll catching up, fast-forward) resets too.
  h.tx[0] = 53;
  h.tx[1] = 47;
  const leapt = h.frame([0, 1], { dt: 3 });
  assert.deepEqual(leapt, [
    [53, 35],
    [47, 30],
  ]);

  // And an explicit reset (a new match on the same view).
  h.frame([0, 1]);
  h.layout.reset();
  h.tx[0] = 54;
  assert.deepEqual(h.frame([0, 1])[0], [54, 35]);
});

test('the layout is render-only: the engine state hash is unchanged', () => {
  const engine = MatchEngine.create(sampleInput(3, { homeControl: 'ai', awayControl: 'ai' }), config);
  engine.step(400);
  const s = engine.state;
  s.players[20].x = s.players[5].x;
  s.players[20].y = s.players[5].y;
  const hash = engine.hash();
  const layout = new TokenLayout(N);
  const xs = new Float64Array(N);
  const ys = new Float64Array(N);
  const ids = s.onPitchList.slice();
  for (const i of ids) {
    xs[i] = s.players[i].x;
    ys[i] = s.players[i].y;
  }
  layout.update(ids, xs, ys, { simTime: s.tick / 20, minDist: MIN });
  assert.ok(Math.hypot(layout.outX[20] - layout.outX[5], layout.outY[20] - layout.outY[5]) >= MIN * 0.8);
  assert.equal(engine.hash(), hash, 'no engine field was touched');
  assert.equal(s.players[20].x, s.players[5].x);
});

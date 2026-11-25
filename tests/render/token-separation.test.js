// Render-only separation of player tokens (src/ui/tokenSeparation.js, used by the pitch canvas).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEngine } from '../../src/engine/MatchEngine.js';
import { separateTokens } from '../../src/ui/tokenSeparation.js';
import { config, sampleInput } from '../engine/helpers.js';

const R = 10; // token radius (px)
const MIN = 2 * R + 1.5;

/** Pitch metres to canvas px at a portrait-ish scale (7 px per metre). */
const toCanvas = (/** @type {number} */ x, /** @type {number} */ y) => ({ cx: 20 + y * 7, cy: 20 + x * 7 });

const dist = (/** @type {Float64Array} */ xs, /** @type {Float64Array} */ ys, /** @type {number} */ i, /** @type {number} */ j) => Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);

test('two players at nearly the same pitch spot are drawn with non-overlapping tokens, pushed apart symmetrically', () => {
  const a = toCanvas(50, 30);
  const b = toCanvas(50.1, 30.05); // 0.11 m apart: under a pixel
  const xs = new Float64Array([a.cx, b.cx]);
  const ys = new Float64Array([a.cy, b.cy]);
  const midX = (xs[0] + xs[1]) / 2;
  const midY = (ys[0] + ys[1]) / 2;
  separateTokens(xs, ys, [0, 1], MIN);
  assert.ok(dist(xs, ys, 0, 1) >= 2 * R, `centres ${dist(xs, ys, 0, 1).toFixed(2)} px apart`);
  assert.ok(Math.abs((xs[0] + xs[1]) / 2 - midX) < 1e-9 && Math.abs((ys[0] + ys[1]) / 2 - midY) < 1e-9, 'both move, the pair stays centred');
});

test('exactly coincident tokens separate along a deterministic axis; a pinned carrier stays at the ball', () => {
  const xs = new Float64Array([100, 100]);
  const ys = new Float64Array([200, 200]);
  separateTokens(xs, ys, [0, 1], MIN);
  assert.ok(dist(xs, ys, 0, 1) >= 2 * R);
  assert.ok(xs[0] < xs[1] && ys[0] === ys[1], 'split along x, lower index to the left');
  const again = [new Float64Array([100, 100]), new Float64Array([200, 200])];
  separateTokens(again[0], again[1], [0, 1], MIN);
  assert.deepEqual([...again[0], ...again[1]], [...xs, ...ys], 'the same input gives the same layout');

  const px = new Float64Array([100, 104]);
  const py = new Float64Array([200, 201]);
  separateTokens(px, py, [0, 1], MIN, { pinned: 0 });
  assert.deepEqual([px[0], py[0]], [100, 200], 'the carrier does not move');
  assert.ok(dist(px, py, 0, 1) >= 2 * R);
});

test('a crowded goalmouth scramble untangles in three passes; tokens already apart do not move', () => {
  // Five players inside one metre (a scramble), plus one well clear.
  const spots = [
    [100, 30],
    [100.2, 30.1],
    [99.9, 29.8],
    [100.1, 30.3],
    [100.3, 29.9],
    [80, 10],
  ];
  const xs = new Float64Array(spots.length);
  const ys = new Float64Array(spots.length);
  spots.forEach(([x, y], i) => {
    const c = toCanvas(x, y);
    xs[i] = c.cx;
    ys[i] = c.cy;
  });
  const clear = [xs[5], ys[5]];
  separateTokens(xs, ys, [0, 1, 2, 3, 4, 5], MIN, { passes: 3 });
  let worst = Infinity;
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) worst = Math.min(worst, dist(xs, ys, i, j));
  assert.ok(worst >= 2 * R * 0.8, `the scramble is legible: closest centres ${worst.toFixed(1)} px (radius ${R})`);
  assert.deepEqual([xs[5], ys[5]], clear, 'a far player is untouched');
});

test('the separation is render-only: the engine state hash is unchanged', () => {
  const engine = MatchEngine.create(sampleInput(3, { homeControl: 'ai', awayControl: 'ai' }), config);
  engine.step(400);
  const s = engine.state;
  // Two duelling players on the same spot in the engine.
  s.players[20].x = s.players[5].x;
  s.players[20].y = s.players[5].y;
  const hash = engine.hash();
  const xs = new Float64Array(36);
  const ys = new Float64Array(36);
  const ids = s.onPitchList.slice();
  for (const i of ids) {
    const c = toCanvas(s.players[i].x, s.players[i].y);
    xs[i] = c.cx;
    ys[i] = c.cy;
  }
  separateTokens(xs, ys, ids, MIN);
  assert.ok(dist(xs, ys, 5, 20) >= 2 * R);
  assert.equal(engine.hash(), hash, 'no engine field was touched');
  assert.equal(s.players[20].x, s.players[5].x);
});

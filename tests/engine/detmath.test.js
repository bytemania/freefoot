import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fastExp, fastAtan2, sigmoid, PI, EXP_LIMIT } from '../../src/engine/math/detmath.js';

test('fastExp relative error is at most 1e-6 on [-20, 20]', () => {
  let worst = 0;
  for (let x = -20; x <= 20; x += 0.001) {
    worst = Math.max(worst, Math.abs(fastExp(x) / Math.exp(x) - 1));
  }
  assert.ok(worst <= 1e-6, `worst relative error ${worst}`);
});

test('fastExp clamps its input so sigmoid never overflows', () => {
  assert.equal(fastExp(1000), fastExp(EXP_LIMIT));
  assert.equal(fastExp(-1000), fastExp(-EXP_LIMIT));
  assert.ok(Number.isFinite(sigmoid(-1e9)) && Number.isFinite(sigmoid(1e9)));
  assert.equal(sigmoid(0), 0.5);
});

test('fastAtan2 absolute error is at most 1e-5 rad', () => {
  let worst = 0;
  for (let y = -10; y <= 10; y += 0.25) {
    for (let x = -10; x <= 10; x += 0.25) {
      worst = Math.max(worst, Math.abs(fastAtan2(y, x) - Math.atan2(y, x)));
    }
  }
  for (let a = -PI + 1e-3; a <= PI - 1e-3; a += 0.0005) {
    worst = Math.max(worst, Math.abs(fastAtan2(Math.sin(a), Math.cos(a)) - a));
  }
  assert.ok(worst <= 1e-5, `worst absolute error ${worst}`);
});

test('fastAtan2 handles axes and the origin', () => {
  assert.equal(fastAtan2(0, 0), 0);
  assert.ok(Math.abs(fastAtan2(1, 0) - PI / 2) < 1e-9);
  assert.ok(Math.abs(fastAtan2(-1, 0) + PI / 2) < 1e-9);
  assert.ok(Math.abs(fastAtan2(0, -1) - PI) < 1e-9);
});

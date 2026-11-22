import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestPointOnSegment, distSqPointSegment, normalize, angleToPosts, inCone } from '../../src/engine/math/geom.js';

test('closestPointOnSegment: interior, endpoints and a degenerate segment', () => {
  const out = { x: 0, y: 0, t: 0 };
  closestPointOnSegment(0, 0, 10, 0, 4, 3, out);
  assert.deepEqual(out, { x: 4, y: 0, t: 0.4 });
  closestPointOnSegment(0, 0, 10, 0, -5, 2, out);
  assert.deepEqual(out, { x: 0, y: 0, t: 0 });
  closestPointOnSegment(0, 0, 10, 0, 15, 2, out);
  assert.deepEqual(out, { x: 10, y: 0, t: 1 });
  closestPointOnSegment(2, 2, 2, 2, 5, 6, out);
  assert.deepEqual(out, { x: 2, y: 2, t: 0 });
});

test('distSqPointSegment agrees with closestPointOnSegment', () => {
  assert.equal(distSqPointSegment(0, 0, 10, 0, 4, 3), 9);
  assert.equal(distSqPointSegment(0, 0, 10, 0, 13, 4), 25);
  assert.equal(distSqPointSegment(0, 0, 0, 0, 3, 4), 25);
});

test('a fast ball does not tunnel past a defender on its path', () => {
  // 30 m/s ground ball, one tick of 0.05 s moves 1.5 m; a defender at the midpoint is still found.
  assert.ok(distSqPointSegment(10, 0, 11.5, 0, 10.75, 0.2) < 0.25);
});

test('normalize returns the length and a unit vector', () => {
  const out = { x: 0, y: 0 };
  assert.equal(normalize(3, 4, out), 5);
  assert.deepEqual(out, { x: 0.6, y: 0.8 });
  assert.equal(normalize(0, 0, out), 0);
  assert.deepEqual(out, { x: 0, y: 0 });
});

test('angleToPosts: penalty spot, goal line and symmetry', () => {
  const half = 3.66;
  const spot = angleToPosts(94, 34, 105, 34, half);
  assert.ok(Math.abs(spot - 2 * Math.atan(half / 11)) < 1e-5);
  assert.ok(Math.abs(angleToPosts(94, 30, 105, 34, half) - angleToPosts(94, 38, 105, 34, half)) < 1e-9);
  assert.ok(angleToPosts(80, 34, 105, 34, half) < spot);
});

test('inCone: inside, outside and on the edge', () => {
  // ball at (90, 34), posts at (105, 30.34) and (105, 37.66)
  assert.equal(inCone(90, 34, 105, 30.34, 105, 37.66, 100, 34), true);
  assert.equal(inCone(90, 34, 105, 30.34, 105, 37.66, 100, 45), false);
  assert.equal(inCone(90, 34, 105, 30.34, 105, 37.66, 85, 34), false);
  assert.equal(inCone(90, 34, 105, 30.34, 105, 37.66, 105, 34), true);
});

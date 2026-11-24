import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { abDiff, applyOverrides, formatAbDiff, parseOverride } from '../../src/calibration/abdiff.js';

test('parseOverride reads numbers, booleans and rejects malformed text', () => {
  assert.deepEqual(parseOverride('w.shot.boxFree=0.25'), { path: 'w.shot.boxFree', value: 0.25 });
  assert.deepEqual(parseOverride('a.b=true'), { path: 'a.b', value: true });
  assert.throws(() => parseOverride('nothing'), /dot\.path=value/);
  assert.throws(() => parseOverride('a.b='), /dot\.path=value/);
});

test('applyOverrides clones: the frozen config is untouched, the clone changes, shorthand roots resolve', () => {
  const before = config.weights.decision.w.shot.boxFree.value;
  for (const path of ['w.shot.boxFree', 'decision.w.shot.boxFree', 'weights.decision.w.shot.boxFree']) {
    const { config: c, applied } = applyOverrides(config, [{ path, value: 0.01 }]);
    assert.equal(c.weights.decision.w.shot.boxFree.value, 0.01, path);
    assert.equal(applied[0].from, before);
    assert.equal(applied[0].resolved, 'weights.decision.w.shot.boxFree');
    assert.notEqual(c.weights, config.weights);
  }
  assert.equal(config.weights.decision.w.shot.boxFree.value, before, 'original unchanged');
});

test('applyOverrides rejects unknown paths, sections and type mismatches', () => {
  assert.throws(() => applyOverrides(config, [{ path: 'w.shot.nope', value: 1 }]), /no such config value/);
  assert.throws(() => applyOverrides(config, [{ path: 'w.shot', value: 1 }]), /no such config value/);
  assert.throws(() => applyOverrides(config, [{ path: 'w.shot.boxFree', value: 'x' }]), /expected a number/);
});

test('no overrides: the same seed is identical tick for tick, with equal hashes', () => {
  const r = abDiff({ config, configHash, seed: 7, overrides: [], maxTicks: 3000 });
  assert.equal(r.firstDivergenceTick, -1);
  assert.equal(r.firstEventDiff, -1);
  assert.equal(r.hashes[0], r.hashes[1]);
  assert.equal(r.identical, true);
});

test('an override that matters reports a first divergence and different hashes', () => {
  const r = abDiff({ config, configHash, seed: 7, overrides: [parseOverride('w.pass.progress=3')], maxTicks: 3000 });
  assert.ok(r.firstDivergenceTick > 0, `diverged at ${r.firstDivergenceTick}`);
  assert.notEqual(r.hashes[0], r.hashes[1]);
  assert.equal(r.identical, false);
  const text = formatAbDiff(r);
  assert.match(text, /First divergence: tick \d+/);
  assert.match(text, /weights\.decision\.w\.pass\.progress/);
});

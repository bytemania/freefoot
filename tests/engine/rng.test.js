import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextUint32, nextFloat, range, chance, splitmix32 } from '../../src/engine/rng/sfc32.js';
import { seedSfc32, commentarySeed } from '../../src/engine/rng/streams.js';

// Known-answer vectors generated once from a C program (PractRand's sfc32 raw32
// and the design's splitmix32 constants), not from the code under test.
/** @type {[number[], number[]][]} */
const SFC32 = [
  [[0, 0, 0, 0], [0, 1, 2, 12, 18874399, 56669315, 2581679515, 3653559774]],
  [[1, 2, 3, 4], [7, 34, 56623200, 188882296, 3431242869, 399395954, 785775158, 3843710725]],
  [
    [0xdeadbeef, 0x12345678, 0x9e3779b9, 0xffffffff],
    [4041348454, 2721092564, 4168711456, 4235405227, 2971885703, 3398012290, 3881476788, 2961582287],
  ],
];
/** @type {[number, number[]][]} */
const SPLITMIX = [
  [0, [2462723854, 1020716019, 454327756, 1275600319, 1215922603, 3678440605]],
  [1, [2527132011, 314344336, 2535364964, 2041432039, 1495043544, 3445983177]],
  [42, [939911724, 3948730756, 321366731, 3317318717, 527392959, 2701967985]],
  [0xffffffff, [920564995, 4230986166, 697614773, 1778835764, 280495159, 1500331647]],
];
/** @type {[number, number[]][]} */
const SEEDED = [
  [0, [387095348, 2506032770, 735102004, 4023218824, 3083645593, 1030014670]],
  [1, [4148684523, 4055680838, 3224489912, 3690843842, 1114091683, 537224786]],
  [42, [1920286840, 3588795744, 3644712829, 3990689672, 1996320479, 4256360589]],
  [20260101, [3271257574, 1894184014, 1192975034, 46916094, 2796373036, 1335354669]],
];

test('sfc32 matches the reference vectors', () => {
  for (const [state, expected] of SFC32) {
    const s = Uint32Array.from(state);
    assert.deepEqual(expected.map(() => nextUint32(s)), expected);
  }
});

test('splitmix32 matches the reference vectors', () => {
  for (const [seed, expected] of SPLITMIX) {
    const s = Uint32Array.of(seed);
    assert.deepEqual(expected.map(() => splitmix32(s)), expected);
  }
});

test('seedSfc32 matches the reference chain (4 splitmix words, 16 discarded outputs)', () => {
  for (const [seed, expected] of SEEDED) {
    const s = seedSfc32(new Uint32Array(4), seed);
    assert.deepEqual(expected.map(() => nextUint32(s)), expected);
  }
});

test('seedSfc32 gives distinct states for seeds 0-9999', () => {
  const seen = new Set();
  const s = new Uint32Array(4);
  for (let seed = 0; seed < 10000; seed++) {
    seedSfc32(s, seed);
    seen.add(`${s[0]},${s[1]},${s[2]},${s[3]}`);
  }
  assert.equal(seen.size, 10000);
});

test('commentarySeed gives distinct seeds across seq values', () => {
  const seen = new Set();
  for (let seq = 0; seq < 20000; seq++) seen.add(commentarySeed(12345, seq));
  assert.equal(seen.size, 20000);
});

test('nextFloat is in [0, 1), range excludes hi, chance follows p', () => {
  const s = seedSfc32(new Uint32Array(4), 7);
  let hits = 0;
  for (let i = 0; i < 20000; i++) {
    const f = nextFloat(s);
    assert.ok(f >= 0 && f < 1);
    const r = range(s, 3, 7);
    assert.ok(r >= 3 && r < 7 && Number.isInteger(r));
    if (chance(s, 0.25)) hits++;
  }
  assert.ok(hits > 4600 && hits < 5400, `hits ${hits}`);
});

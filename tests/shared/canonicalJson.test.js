import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256Hex } from '../../src/shared/canonicalJson.js';

test('canonicalJson sorts object keys recursively', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});

test('canonicalJson is independent of key insertion order', () => {
  assert.equal(canonicalJson({ x: 1, y: 2 }), canonicalJson({ y: 2, x: 1 }));
});

test('canonicalJson skips undefined members and rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonicalJson({ a: NaN }), TypeError);
  assert.throws(() => canonicalJson({ a: () => 1 }), TypeError);
});

test('sha256Hex matches known vectors', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

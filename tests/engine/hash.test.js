import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashValue, hashHex } from '../../src/engine/math/hash.js';

/**
 * Independent FNV-1a over explicit bytes.
 * @param {number[]} bytes
 */
function fnv(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

/** @param {number} n */
const f64 = (n) => [...new Uint8Array(new Float64Array([n]).buffer)];
/** @param {number} n */
const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

test('FNV-1a known answer: "a" is 0xe40c292c', () => {
  assert.equal(fnv([0x61]), 0xe40c292c);
});

test('tagged encoding: null, booleans, numbers, strings, arrays, objects', () => {
  assert.equal(hashValue(null), fnv([0]));
  assert.equal(hashValue(false), fnv([1]));
  assert.equal(hashValue(true), fnv([2]));
  assert.equal(hashValue(1.5), fnv([3, ...f64(1.5)]));
  assert.equal(hashValue('aé😀'), fnv([4, ...u32(7), 0x61, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]));
  assert.equal(hashValue([1, 'a']), fnv([5, ...u32(2), 3, ...f64(1), 4, ...u32(1), 0x61]));
  assert.equal(hashValue({ k: true }), fnv([6, ...u32(1), 4, ...u32(1), 0x6b, 2]));
});

test('-0 hashes as +0; NaN, Infinity and undefined throw', () => {
  assert.equal(hashValue({ a: -0 }), hashValue({ a: 0 }));
  assert.throws(() => hashValue(NaN), /non-finite/);
  assert.throws(() => hashValue([Infinity]), /non-finite/);
  assert.throws(() => hashValue({ a: undefined }), /unsupported/);
});

test('key order matters, values matter, hashHex pads to 8 digits', () => {
  assert.notEqual(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]));
  assert.match(hashHex(0), /^[0-9a-f]{8}$/);
});

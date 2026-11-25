// The app's match seed (src/runtime/matchSeed.js): `?seed=<n>` replays a given match, anything else a random one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEED, matchSeedFrom } from '../../src/runtime/matchSeed.js';

test('?seed=<n> picks the match seed; without it (or with an invalid one) the seed is random', () => {
  const random = () => 777;
  assert.equal(matchSeedFrom('?seed=1234', random), 1234);
  assert.equal(matchSeedFrom('?lang=en&seed=0', random), 0);
  assert.equal(matchSeedFrom(`?seed=${MAX_SEED}`, random), MAX_SEED);
  for (const search of ['', '?', '?seed=', '?seed=abc', '?seed=-5', '?seed=1.5', '?seed=1e3', `?seed=${MAX_SEED + 1}`, '?other=4']) {
    assert.equal(matchSeedFrom(search, random), 777, JSON.stringify(search));
  }
});

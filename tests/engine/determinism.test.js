import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { GOLDEN_PATH, readGolden, runMatch, sampleInput } from './helpers.js';
import home from '../../generated/squads/sample-home.js';
import away from '../../generated/squads/sample-away.js';

const SEEDS = [1, 2, 3, 42, 20260101];
const EVERY = 1000;
// The fixed human command log (design item 75): subs at 60', a formation change at 70'.
// Ticks are absolute: 60' is 54,000 + 18,000 and 70' is 54,000 + 30,000 (both multiples of 1,000).
const COMMAND_LOG = [
  { seq: 1, tick: 72000, issuer: 'human', type: 'SUBSTITUTE', teamIndex: 0, payload: { outIndex: 9, inIndex: 12 } },
  { seq: 2, tick: 72000, issuer: 'human', type: 'SUBSTITUTE', teamIndex: 1, payload: { outIndex: 27, inIndex: 30 } },
  { seq: 3, tick: 84000, issuer: 'human', type: 'SET_FORMATION', teamIndex: 0, payload: { formationId: '4-4-2' } },
];

if (process.env.UPDATE_GOLDEN === '1') {
  test('UPDATE_GOLDEN: rewrite tests/golden/seeds.json', () => {
    const commandLog = COMMAND_LOG;
    const squads = {
      home: JSON.parse(JSON.stringify({ ...home, controlledBy: 'human' })),
      away: JSON.parse(JSON.stringify({ ...away, controlledBy: 'human' })),
    };
    const seeds = SEEDS.map((seed) => {
      const { hashes, final } = runMatch(sampleInput(seed), commandLog, { every: EVERY });
      return { seed, hashes, final };
    });
    writeFileSync(GOLDEN_PATH, `${JSON.stringify({ everyTicks: EVERY, squads, commandLog, seeds }, null, 2)}\n`);
  });
} else {
  const golden = readGolden();

  test('golden file exists with the 5 fixed seeds', () => {
    assert.ok(golden, 'tests/golden/seeds.json is missing; run UPDATE_GOLDEN=1 npm test');
    assert.deepEqual(golden.seeds.map((/** @type {any} */ s) => s.seed), SEEDS);
  });

  for (const entry of golden?.seeds ?? []) {
    test(`seed ${entry.seed}: hash every ${EVERY} ticks and the final hash match the golden stream`, () => {
      const input = { ...sampleInput(entry.seed), home: golden.squads.home, away: golden.squads.away };
      const { hashes, final } = runMatch(input, golden.commandLog, { every: golden.everyTicks });
      assert.deepEqual(hashes, entry.hashes);
      assert.equal(final, entry.final);
    });
  }

  test('the hash stream does not depend on how ticks are batched across step() calls', () => {
    const seed = SEEDS[3];
    const a = runMatch(sampleInput(seed), golden?.commandLog ?? [], { every: EVERY, batch: 1000 });
    const b = runMatch(sampleInput(seed), golden?.commandLog ?? [], { every: EVERY, batch: 37 });
    assert.deepEqual(b.hashes, a.hashes);
    assert.equal(b.final, a.final);
  });

  test('different seeds give different states', () => {
    const [a, b] = [1, 2].map((seed) => runMatch(sampleInput(seed), [], { every: 54000 }).final);
    assert.notEqual(a, b);
  });
}

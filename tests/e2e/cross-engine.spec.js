import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenPath = path.join(here, '..', 'golden', 'seeds.json');

test('Chromium produces bit-identical hash streams to Node across all 5 golden seeds', async ({ page }) => {
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  await page.goto('/e2e/determinism.html');
  await page.waitForFunction(() => typeof (/** @type {any} */ (globalThis)).runGolden === 'function');

  const results = await page.evaluate((g) => (/** @type {any} */ (globalThis)).runGolden(g), golden);
  expect(results).toHaveLength(golden.seeds.length);

  for (let i = 0; i < golden.seeds.length; i++) {
    expect(results[i].seed).toBe(golden.seeds[i].seed);
    expect(results[i].hashes).toEqual(golden.seeds[i].hashes);
    expect(results[i].final).toBe(golden.seeds[i].final);
  }
});

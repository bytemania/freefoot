import { test, expect } from '@playwright/test';

test('Full Match boot, PT/EN toggle, Manager formation/sub, and Best Moments', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await expect(page.locator('#sb-score')).toHaveText('0 - 0');
  await expect(page.locator('.pitch-canvas')).toBeVisible();

  // PT -> EN language toggle
  await expect(page.locator('#sb-lang-btn')).toHaveText('PT');
  await expect(page.locator('#ctrl-play')).toHaveText('Reproduzir');
  await page.click('#sb-lang-btn');
  await expect(page.locator('#sb-lang-btn')).toHaveText('EN');
  await expect(page.locator('#ctrl-play')).toHaveText('Play');

  // Manager drawer: switch formation to 4-4-2 and queue + cancel a substitution
  await page.click('#ctrl-manager');
  await expect(page.locator('#mgr-drawer')).toHaveClass(/is-open/);
  await page.click('[data-formation="4-4-2"]');
  await expect(page.locator('[data-formation="4-4-2"]')).toHaveClass(/btn-primary/);

  await page.locator('[data-out-index]').nth(1).click();
  await page.locator('[data-in-index]').first().click();
  await expect(page.locator('.mgr-pend-item')).toHaveCount(1);
  await page.locator('[data-cancel-seq]').first().click();
  await expect(page.locator('.mgr-pend-item')).toHaveCount(0);
  await page.click('#close-mgr');

  // Best Moments mode toggle & playback
  await page.click('#ctrl-mode');
  await expect(page.locator('#ctrl-mode')).toHaveText('Best moments');
  await page.click('#ctrl-play');
  await page.waitForTimeout(250);
  await page.click('#ctrl-play'); // pause

  expect(errors).toEqual([]);
});

test('#seed Debug Viewer loads seed, steps ticks, and inspects carrier & timeline', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/#seed=1&scenario=A');
  await expect(page.locator('#seed-input')).toHaveValue('1');
  await expect(page.locator('.pitch-canvas')).toBeVisible();

  await page.click('#btn-step20');
  await expect(page.locator('#clock-text')).toContainText('t20');
  await page.click('#btn-step1');
  await expect(page.locator('#clock-text')).toContainText('t21');

  await expect(page.locator('.debug-inspector')).toBeVisible();
  expect(errors).toEqual([]);
});

test('#bench route runs benchmark and matches golden seed 1 hash', async ({ page }) => {
  await page.goto('/#bench');
  await page.click('#bench-run');
  await expect(page.locator('#bench-output')).toContainText('"goldenSeed1"', { timeout: 30000 });
  const text = await page.locator('#bench-output').textContent();
  const data = JSON.parse(text ?? '{}');
  expect(data.goldenSeed1.match).toBe(true);
  expect(data.gates.engineP95Under2ms).toBe(true);
});

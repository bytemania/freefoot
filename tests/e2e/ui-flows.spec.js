import { test, expect } from '@playwright/test';

test('Full Match boot, PT/EN toggle, Manager formation/sub, and Best Moments', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await expect(page.locator('#sb-score')).toHaveText('0 - 0');
  await expect(page.locator('.pitch-canvas')).toBeVisible();
  await expect(page.locator('.comm-broadcast')).toBeVisible();
  await expect(page.locator('.commentary-feed')).toHaveCount(0);
  await expect(page.locator('.comm-broadcast .comm-score')).toHaveText('0 - 0');
  const sbBox = await page.locator('#sb-mount').boundingBox();
  const commBox = await page.locator('#comm-mount').boundingBox();
  const pitchBox = await page.locator('#match-pitch-mount').boundingBox();
  expect(sbBox && commBox && pitchBox).toBeTruthy();
  if (sbBox && commBox && pitchBox) {
    expect(commBox.y).toBeGreaterThanOrEqual(sbBox.y + sbBox.height - 2);
    expect(commBox.y + commBox.height).toBeLessThanOrEqual(pitchBox.y + 2);
  }

  // PT -> EN language toggle
  await expect(page.locator('#sb-lang-btn')).toHaveText('PT');
  await expect(page.locator('#ctrl-play')).toHaveText('Reproduzir');
  await page.click('#sb-lang-btn');
  await expect(page.locator('#sb-lang-btn')).toHaveText('EN');
  await expect(page.locator('#ctrl-play')).toHaveText('Play');

  // Simplified controls: no speed slider or continuous Full-Match toggle, only Play/Pause + pacing badge
  await expect(page.locator('#ctrl-speed')).toHaveCount(0);
  await expect(page.locator('#ctrl-mode')).toHaveCount(0);
  await expect(page.locator('#ctrl-pacing')).toBeVisible();

  // Stats drawer: shows Goals, Yellow Cards, Red Cards and no xG row
  await page.click('#ctrl-stats');
  await expect(page.locator('#stats-drawer')).toHaveClass(/is-open/);
  await expect(page.locator('#stats-mount')).toContainText('Goals');
  await expect(page.locator('#stats-mount')).toContainText('Yellow Cards');
  await expect(page.locator('#stats-mount')).toContainText('Red Cards');
  await expect(page.locator('#stats-mount')).not.toContainText('xG');
  await page.click('#close-stats');

  // Manager drawer: 1x auto-slow when opened, side-by-side minimap + bench, draft staging & explicit Confirm
  await page.click('#ctrl-play');
  await page.click('#ctrl-manager');
  await expect(page.locator('#mgr-drawer')).toHaveClass(/is-open/);
  await expect(page.locator('#ctrl-pacing')).toContainText('1x');
  await page.click('#ctrl-play'); // pause so dead-ball kickoff doesn't immediately execute confirmed sub before cancel check
  await expect(page.locator('#mgr-minimap .mgr-node')).toHaveCount(11);

  const mapBox = await page.locator('#mgr-minimap').boundingBox();
  const benchBox = await page.locator('#mgr-bench').boundingBox();
  expect(mapBox && benchBox).toBeTruthy();
  if (mapBox && benchBox) {
    expect(benchBox.x).toBeGreaterThanOrEqual(mapBox.x + mapBox.width - 2);
  }

  await page.click('[data-formation="4-4-2"]');
  await expect(page.locator('[data-formation="4-4-2"]')).toHaveClass(/btn-primary/);

  // Draft slot swap + sub without mutating pending engine subs until Confirm is pressed
  await page.locator('[data-out-index]').nth(1).click();
  await page.locator('[data-out-index]').nth(2).click();
  await page.locator('[data-out-index]').nth(1).click();
  await page.locator('[data-in-index]').first().click();
  await expect(page.locator('#mgr-staged-list .mgr-pend-item')).toHaveCount(3);
  await expect(page.locator('#mgr-pending-list .mgr-pend-item')).toHaveCount(0);

  await page.click('#mgr-confirm');
  await expect(page.locator('#mgr-status')).toContainText('Confirmed');
  await expect(page.locator('#mgr-staged-list .mgr-pend-item')).toHaveCount(0);
  await expect(page.locator('#mgr-pending-list .mgr-pend-item')).toHaveCount(1);
  await page.locator('[data-cancel-seq]').first().click();
  await expect(page.locator('#mgr-pending-list .mgr-pend-item')).toHaveCount(0);
  await page.click('#close-mgr');

  // Playback resume & pause works cleanly
  await page.click('#ctrl-play');
  await page.waitForTimeout(200);
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

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
  await expect(page.locator('.comm-broadcast .comm-score')).toHaveCount(0);
  await expect(page.locator('.comm-broadcast .comm-min')).toBeVisible();
  await expect(page.locator('.comm-broadcast .comm-icon')).toBeVisible();
  await expect(page.locator('.comm-broadcast .comm-text')).toBeVisible();
  await expect(page.locator('#ctrl-repro')).toHaveCount(0);
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
  // One play / pause control: the speed badge shows a speed (dimmed while paused), never ||
  await expect(page.locator('#ctrl-pacing')).toHaveText(/^>>?$/);
  await expect(page.locator('#ctrl-pacing')).toHaveClass(/is-paused/);
  await expect(page.locator('#ctrl-play')).toHaveText('|>');
  await expect(page.locator('#ctrl-play')).toHaveAttribute('aria-label', 'Reproduzir');
  await page.click('#sb-lang-btn');
  await expect(page.locator('#sb-lang-btn')).toHaveText('EN');
  await expect(page.locator('#ctrl-play')).toHaveAttribute('aria-label', 'Play');
  await expect(page.locator('#ctrl-play')).toHaveAttribute('title', 'Play');

  // Simplified controls: no speed slider or continuous Full-Match toggle, only the pacing badge with Play/Pause right beside it
  await expect(page.locator('#ctrl-speed')).toHaveCount(0);
  await expect(page.locator('#ctrl-mode')).toHaveCount(0);
  await expect(page.locator('#ctrl-pacing')).toBeVisible();
  await expect(page.locator('#ctrl-pacing + #ctrl-play')).toHaveCount(1);
  const badgeBox = await page.locator('#ctrl-pacing').boundingBox();
  const playBox = await page.locator('#ctrl-play').boundingBox();
  const barBox = await page.locator('.ctrl-row').boundingBox();
  expect(badgeBox && playBox && barBox).toBeTruthy();
  if (badgeBox && playBox && barBox) {
    expect(playBox.x).toBeGreaterThanOrEqual(badgeBox.x + badgeBox.width - 1); // right beside the badge
    expect(playBox.x - (badgeBox.x + badgeBox.width)).toBeLessThan(16);
    expect(Math.abs(playBox.y + playBox.height / 2 - (badgeBox.y + badgeBox.height / 2))).toBeLessThan(4); // same row
    expect(barBox.x + barBox.width - (playBox.x + playBox.width)).toBeLessThan(4); // pinned to the right edge
  }

  // Icon-only Stats / Coach buttons with localized accessible names
  await expect(page.locator('#ctrl-stats svg')).toHaveCount(1);
  await expect(page.locator('#ctrl-manager svg')).toHaveCount(1);
  await expect(page.locator('#ctrl-stats')).toHaveText('');
  await expect(page.locator('#ctrl-stats')).toHaveAttribute('aria-label', 'Match statistics');
  await expect(page.locator('#ctrl-manager')).toHaveAttribute('aria-label', 'Coach & tactics');
  await expect(page.locator('#ctrl-manager')).toHaveAttribute('title', 'Coach & tactics');

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
  await expect(page.locator('#ctrl-play')).toHaveText('||');
  await expect(page.locator('#ctrl-play')).toHaveAttribute('aria-label', 'Pause');
  await page.click('#ctrl-manager');
  await expect(page.locator('#mgr-drawer')).toHaveClass(/is-open/);
  await expect(page.locator('#ctrl-pacing')).toHaveText('>');
  // Pause so a dead-ball kickoff doesn't immediately execute the confirmed sub before the cancel check. The open
  // Manager drawer covers the controls bar once its slide-up ends, so dispatch the click (a real click would only
  // land while the drawer is still sliding: a race).
  await page.locator('#ctrl-play').dispatchEvent('click');
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

  // Telemetry on minimap nodes and bench rows: live rating, age, fitness, morale
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-rating')).toHaveCount(11);
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-rating').first()).toHaveText(/^\d{1,2}\.\d$/);
  await expect(page.locator('#mgr-bench .mgr-player .mgr-rating').first()).toHaveText('6.0');
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-age')).toHaveCount(11);
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-morale')).toHaveCount(11);
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-fit-fill')).toHaveCount(11);
  await expect(page.locator('#mgr-bench .mgr-player .mgr-age').first()).toHaveText(/^\d+y$/);
  await expect(page.locator('#mgr-bench .mgr-player .mgr-morale').first()).toHaveText(/\d+%/);
  await expect(page.locator('#mgr-bench .mgr-player .mgr-fit-fill').first()).toBeVisible();

  await page.click('#mgr-confirm');
  await expect(page.locator('#mgr-status')).toContainText('Confirmed');
  await expect(page.locator('#mgr-staged-list .mgr-pend-item')).toHaveCount(0);
  // Paused at a stoppage the sub is made at once; in open play it waits for the next one.
  const status = (await page.locator('#mgr-status').textContent()) ?? '';
  if (status.includes('substitution made')) {
    await expect(page.locator('#mgr-pending-list .mgr-pend-item')).toHaveCount(0);
    await expect(page.locator('.comm-broadcast')).toHaveClass(/is-sub/);
  } else {
    await expect(page.locator('#mgr-pending-list .mgr-pend-item')).toHaveCount(1);
    await page.locator('[data-cancel-seq]').first().click();
    await expect(page.locator('#mgr-pending-list .mgr-pend-item')).toHaveCount(0);
  }
  await page.click('#close-mgr');

  // Playback resume & pause works cleanly
  await page.click('#ctrl-play');
  await page.waitForTimeout(200);
  await page.click('#ctrl-play'); // pause

  // The top-right speed badge is a button: tapping it replays the latest moments, tapping again skips
  await page.click('#ctrl-pacing');
  await expect(page.locator('#ctrl-pacing')).toHaveAttribute('title', /Tap to skip the replay/);
  await page.click('#ctrl-pacing');
  await expect(page.locator('#ctrl-pacing')).toHaveAttribute('title', /Tap to replay the last moments/);
  // Back to paused: the badge shows the resume speed, dimmed; only the toggle shows |>
  await expect(page.locator('#ctrl-pacing')).toHaveText(/^>>?$/);
  await expect(page.locator('#ctrl-pacing')).toHaveClass(/is-paused/);
  await expect(page.locator('#ctrl-pacing')).toHaveAttribute('title', /^Paused · (Live \(1x\)|Fast-forward \(60x\)) · /);
  await expect(page.locator('#ctrl-play')).toHaveText('|>');

  expect(errors).toEqual([]);
});

test('Stats drawer updates live during the match, with the match minute', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await expect(page.locator('#ctrl-play')).toHaveText('|>');
  await page.click('#ctrl-play');
  await expect(page.locator('#ctrl-play')).toHaveText('||');
  await expect(page.locator('#ctrl-pacing')).toHaveText(/^>>?$/);
  await expect(page.locator('#ctrl-pacing')).not.toHaveClass(/is-paused/);
  await page.waitForTimeout(5000);

  await page.click('#ctrl-stats');
  await expect(page.locator('#stats-drawer')).toHaveClass(/is-open/);
  const header = page.locator('#stats-mount .stats-minute');
  const passesRow = page.locator('#stats-mount .stat-row').filter({ has: page.locator('span.muted', { hasText: /^Passes$/ }) });
  await expect(passesRow).toHaveCount(1);

  const read = async () => {
    const nums = await passesRow.locator('.stat-nums > span:not(.muted)').allTextContents();
    const head = (await header.textContent()) ?? '';
    const m = head.match(/^(\d+)(?:\+(\d+))?' · H([12])$/);
    expect(m, `minute header "${head}"`).toBeTruthy();
    const minute = m ? Number(m[1]) + Number(m[2] ?? 0) : -1;
    return { passes: nums.reduce((s, n) => s + Number(n), 0), minute };
  };

  const first = await read();
  expect(first.minute).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(4000);
  // Live 1x stretches can keep the same minute for a while: poll until it ticks over.
  await expect.poll(async () => (await read()).passes, { timeout: 30000 }).toBeGreaterThan(first.passes);
  await expect.poll(async () => (await read()).minute, { timeout: 30000 }).toBeGreaterThan(first.minute);

  // Closing the drawer and reopening it shows the current numbers straight away.
  await page.click('#close-stats');
  await page.waitForTimeout(1500);
  await page.click('#ctrl-stats');
  await expect.poll(async () => (await read()).passes).toBeGreaterThanOrEqual(first.passes);

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

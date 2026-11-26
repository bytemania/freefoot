import { test, expect } from '@playwright/test';

test('Matchday Loop Phase 1: Pre-Match -> Live Match (Plan A/B + HUD + Manager + Tactics) -> Post-Match Report -> Next Match', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  /** @param {string} name @param {any[]} args */
  const dev = (name, ...args) =>
    page.evaluate(([n, a]) => /** @type {any} */ (globalThis).__freefootDev[n](...a), /** @type {const} */ ([name, args]));

  // 1. Land on default route -> Pre-Match setup screen
  await page.goto('/?seed=22');
  await expect(page.locator('#pm-title')).toBeVisible();
  await expect(page.locator('#pm-lang-btn')).toHaveText('PT');
  await page.click('#pm-lang-btn');
  await expect(page.locator('#pm-lang-btn')).toHaveText('EN');
  await expect(page.locator('#pm-title')).toHaveText('Matchday setup');
  await expect(page.locator('#pm-presets .pm-preset-card')).toHaveCount(10);

  // Pick Gegenpress as Plan A and Low Block as Plan B
  await page.click('[data-assign-a="gegenpress"]');
  await page.click('[data-assign-b="low-block"]');
  await expect(page.locator('#pm-slots-summary')).toContainText('Gegenpress');
  await expect(page.locator('#pm-slots-summary')).toContainText('Low Block');

  // Switch to Squad tab, preview Plan B, run Auto-Pick Best XI, then Kick Off
  await page.click('[data-pm-tab="squad"]');
  await expect(page.locator('#pm-minimap .pm-node')).toHaveCount(11);
  await expect(page.locator('#pm-bench .pm-bench-row')).toHaveCount(7);
  await page.click('[data-pm-preview="B"]');
  await expect(page.locator('#pm-xi-form')).toContainText('5-4-1');
  await page.click('[data-pm-preview="A"]');
  await page.click('#pm-autopick');
  await page.click('#pm-kickoff');

  // 2. Match route mounted with tacticalPlans active
  await expect(page.locator('#sb-score')).toHaveText('0 - 0');
  await expect(page.locator('.pitch-canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (/** @type {any} */ (globalThis).__freefootDev))).toBe('object');

  const initialTac = await dev('tacticalState', 0);
  expect(initialTac.activePlan).toBe('A');
  expect(initialTac.formationId).toBe('4-2-3-1');

  // Advance briefly into open play, then pause
  await page.click('#ctrl-play');
  await page.waitForTimeout(2500);
  await page.click('#ctrl-play');
  await expect(page.locator('#ctrl-play')).toHaveText('>');

  // 3. Tactics drawer: Plan A/B pills, live familiarity preview, queue & cancel via HUD pill
  await page.click('#ctrl-tactics');
  await expect(page.locator('#tac-drawer')).toHaveClass(/is-open/);
  await expect(page.locator('#tac-plan-bar .tac-plan-pill')).toHaveCount(2);

  // Inspect manual tweak familiarity preview + Reset to plan
  await page.click('[data-instr="tempo"][data-opt="slow"]');
  await expect(page.locator('#tac-fam-preview')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('#tac-fam-preview')).toContainText('Familiarity:');
  await page.click('#tac-reset');

  // Stage Plan B switch and confirm
  await page.click('[data-plan="B"]');
  await expect(page.locator('#tac-fam-preview')).toContainText('Familiarity:');
  await page.click('#tac-confirm');
  await page.click('#close-tac');

  const afterQueue = await dev('tacticalState', 0);
  if (afterQueue.pendingPlan === 'B') {
    // Queued in open play: HUD pill is visible and cancels cleanly
    await expect(page.locator('#plan-hud-pill')).not.toHaveClass(/is-hidden/);
    await expect(page.locator('#plan-hud-pill')).toContainText('Switch to Plan B queued');
    await page.click('#plan-hud-pill [data-cancel-plan-hud]');
    await expect(page.locator('#plan-hud-pill')).toHaveClass(/is-hidden/);

    // Re-queue Plan B + inspect Manager panel (read-only badge, hidden raw formation buttons, queued plan + sub)
    await page.click('#ctrl-tactics');
    await page.click('[data-plan="B"]');
    await page.click('#tac-confirm');
    await page.click('#close-tac');

    await page.click('#ctrl-manager');
    await expect(page.locator('#mgr-drawer')).toHaveClass(/is-open/);
    await expect(page.locator('#mgr-form-btns')).toHaveClass(/is-hidden/);
    await expect(page.locator('#mgr-plan-badge')).not.toHaveClass(/is-hidden/);
    await expect(page.locator('#mgr-pending-list')).toContainText('Switch to Plan B queued');
    // Queue a substitution alongside the queued plan switch
    await page.locator('#mgr-minimap [data-out-index]').nth(1).click();
    await page.locator('#mgr-bench [data-in-index]').first().click();
    await page.click('#mgr-confirm');
    await page.click('#close-mgr');
  } else {
    // If paused on a dead ball, Plan B already applied immediately; still verify Manager hides raw formation buttons
    expect(afterQueue.activePlan).toBe('B');
    await page.click('#ctrl-manager');
    await expect(page.locator('#mgr-form-btns')).toHaveClass(/is-hidden/);
    await expect(page.locator('#mgr-plan-badge')).toContainText('Plan B');
    await page.click('#close-mgr');
  }

  // 4. Finish match via dev hook -> auto-navigate to Post-Match Report (#report)
  const fin = await dev('finishMatch');
  expect(fin.playbackState).toBe('FULL_TIME');
  await expect(page.locator('#rep-title')).toHaveText('Full-time report');
  await expect(page.locator('#rep-score')).toHaveText(`${fin.score.home} - ${fin.score.away}`);
  await expect(page.locator('#rep-motm')).toBeVisible();
  await expect(page.locator('#rep-familiarity')).toBeVisible();
  await expect(page.locator('#rep-familiarity')).toContainText('Gegenpress');

  // Inspect Events & Stats tab (embedded StatsView)
  await page.click('[data-rep-tab="events"]');
  await expect(page.locator('#rep-panel-events')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('#rep-stats-mount')).toContainText('Goals');
  await expect(page.locator('#rep-stats-mount')).toContainText('Passes');

  // Inspect Ratings tab
  await page.click('[data-rep-tab="ratings"]');
  await expect(page.locator('#rep-panel-ratings')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('#rep-panel-ratings table')).toHaveCount(2);

  // 5. Click Next Match -> returns to Pre-Match with persisted Plan A/B and progressed familiarity
  await page.click('#rep-next');
  await expect(page.locator('#pm-title')).toHaveText('Matchday setup');
  await expect(page.locator('#pm-slots-summary')).toContainText('Gegenpress');
  await expect(page.locator('#pm-slots-summary')).toContainText('Low Block');
  const gegenText = (await page.locator('[data-preset-id="gegenpress"] .pm-fam-summary').textContent()) ?? '';
  const matchPct = gegenText.match(/(\d+)%/);
  expect(matchPct).toBeTruthy();
  expect(Number(matchPct?.[1])).toBeGreaterThan(50);

  expect(errors).toEqual([]);
});

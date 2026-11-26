import { test, expect } from '@playwright/test';

/**
 * Every flow plays the same match (`?seed=`, src/runtime/matchSeed.js) instead of a random one per page load. Seed 22
 * (sample squads, human home side, VAR) has no forced decision, no red card and no injury to the human side all
 * match, so nothing the test did not ask for can lock the Manager panel open or pause play mid-flow.
 */
const MATCH = '/?seed=22#match';

test('Full Match boot, PT/EN toggle, Manager formation/sub, and Best Moments', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(MATCH);
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
  // One play / pause control: > before kick-off (dimmed), no separate speed badge
  await expect(page.locator('#ctrl-pacing')).toHaveCount(0);
  await expect(page.locator('#ctrl-play')).toHaveText('>');
  await expect(page.locator('#ctrl-play')).toHaveClass(/is-paused/);
  await expect(page.locator('#ctrl-play')).toHaveAttribute('aria-label', 'Reproduzir');
  await page.click('#sb-lang-btn');
  await expect(page.locator('#sb-lang-btn')).toHaveText('EN');
  await expect(page.locator('#ctrl-play')).toHaveAttribute('aria-label', 'Play');
  await expect(page.locator('#ctrl-play')).toHaveAttribute('title', 'Play');

  // Simplified controls: no speed slider, mode toggle, speed badge or save / load, only the one Play / Pause on the right
  await expect(page.locator('#ctrl-speed')).toHaveCount(0);
  await expect(page.locator('#ctrl-mode')).toHaveCount(0);
  await expect(page.locator('.ctrl-transport button')).toHaveCount(1);
  await expect(page.locator('#ctrl-save, #ctrl-load, #btn-save, #btn-load')).toHaveCount(0);
  const playBox = await page.locator('#ctrl-play').boundingBox();
  const barBox = await page.locator('.ctrl-row').boundingBox();
  const coachBox = await page.locator('#ctrl-manager').boundingBox();
  expect(playBox && barBox && coachBox).toBeTruthy();
  if (playBox && barBox && coachBox) {
    expect(barBox.x + barBox.width - (playBox.x + playBox.width)).toBeLessThan(4); // pinned to the right edge
    expect(Math.abs(playBox.height - coachBox.height)).toBeLessThan(2); // same height as the left-hand buttons
  }

  // Icon-only Stats / Coach buttons with localized accessible names
  await expect(page.locator('#ctrl-stats svg')).toHaveCount(1);
  await expect(page.locator('#ctrl-manager svg')).toHaveCount(1);
  await expect(page.locator('#ctrl-stats')).toHaveText('');
  await expect(page.locator('#ctrl-stats')).toHaveAttribute('aria-label', 'Match statistics');
  await expect(page.locator('#ctrl-manager')).toHaveAttribute('aria-label', 'Squad & substitutions');
  await expect(page.locator('#ctrl-manager')).toHaveAttribute('title', 'Squad & substitutions');

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
  await expect(page.locator('#ctrl-play')).toHaveClass(/is-live/); // slowed to 1x for the coach
  // Pause so a dead-ball kickoff doesn't immediately execute the confirmed sub before the cancel check. The open
  // Manager drawer covers the controls bar once its slide-up ends, so dispatch the click (a real click would only
  // land while the drawer is still sliding: a race).
  await page.locator('#ctrl-play').dispatchEvent('click');
  await expect(page.locator('#mgr-minimap .mgr-node')).toHaveCount(11);
  // Localized hint and the single Pending list (no separate "staged" list)
  await expect(page.locator('#mgr-hint')).toHaveText('Tap 2 pitch players to swap, or pitch + bench to sub');
  await expect(page.locator('#mgr-pending-title')).toHaveText('Pending');
  await expect(page.locator('#mgr-staged-list')).toHaveCount(0);
  await expect(page.locator('#close-mgr')).toHaveText('Close');
  await expect(page.locator('#close-mgr')).toBeEnabled();

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
  await expect(page.locator('#mgr-pending-list .mgr-pend-item.is-draft')).toHaveCount(3);
  await expect(page.locator('#mgr-pending-list .mgr-pend-item.is-queued')).toHaveCount(0);
  await expect(page.locator('#mgr-confirm')).toBeEnabled();

  // Telemetry on minimap nodes and bench rows: live rating, fitness, morale (no age)
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-rating')).toHaveCount(11);
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-rating').first()).toHaveText(/^\d{1,2}\.\d$/);
  await expect(page.locator('#mgr-bench .mgr-player .mgr-rating').first()).toHaveText('6.0');
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-age')).toHaveCount(0);
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-morale')).toHaveCount(11);
  await expect(page.locator('#mgr-minimap .mgr-node .mgr-fit-fill')).toHaveCount(11);
  await expect(page.locator('#mgr-bench .mgr-player .mgr-age')).toHaveCount(0);
  await expect(page.locator('#mgr-bench .mgr-player .mgr-morale').first()).toHaveText(/\d+%/);
  await expect(page.locator('#mgr-bench .mgr-player .mgr-fit-fill').first()).toBeVisible();

  await page.click('#mgr-confirm');
  await expect(page.locator('#mgr-status')).toContainText('Confirmed');
  await expect(page.locator('#mgr-pending-list .mgr-pend-item.is-draft')).toHaveCount(0);
  // Paused at a stoppage the sub is made at once; in open play it waits for the next one, listed as
  // confirmed in the same Pending list, with Confirm and staging locked until then.
  const status = (await page.locator('#mgr-status').textContent()) ?? '';
  if (status.includes('substitution made')) {
    await expect(page.locator('#mgr-pending-list .mgr-pend-item')).toHaveCount(0);
    await expect(page.locator('.comm-broadcast')).toHaveClass(/is-sub/);
  } else {
    await expect(page.locator('#mgr-pending-list .mgr-pend-item.is-queued')).toHaveCount(3);
    await expect(page.locator('#mgr-confirm')).toBeDisabled();
    await expect(page.locator('#mgr-hint')).toHaveText('Confirmed changes are waiting for the next stoppage');
    await expect(page.locator('[data-in-index]').first()).toBeDisabled();
    await page.locator('[data-cancel-seq]').first().click();
    await expect(page.locator('#mgr-pending-list [data-cancel-seq]')).toHaveCount(0);
  }
  // PT: the same panel in Portuguese (the language button sits under the open drawer: dispatch the click)
  await page.locator('#sb-lang-btn').dispatchEvent('click');
  await expect(page.locator('#mgr-pending-title')).toHaveText('Pendente');
  await expect(page.locator('#mgr-drawer-title')).toHaveText('Treinador');
  await expect(page.locator('#close-mgr')).toHaveText('Fechar');
  await expect(page.locator('#mgr-confirm')).toHaveText('Confirmar');
  await page.locator('#sb-lang-btn').dispatchEvent('click');
  await expect(page.locator('#mgr-pending-title')).toHaveText('Pending');
  await page.click('#close-mgr');

  // Playback resume & pause works cleanly
  await page.click('#ctrl-play');
  await page.waitForTimeout(200);
  await page.click('#ctrl-play'); // pause

  // Paused again: the one button shows >, dimmed
  await expect(page.locator('#ctrl-play')).toHaveText('>');
  await expect(page.locator('#ctrl-play')).toHaveClass(/is-paused/);
  await expect(page.locator('#ctrl-play')).toHaveAttribute('title', 'Play');

  expect(errors).toEqual([]);
});

test('A HIGH injury to the human team opens the Manager in mandatory replacement mode', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  /** @param {string} name @param {any[]} args */
  const dev = (name, ...args) => page.evaluate(([n, a]) => /** @type {any} */ (globalThis).__freefootDev[n](...a), /** @type {const} */ ([name, args]));

  await page.goto(MATCH);
  await page.click('#sb-lang-btn'); // EN
  await expect(page.locator('#ctrl-play')).toHaveAttribute('aria-label', 'Play');
  await expect.poll(() => page.evaluate(() => typeof (/** @type {any} */ (globalThis).__freefootDev))).toBe('object');
  expect(await dev('seed')).toBe(22);
  await page.click('#ctrl-play');
  await page.waitForTimeout(1500);
  await dev('injure', 8);

  await expect(page.locator('#mgr-drawer')).toHaveClass(/is-open/);
  await expect(page.locator('#mgr-forced')).toContainText('is injured and must come off');
  await expect(page.locator('#mgr-forced [data-forced-none]')).toHaveCount(0);
  await expect(page.locator('#mgr-minimap [data-out-index="8"]')).toHaveClass(/is-forced/);
  await expect(page.locator('#mgr-minimap [data-out-index="8"]')).toHaveClass(/is-selected/);
  await expect(page.locator('#close-mgr')).toBeDisabled();
  await expect(page.locator('#mgr-confirm')).toBeDisabled();
  // Neither the coach button nor Play gets past it (both sit under the drawer: dispatch the clicks).
  await page.locator('#ctrl-manager').dispatchEvent('click');
  await page.locator('#ctrl-stats').dispatchEvent('click');
  await expect(page.locator('#mgr-drawer')).toHaveClass(/is-open/);
  await page.locator('#ctrl-play').dispatchEvent('click');
  expect(await dev('playbackState')).toBe('PAUSED_FORCED');

  // An extra swap in the same batch, then the replacement from the bench.
  await page.locator('#mgr-minimap [data-out-index="9"]').click();
  await page.locator('#mgr-minimap [data-out-index="10"]').click();
  await page.locator('#mgr-bench [data-in-index]').first().click();
  await expect(page.locator('#mgr-pending-list .mgr-pend-item.is-draft')).toHaveCount(2);
  await expect(page.locator('#mgr-pending-list .mgr-pend-item.is-forced')).toHaveCount(1);
  await expect(page.locator('#mgr-confirm')).toBeEnabled();
  await expect(page.locator('#close-mgr')).toBeDisabled();
  await page.click('#mgr-confirm');

  await expect(page.locator('#mgr-status')).toContainText('substitution made');
  await expect(page.locator('#mgr-forced')).toHaveClass(/is-hidden/);
  await expect(page.locator('#close-mgr')).toBeEnabled();
  expect(await dev('playbackState')).toBe('PAUSED');
  await page.click('#close-mgr');
  await expect(page.locator('#mgr-drawer')).not.toHaveClass(/is-open/);
  await page.click('#ctrl-play');
  await expect(page.locator('#ctrl-play')).toHaveText('||');
  expect(errors).toEqual([]);
});

test('Tactics panel: two tabs, nine instructions, Confirm queues them for the next stoppage, PT / EN', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(MATCH);
  await page.click('#sb-lang-btn'); // EN
  await expect(page.locator('#ctrl-tactics svg')).toHaveCount(1);
  await expect(page.locator('#ctrl-tactics')).toHaveAttribute('aria-label', 'Team tactics');
  const statsBox = await page.locator('#ctrl-stats').boundingBox();
  const tacBox = await page.locator('#ctrl-tactics').boundingBox();
  const coachBox = await page.locator('#ctrl-manager').boundingBox();
  expect(statsBox && tacBox && coachBox).toBeTruthy();
  if (statsBox && tacBox && coachBox) {
    expect(tacBox.x).toBeGreaterThan(statsBox.x);
    expect(coachBox.x).toBeGreaterThan(tacBox.x);
  }

  // Into open play, then pause, so the change usually has to wait for a stoppage.
  await page.click('#ctrl-play');
  await page.waitForTimeout(3000);
  await page.click('#ctrl-play');
  await expect(page.locator('#ctrl-play')).toHaveText('>');
  await page.click('#ctrl-tactics');
  await expect(page.locator('#tac-drawer')).toHaveClass(/is-open/);
  await expect(page.locator('#tac-drawer-title')).toHaveText('Tactics');
  await expect(page.locator('.tac-tab')).toHaveText(['In possession', 'Out of possession']);
  await expect(page.locator('#tac-rows .tac-row')).toHaveCount(5);
  await expect(page.locator('[data-row="attackFocus"] .tac-opt')).toHaveText(['Wings', 'Mixed', 'Centre']);
  await expect(page.locator('#tac-confirm')).toBeDisabled();
  await page.click('[data-instr="attackFocus"][data-opt="wings"]');
  await expect(page.locator('[data-instr="attackFocus"][data-opt="wings"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-row="attackFocus"] .tac-hint')).toHaveText('Plays down the flanks · fewer central entries');
  await expect(page.locator('.tac-tab').first().locator('.tac-dot')).toHaveCount(1);
  await page.click('[data-tac-tab="outOfPossession"]');
  await expect(page.locator('#tac-rows .tac-row')).toHaveCount(4);
  await page.click('[data-instr="defensiveLine"][data-opt="high"]');
  await page.click('#tac-confirm');
  await expect(page.locator('#tac-confirm')).toBeDisabled();
  const waiting = await page.locator('#tac-status').isVisible();
  if (waiting) {
    // In open play: listed as waiting, here and in the Manager's one Pending list (which stays unlocked).
    await expect(page.locator('#tac-status')).toHaveText('Applies at the next stoppage.');
    await page.click('#close-tac');
    await expect(page.locator('#tac-drawer')).not.toHaveClass(/is-open/);
    await page.click('#ctrl-manager');
    await expect(page.locator('#mgr-pending-list')).toContainText('New team instructions');
    await expect(page.locator('#mgr-hint')).not.toHaveText('Confirmed changes are waiting for the next stoppage');
    await page.click('#close-mgr');
    // Play on to the next stoppage: the instructions are carried out.
    await page.click('#ctrl-play');
    await expect(page.locator('#mgr-pending-list')).not.toContainText('New team instructions', { timeout: 90000 });
    await page.click('#ctrl-play');
    await page.click('#ctrl-tactics');
  }
  await expect(page.locator('#tac-status')).toHaveClass(/is-hidden/);
  await expect(page.locator('[data-instr="defensiveLine"][data-opt="high"]')).toHaveClass(/is-active/);

  // PT
  await page.locator('#sb-lang-btn').dispatchEvent('click');
  await expect(page.locator('#tac-drawer-title')).toHaveText('Tática');
  await expect(page.locator('.tac-tab')).toHaveText(['Com Bola', 'Sem Bola']);
  await expect(page.locator('[data-row="defensiveLine"] .tac-label')).toHaveText('Linha defensiva');
  await page.click('#close-tac');
  await expect(page.locator('#tac-drawer')).not.toHaveClass(/is-open/);

  expect(errors).toEqual([]);
});

test('Shouts panel: ten shouts, a tap sends the shout, it cools down; receptiveness; PT / EN', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(MATCH);
  await page.click('#sb-lang-btn'); // EN
  await expect(page.locator('#ctrl-shouts svg')).toHaveCount(1);
  await expect(page.locator('#ctrl-shouts')).toHaveAttribute('aria-label', 'Touchline shouts');
  const tacBox = await page.locator('#ctrl-tactics').boundingBox();
  const shBox = await page.locator('#ctrl-shouts').boundingBox();
  const coachBox = await page.locator('#ctrl-manager').boundingBox();
  expect(tacBox && shBox && coachBox).toBeTruthy();
  if (tacBox && shBox && coachBox) {
    expect(shBox.x).toBeGreaterThan(tacBox.x);
    expect(coachBox.x).toBeGreaterThan(shBox.x);
  }

  await page.click('#ctrl-play');
  await page.waitForTimeout(2000);
  await page.click('#ctrl-play');
  await expect(page.locator('#ctrl-play')).toHaveText('>');
  await page.click('#ctrl-shouts');
  await expect(page.locator('#sh-drawer')).toHaveClass(/is-open/);
  await expect(page.locator('#sh-drawer-title')).toHaveText('Shouts');
  await expect(page.locator('#sh-grid .sh-btn')).toHaveCount(10);
  await expect(page.locator('#sh-grid .sh-label').first()).toHaveText('Focus');
  await expect(page.locator('#sh-mood')).toHaveText('Team mood: Engaged');
  await page.click('[data-shout="focus"]');
  // At a stoppage it is carried out at once; in play it goes with the next tick.
  await page.click('#close-sh');
  await expect(page.locator('#sh-drawer')).not.toHaveClass(/is-open/);
  await page.click('#ctrl-play');
  await page.waitForTimeout(1000);
  await page.click('#ctrl-play');
  await page.click('#ctrl-shouts');
  await expect(page.locator('[data-shout="focus"]')).toBeDisabled();
  await expect(page.locator('[data-shout="focus"] .sh-cd')).toHaveText(/^\d+′$/);
  await expect(page.locator('[data-shout="praise"]')).toBeEnabled();

  // PT
  await page.locator('#sb-lang-btn').dispatchEvent('click');
  await expect(page.locator('#sh-drawer-title')).toHaveText('Gritos');
  await expect(page.locator('#sh-grid .sh-label').first()).toContainText('Concentração');
  await expect(page.locator('#sh-mood')).toHaveText('Ânimo da equipa: Atenta');
  await page.click('#close-sh');
  await expect(page.locator('#sh-drawer')).not.toHaveClass(/is-open/);

  expect(errors).toEqual([]);
});

test('VAR: the HUD banner shows VAR CHECK during the review, then the decision, and clears when play resumes; PT / EN', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(MATCH);
  await page.click('#sb-lang-btn'); // EN
  await expect(page.locator('.var-hud')).toHaveClass(/is-hidden/);
  await page.click('#ctrl-play');
  await page.waitForTimeout(1500);
  await expect.poll(() => page.evaluate(() => typeof (/** @type {any} */ (globalThis).__freefootDev))).toBe('object');
  expect(await page.evaluate(() => /** @type {any} */ (globalThis).__freefootDev.varCheck())).toBe(true);
  // The review: VAR CHECK with what is being checked (play is held at 1x). From fast-forward, Auto Highlights
  // first replays the 7 s build-up, so the check reaches the screen after it.
  await expect(page.locator('.var-hud')).toHaveClass(/is-check/, { timeout: 15000 });
  await expect(page.locator('.var-hud-headline')).toHaveText('VAR CHECK');
  await expect(page.locator('.var-hud-detail')).toHaveText('Possible penalty');
  // PT while it is up.
  await page.locator('#sb-lang-btn').dispatchEvent('click');
  await expect(page.locator('.var-hud-headline')).toHaveText('VERIFICAÇÃO VAR');
  await page.locator('#sb-lang-btn').dispatchEvent('click');
  // The decision after the review (10 s at 1x), then the banner clears once the penalty is taken.
  await expect(page.locator('.var-hud-headline')).toHaveText('PENALTY', { timeout: 20000 });
  await expect(page.locator('.var-hud')).toHaveClass(/is-overturned/);
  await expect(page.locator('.comm-broadcast')).toHaveAttribute('data-type', /VAR_DECISION|PENALTY_AWARDED/);
  await expect(page.locator('.var-hud')).toHaveClass(/is-hidden/, { timeout: 20000 });
  expect(errors).toEqual([]);
});

test('Stats drawer updates live during the match, with the match minute', async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(MATCH);
  await expect(page.locator('#ctrl-play')).toHaveText('>');
  await page.click('#ctrl-play');
  await expect(page.locator('#ctrl-play')).toHaveText('||');
  await expect(page.locator('#ctrl-play')).not.toHaveClass(/is-paused/);
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

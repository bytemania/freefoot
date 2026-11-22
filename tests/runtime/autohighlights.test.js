import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { AUTO_COOLDOWN_TICKS, AUTO_FAST_SPEED, AUTO_LOCKOUT_TICKS, MatchController, isDangerousTick } from '../../src/runtime/MatchController.js';
import { generateSquad } from '../../src/shared/squadgen.js';

function makeInput(seed = 33, homeCtrl = 'human') {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: /** @type {'human' | 'ai'} */ (homeCtrl) });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return { v: /** @type {const} */ (1), seed, configHash, home, away };
}

test('isDangerousTick detects attacking box entry, box passes, breakaways, set pieces, and key events', () => {
  const ctrl = new MatchController({ input: makeInput(1), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  const s = ctrl.engine.state;

  // Calm midfield
  s.restart.state = 'IN_PLAY';
  s.ball.x = 52.5;
  s.ball.y = 34;
  s.ball.owner = 6;
  s.ball.pass = null;
  assert.equal(isDangerousTick(s, []), false);

  // Calm final-third circulation outside penalty box stays fast
  s.ball.x = 80;
  s.players[6].x = 80;
  assert.equal(isDangerousTick(s, []), false);

  // Attacking box entry (home team 0 attacking x=105)
  s.ball.x = 90;
  s.ball.y = 34;
  assert.equal(isDangerousTick(s, []), true);

  // Pass launched into attacking penalty area from midfield
  s.ball.owner = -1;
  s.ball.x = 55;
  s.ball.pass = { passer: 6, receiver: 9, kind: 'LONG', restart: false, accurate: true, px: 95, py: 34, tried: [] };
  assert.equal(isDangerousTick(s, []), true);
  s.ball.pass = null;

  // Dangerous set pieces
  s.restart.state = 'DEAD_BALL';
  s.restart.kind = 'CORNER';
  assert.equal(isDangerousTick(s, []), true);
  s.restart.kind = 'PENALTY';
  assert.equal(isDangerousTick(s, []), true);
  s.restart.kind = 'FREE_KICK';
  s.restart.direct = true;
  s.restart.teamIndex = 0;
  s.restart.x = 82; // 23m from x=105 (<= 26m)
  s.restart.y = 34;
  assert.equal(isDangerousTick(s, []), true);
  s.restart.x = 75; // 30m away (> 26m) -> calm
  assert.equal(isDangerousTick(s, []), false);

  // Key highlight events trigger danger even during spatial lockout
  s.restart.state = 'IN_PLAY';
  s.ball.x = 52.5;
  assert.equal(isDangerousTick(s, [{ type: 'YELLOW_CARD' }]), false);
  assert.equal(isDangerousTick(s, [{ type: 'SHOT' }]), true);
  assert.equal(isDangerousTick(s, [{ type: 'GOAL' }], { allowSpatial: false, allowMinorEvents: false }), true);
  assert.equal(isDangerousTick(s, [{ type: 'PASS' }]), false);

  ctrl.destroy();
});

test('Auto Highlights fast-forwards calm play at 60x, drops to watchSpeed on danger, and holds 120-tick cooldown + lockout', () => {
  const ctrl = new MatchController({ input: makeInput(5, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.setSpeed(2); // user's preferred watchSpeed = 2x
  assert.equal(ctrl.watchSpeed, 2);
  ctrl.play();

  // At kick-off (ball at 52.5, calm): effectiveSpeed is 60x (FAST)
  assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED);
  assert.equal(ctrl.autoPacing, 'FAST');

  // Step until danger is triggered
  let frames = 0;
  while (ctrl.autoPacing === 'FAST' && frames++ < 400) {
    ctrl.tickFrame(1 / 60);
  }
  assert.equal(ctrl.autoPacing, 'WATCH', 'should drop to WATCH on danger');
  assert.equal(ctrl.autoCooldownTicks, AUTO_COOLDOWN_TICKS);
  assert.equal(ctrl.getEffectiveSpeed(), 2, 'should preserve user watchSpeed (2x)');

  // Manually move ball back to midfield and verify 120-tick hysteresis cooldown holds WATCH until 0, then enters lockout
  ctrl.engine.state.restart.state = 'IN_PLAY';
  ctrl.engine.state.ball.x = 52.5;
  ctrl.engine.state.ball.y = 34;
  ctrl.engine.state.ball.owner = -1;
  ctrl.engine.state.ball.pass = null;
  ctrl.autoCooldownTicks = 3;
  assert.equal(ctrl.getEffectiveSpeed(), 2); // still WATCH while cooldown > 0
  ctrl.autoCooldownTicks = 0;
  ctrl.autoLockoutTicks = AUTO_LOCKOUT_TICKS;
  assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED); // back to 60x once cooldown expires

  // Manual pause (0x) overrides auto-pacing immediately
  ctrl.setSpeed(0);
  assert.equal(ctrl.playbackState, 'PAUSED');
  assert.equal(ctrl.watchSpeed, 2, 'pausing with 0x must preserve watchSpeed');

  ctrl.destroy();
});

test('Auto Highlights triggers FM-target ~8-12 highlights per 90-minute match (6-14 avg band over 10 seeds)', () => {
  const counts = [];
  for (let seed = 1; seed <= 10; seed++) {
    const ctrl = new MatchController({ input: makeInput(seed, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
    ctrl.play();
    let prev = ctrl.autoPacing;
    let triggers = 0;
    while (ctrl.playbackState !== 'FULL_TIME') {
      if (ctrl.playbackState === 'HALF_TIME' || ctrl.playbackState === 'PAUSED_FORCED') ctrl.continue();
      ctrl.tickFrame(1 / 60);
      if (ctrl.autoPacing === 'WATCH' && prev === 'FAST') triggers++;
      prev = ctrl.autoPacing;
    }
    counts.push(triggers);
    ctrl.destroy();
  }
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  assert.ok(avg >= 6 && avg <= 14, `expected avg highlights in 6-14 band, got ${avg.toFixed(1)} (${counts.join(', ')})`);
});

test('FORCED_DECISION overrides Auto Highlights and pauses immediately in PAUSED_FORCED', () => {
  const ctrl = new MatchController({ input: makeInput(7, 'human'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  ctrl.engine.state.awaitingDecision = true;
  ctrl.engine.state.teams[0].forcedDecision = true;
  const frame = ctrl.tickFrame(1 / 60);
  assert.equal(frame.playbackState, 'PAUSED_FORCED');
  assert.equal(ctrl.running, false);
  ctrl.destroy();
});

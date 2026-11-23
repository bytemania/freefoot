import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { AUTO_COOLDOWN_TICKS, AUTO_FAST_SPEED, MatchController, isDangerousTick } from '../../src/runtime/MatchController.js';
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
  s.restart.x = 82; // 23m from x=105 (<= 28m)
  s.restart.y = 34;
  assert.equal(isDangerousTick(s, []), true);
  s.restart.x = 78; // 27m away (<= 28m)
  assert.equal(isDangerousTick(s, []), true);
  s.restart.x = 75; // 30m away (> 28m) -> calm
  assert.equal(isDangerousTick(s, []), false);
  s.restart.direct = false; // an indirect free kick near goal is not a direct threat
  s.restart.x = 82;
  assert.equal(isDangerousTick(s, []), false);

  // Crucial events on the tick
  s.restart.state = 'IN_PLAY';
  s.ball.x = 52.5;
  assert.equal(isDangerousTick(s, [{ type: 'YELLOW_CARD' }]), false);
  assert.equal(isDangerousTick(s, [{ type: 'SHOT' }]), true);
  for (const type of ['GOAL', 'SAVE', 'PENALTY_AWARDED', 'RED_CARD', 'INJURY']) assert.equal(isDangerousTick(s, [{ type }]), true, type);
  assert.equal(isDangerousTick(s, [{ type: 'SHOT', meta: { result: 'WOODWORK' } }]), true);
  assert.equal(isDangerousTick(s, [{ type: 'PASS' }]), false);

  ctrl.destroy();
});

test('Auto Highlights fast-forwards calm play at 60x, drops to watchSpeed on danger, and holds the 120-tick cooldown', () => {
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

  // Manually move ball back to midfield and verify the 120-tick hysteresis cooldown holds WATCH until 0
  ctrl.engine.state.restart.state = 'IN_PLAY';
  ctrl.engine.state.ball.x = 52.5;
  ctrl.engine.state.ball.y = 34;
  ctrl.engine.state.ball.owner = -1;
  ctrl.engine.state.ball.pass = null;
  ctrl.autoCooldownTicks = 3;
  assert.equal(ctrl.getEffectiveSpeed(), 2); // still WATCH while cooldown > 0
  ctrl.autoCooldownTicks = 0;
  assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED); // back to 60x once cooldown expires

  // Manual pause (0x) overrides auto-pacing immediately
  ctrl.setSpeed(0);
  assert.equal(ctrl.playbackState, 'PAUSED');
  assert.equal(ctrl.watchSpeed, 2, 'pausing with 0x must preserve watchSpeed');

  ctrl.destroy();
});

/**
 * Wraps `ctrl.engine.step` so every simulated tick records whether it was a
 * crucial moment (crucial events on that tick or live ball danger).
 * @param {MatchController} ctrl
 * @param {boolean[]} flags
 */
function recordDanger(ctrl, flags) {
  const engine = ctrl.engine;
  const step = engine.step.bind(engine);
  engine.step = (n) => {
    const r = step(n);
    flags.push(isDangerousTick(engine.state, r.events));
    return r;
  };
}

test('Auto Highlights never batches 60x past a crucial tick, over full matches (every shot, goal and box entry plays live)', () => {
  let fastTicks = 0;
  let totalTicks = 0;
  let brokeOnSpatial = 0;
  // A shot / goal / save landing inside a calm 60x stretch is rare (about 1 per 12 matches on the old trajectories, much rarer since body separation and ball-body blocking), so sample enough matches.
  for (let seed = 1; seed <= 12; seed++) {
    const ctrl = new MatchController({ input: makeInput(seed, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
    /** @type {boolean[]} */
    const flags = [];
    recordDanger(ctrl, flags);
    ctrl.play();
    while (ctrl.playbackState !== 'FULL_TIME') {
      if (ctrl.playbackState === 'HALF_TIME' || ctrl.playbackState === 'PAUSED_FORCED') ctrl.continue();
      const fast = ctrl.getEffectiveSpeed() === AUTO_FAST_SPEED;
      flags.length = 0;
      const frame = ctrl.tickFrame(1 / 60);
      totalTicks += flags.length;
      if (!fast) continue;
      fastTicks += flags.length;
      // Inside a 60x batch only the last simulated tick may be crucial ...
      for (let i = 0; i < flags.length - 1; i++) assert.equal(flags[i], false, `seed ${seed}: batched past a crucial tick (${i + 1}/${flags.length}) at ${ctrl.engine.tick}`);
      // ... and when it is, playback is live from that very tick.
      if (flags[flags.length - 1]) {
        assert.equal(ctrl.autoPacing, 'WATCH');
        assert.equal(ctrl.getEffectiveSpeed(), 1);
        assert.equal(ctrl.autoCooldownTicks, AUTO_COOLDOWN_TICKS);
        if (!frame.newEvents.some((e) => e.tick === ctrl.engine.tick && ['GOAL', 'SHOT', 'SAVE'].includes(e.type))) brokeOnSpatial++;
      }
    }
    ctrl.destroy();
  }
  // A shot / goal / save landing in a calm 60x stretch is now very rare (a shot nearly always follows a box entry), so a live
  // match is not required to show one; the exact-tick tests below cover GOAL, SHOT and SAVE with a stubbed engine.
  assert.ok(brokeOnSpatial > 0, 'some 60x batches end on a box entry / set-piece tick');
  const share = fastTicks / totalTicks;
  assert.ok(share > 0.5 && share < 0.95, `calm play still fast-forwards (fast share ${share.toFixed(2)})`);
});

for (const type of ['GOAL', 'SHOT', 'SAVE', 'PENALTY_AWARDED', 'RED_CARD', 'INJURY']) {
  test(`Auto Highlights breaks out of a 60x batch on the exact tick of a ${type} and plays it at 1x`, () => {
    const ctrl = new MatchController({ input: makeInput(5, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
    ctrl.play();
    assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED);
    let calls = 0;
    ctrl.engine.step = () => {
      calls++;
      return { ticksRun: 1, events: calls === 5 ? [/** @type {any} */ ({ type, tick: calls })] : [], stoppedFor: null };
    };
    const frame = ctrl.tickFrame(1 / 60); // a 60x frame budgets 20 ticks
    assert.equal(calls, 5, 'the batch stops on the crucial tick');
    assert.equal(frame.newEvents.length, 1);
    assert.equal(ctrl.autoPacing, 'WATCH');
    assert.equal(frame.autoPacing, 'WATCH');
    assert.equal(ctrl.getEffectiveSpeed(), 1);
    // Live from here: a 1/60 s frame now runs well under one tick.
    ctrl.tickFrame(1 / 60);
    assert.ok(calls <= 6);
    ctrl.destroy();
  });
}

test('Auto Highlights breaks out of a 60x batch on the tick an attacker enters the penalty area', () => {
  const ctrl = new MatchController({ input: makeInput(5, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  const s = ctrl.engine.state;
  assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED);
  let calls = 0;
  ctrl.engine.step = () => {
    calls++;
    s.restart.state = 'IN_PLAY';
    s.ball.pass = null;
    s.ball.owner = 9;
    const x = calls >= 3 ? 90 : 60; // home attacks x = 105: inside the box from tick 3
    s.ball.x = s.players[9].x = x;
    s.ball.y = s.players[9].y = 34;
    // keep defenders goal-side so midfield possession is not a breakaway
    for (let i = 18; i < 24; i++) s.players[i].x = 100;
    return { ticksRun: 1, events: [], stoppedFor: null };
  };
  ctrl.tickFrame(1 / 60);
  assert.equal(calls, 3);
  assert.equal(ctrl.autoPacing, 'WATCH');
  assert.equal(ctrl.getEffectiveSpeed(), 1);
  ctrl.destroy();
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

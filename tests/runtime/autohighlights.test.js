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

const AH = config.playback.autoHighlights;
const HI = config.playback.highlights;
/** The shipped config turns the spatial lead-up triggers off (the pre-roll shows the build-up); this one turns them on. */
const SPATIAL = structuredClone(config);
Object.assign(SPATIAL.playback.autoHighlights, { leadUpGoalDist: 12, passTargetGoalDist: 9, breakawayAlong: 80 });
const SAH = SPATIAL.playback.autoHighlights;

test('the shipped Auto Highlights config replays a 5-10 s pre-roll instead of the spatial lead-up triggers', () => {
  assert.ok(AH.preRollTicks >= 100 && AH.preRollTicks <= 200, `preRollTicks ${AH.preRollTicks}`);
  assert.deepEqual([AH.leadUpGoalDist, AH.passTargetGoalDist, AH.breakawayAlong], [0, 0, 0]);
  const ctrl = new MatchController({ input: makeInput(1), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  const s = ctrl.engine.state;
  s.restart.state = 'IN_PLAY';
  s.ball.owner = 9;
  s.ball.pass = null;
  s.ball.x = s.players[9].x = 99;
  s.ball.y = s.players[9].y = 34;
  assert.equal(isDangerousTick(s, []), false, 'a carrier closing in is not by itself a trigger');
  ctrl.destroy();
});

test('isDangerousTick: only crucial moments (goals, penalties, red cards, woodwork, big saves, high-xG chances, a chance being built when on)', () => {
  const ctrl = new MatchController({ input: makeInput(1), config: SPATIAL, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  const s = ctrl.engine.state;

  // Calm midfield
  s.restart.state = 'IN_PLAY';
  s.ball.x = 52.5;
  s.ball.y = 34;
  s.ball.owner = 6;
  s.ball.pass = null;
  s.players[6].x = 52.5;
  assert.equal(isDangerousTick(s, []), false);

  // Final-third circulation and a routine box entry on the wing stay fast (home team 0 attacks x = 105)
  s.ball.x = s.players[6].x = 80;
  assert.equal(isDangerousTick(s, []), false);
  s.ball.x = s.players[6].x = 92;
  s.ball.y = 16;
  for (let i = 18; i < 36; i++) s.players[i].x = 100; // defenders goal-side: no breakaway
  assert.equal(isDangerousTick(s, []), false, 'a wide box entry is not yet a chance');

  // The chance being built: the carrier close to the goal centre
  s.ball.x = s.players[6].x = 105 - (SAH.leadUpGoalDist - 2);
  s.ball.y = 34;
  assert.equal(isDangerousTick(s, []), true);

  // A pass in flight: only one aimed at the heart of the box counts
  s.ball.owner = -1;
  s.ball.x = 55;
  s.ball.pass = { passer: 6, receiver: 9, kind: 'LONG', restart: false, accurate: true, px: 92, py: 20, tried: [] };
  assert.equal(isDangerousTick(s, []), false, 'a ball to the wing of the box');
  s.ball.pass.px = 105 - (SAH.passTargetGoalDist - 2);
  s.ball.pass.py = 34;
  assert.equal(isDangerousTick(s, []), true, 'a ball to the penalty spot');
  s.ball.pass = null;

  // A clean breakaway: past breakawayAlong with no outfield defender goal-side
  s.ball.owner = 6;
  s.ball.x = s.players[6].x = SAH.breakawayAlong + 2;
  s.ball.y = 20;
  for (let i = 18; i < 36; i++) if (s.players[i].isKeeper !== 1) s.players[i].x = 60;
  assert.equal(isDangerousTick(s, []), true, 'breakaway');
  s.players[25].x = 100;
  assert.equal(isDangerousTick(s, []), false, 'one defender goal-side: not a breakaway');

  // Set pieces: a penalty, not a corner
  s.restart.state = 'DEAD_BALL';
  s.ball.x = s.players[6].x = 52.5;
  s.restart.kind = 'CORNER';
  assert.equal(isDangerousTick(s, []), false, 'routine corner');
  s.restart.kind = 'PENALTY';
  assert.equal(isDangerousTick(s, []), true, 'penalty');

  // Events on the tick
  s.restart.state = 'IN_PLAY';
  for (const type of ['GOAL', 'PENALTY_AWARDED', 'RED_CARD', 'BIG_CHANCE']) assert.equal(isDangerousTick(s, [{ type }]), true, type);
  assert.equal(isDangerousTick(s, [{ type: 'SHOT', meta: { result: 'WOODWORK', xg: 0.05 } }]), true, 'woodwork');
  assert.equal(isDangerousTick(s, [{ type: 'SHOT', meta: { result: 'SAVED', xg: HI.bigChanceXg + 0.01 } }]), true, 'high-xG shot');
  assert.equal(isDangerousTick(s, [{ type: 'SAVE', meta: { psxg: HI.majorSavePsxg + 0.01 } }]), true, 'big save');
  assert.equal(isDangerousTick(s, [{ type: 'SHOT', meta: { result: 'OFF_TARGET', xg: 0.04 } }]), false, 'low-xG shot');
  assert.equal(isDangerousTick(s, [{ type: 'SAVE', meta: { psxg: 0.05 } }]), false, 'routine save');
  for (const type of ['FOUL', 'YELLOW_CARD', 'INJURY', 'PASS', 'CORNER_AWARDED']) assert.equal(isDangerousTick(s, [{ type }]), false, type);

  ctrl.destroy();
});

test('Auto Highlights fast-forwards calm play, drops to watchSpeed on danger, and holds the live cooldown', () => {
  const ctrl = new MatchController({ input: makeInput(5, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.setSpeed(2); // user's preferred watchSpeed = 2x
  assert.equal(ctrl.watchSpeed, 2);
  ctrl.play();

  // At kick-off (ball at 52.5, calm): effectiveSpeed is the fast speed
  assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED);
  assert.equal(ctrl.autoPacing, 'FAST');

  // Step until danger is triggered (a substitution's touchline hold also shows live without starting the cooldown: step past it)
  let frames = 0;
  while (ctrl.autoCooldownTicks === 0 && frames++ < 6000) {
    ctrl.tickFrame(1 / 60);
  }
  assert.equal(ctrl.autoPacing, 'WATCH', 'should drop to WATCH on danger');
  assert.equal(ctrl.autoCooldownTicks, AUTO_COOLDOWN_TICKS);
  assert.equal(ctrl.getEffectiveSpeed(), 2, 'should preserve user watchSpeed (2x)');

  // Manually move ball back to midfield and verify the cooldown holds WATCH until 0
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

test('Auto Highlights never batches past a crucial tick, over full matches (every goal and big chance plays live)', () => {
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
      // (When the batch ended on the half-time or full-time whistle there is no live play left to pace.)
      const whistle = ['HALF_TIME', 'FULL_TIME'].includes(/** @type {string} */ (ctrl.playbackState));
      if (flags[flags.length - 1] && !whistle) {
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
  assert.ok(share > 0.85 && share < 0.995, `most play fast-forwards, the crucial moments do not (fast share ${share.toFixed(2)})`);
});

for (const [type, meta] of [
  ['GOAL', {}],
  ['PENALTY_AWARDED', {}],
  ['RED_CARD', {}],
  ['BIG_CHANCE', {}],
  ['SHOT', { result: 'WOODWORK', xg: 0.1 }],
  ['SAVE', { psxg: 0.9 }],
]) {
  test(`Auto Highlights breaks out of a fast batch on the exact tick of a ${type} and plays it at 1x`, () => {
    const ctrl = new MatchController({ input: makeInput(5, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
    ctrl.play();
    assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED);
    let calls = 0;
    ctrl.engine.step = () => {
      calls++;
      return { ticksRun: 1, events: calls === 5 ? [/** @type {any} */ ({ type, tick: calls, meta })] : [], stoppedFor: null };
    };
    const frame = ctrl.tickFrame(1 / 60); // a fast frame budgets well over 5 ticks
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

test('routine moments do not interrupt the fast-forward: a low-xG shot, a routine save, a foul, a yellow card, an injury', () => {
  const ctrl = new MatchController({ input: makeInput(5, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  const routine = [
    { type: 'SHOT', meta: { result: 'OFF_TARGET', xg: 0.03 } },
    { type: 'SAVE', meta: { psxg: 0.05 } },
    { type: 'FOUL' },
    { type: 'YELLOW_CARD' },
    { type: 'INJURY' },
  ];
  let calls = 0;
  const s = ctrl.engine.state;
  ctrl.engine.step = () => {
    calls++;
    s.restart.state = 'IN_PLAY';
    s.ball.owner = -1;
    s.ball.pass = null;
    return { ticksRun: 1, events: calls <= routine.length ? [/** @type {any} */ ({ ...routine[calls - 1], tick: calls })] : [], stoppedFor: null };
  };
  ctrl.tickFrame(1 / 60);
  assert.equal(calls, config.playback.autoHighlights.fastMaxTicksPerFrame, 'the whole fast batch ran');
  assert.equal(ctrl.autoPacing, 'FAST');
  ctrl.destroy();
});

test('with the lead-up triggers on, Auto Highlights breaks out of a fast batch on the tick an attacker closes in on goal', () => {
  const ctrl = new MatchController({ input: makeInput(5, 'ai'), config: SPATIAL, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  const s = ctrl.engine.state;
  assert.equal(ctrl.getEffectiveSpeed(), AUTO_FAST_SPEED);
  let calls = 0;
  ctrl.engine.step = () => {
    calls++;
    s.restart.state = 'IN_PLAY';
    s.ball.pass = null;
    s.ball.owner = 9;
    const x = calls >= 3 ? 96 : 60; // home attacks x = 105: 9 m from the goal centre from tick 3
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

test('Auto Highlights: every goal comes with 5-10 s of 1x build-up (the pre-roll), and a full match takes at most 5 minutes', () => {
  const FRAME = 1 / 60;
  const walls = [];
  const crucial = { GOAL: 0, PENALTY_AWARDED: 0, RED_CARD: 0 };
  let preRolls = 0;
  let checkedGoals = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const ctrl = new MatchController({ input: makeInput(seed, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
    ctrl.play();
    let wall = 0;
    let shown = 0; // tick on screen
    let halfStart = 0;
    /** Ticks the viewer saw at 1x (live or pre-roll). */
    const seen = new Set();
    let inPreRoll = false;
    while (ctrl.playbackState !== 'FULL_TIME') {
      // The half-time dialog waits for the user: not counted.
      if (ctrl.playbackState === 'HALF_TIME' || ctrl.playbackState === 'PAUSED_FORCED') {
        const wasHalfTime = ctrl.playbackState === 'HALF_TIME';
        ctrl.continue();
        if (wasHalfTime) halfStart = shown = ctrl.engine.tick;
      }
      const frame = ctrl.tickFrame(FRAME);
      wall += FRAME;
      const tick = frame.renderSnapshot[0];
      if (frame.preRoll && !inPreRoll) {
        preRolls++;
        // A pre-roll rewinds the picture by up to preRollTicks, never past what was already shown at 1x.
        assert.ok(tick < ctrl.engine.tick && ctrl.engine.tick - tick <= AH.preRollTicks, `seed ${seed}: pre-roll from ${tick} to ${ctrl.engine.tick}`);
        shown = tick;
      }
      inPreRoll = frame.preRoll;
      const at1x = frame.preRoll || frame.autoPacing === 'WATCH';
      if (at1x) for (let t = shown + 1; t <= tick; t++) seen.add(t);
      shown = tick;
      const whistle = ['HALF_TIME', 'FULL_TIME'].includes(/** @type {string} */ (ctrl.playbackState));
      for (const e of frame.newEvents) {
        if (!(e.type in crucial)) continue;
        /** @type {Record<string, number>} */ (crucial)[e.type]++;
        // Nothing is given away early: the event comes out when the picture reaches its tick.
        assert.ok(e.tick <= tick, `seed ${seed}: ${e.type} at ${e.tick} released while showing ${tick}`);
        if (whistle) continue;
        assert.equal(ctrl.autoPacing, 'WATCH', `seed ${seed}: ${e.type} plays live`);
        assert.equal(ctrl.getEffectiveSpeed(), ctrl.watchSpeed, `seed ${seed}: ${e.type} at 1x`);
        if (e.type === 'GOAL' && e.tick - halfStart > AH.preRollTicks) {
          checkedGoals++;
          let missing = 0;
          for (let t = e.tick - 100; t <= e.tick; t++) if (!seen.has(t)) missing++;
          assert.equal(missing, 0, `seed ${seed}: the 5 s before the goal at ${e.tick} were all shown at 1x`);
        }
      }
    }
    walls.push(wall);
    ctrl.destroy();
  }
  const max = Math.max(...walls);
  const mean = walls.reduce((a, b) => a + b, 0) / walls.length;
  assert.ok(max <= 300, `every match within 5 minutes (${walls.map((w) => Math.round(w)).join(', ')} s)`);
  assert.ok(mean >= 120, `still shows the match, not just the score (mean ${mean.toFixed(0)} s)`);
  assert.ok(crucial.GOAL > 0 && checkedGoals > 0, 'the sample has goals');
  assert.ok(preRolls > 0, 'pre-rolls ran');
});

test('a goal scored during fast-forward at tick T is shown at 1x from preRollTicks before T, without spoiling it', () => {
  const ctrl = new MatchController({ input: makeInput(5, 'ai'), config, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  // Fast-forward a calm stretch so the ring holds the build-up.
  const s = ctrl.engine.state;
  let frames = 0;
  while (ctrl.engine.tick < 1000 && frames++ < 5000) ctrl.tickFrame(1 / 60);
  // ... until the last tick shown live is more than a pre-roll back (else the build-up was already seen live).
  while ((ctrl.autoPacing !== 'FAST' || ctrl.preRoll !== null || ctrl.animationHold > 0 || ctrl.engine.tick - ctrl.lastLiveTick <= AH.preRollTicks + 5) && frames++ < 20000) {
    ctrl.tickFrame(1 / 60);
  }
  // The next simulated tick scores (a stubbed engine step on top of the real one).
  const realStep = ctrl.engine.step.bind(ctrl.engine);
  let goalTick = -1;
  ctrl.engine.step = (n) => {
    const r = realStep(n);
    if (goalTick < 0) {
      goalTick = ctrl.engine.tick;
      const ev = /** @type {any} */ ({ type: 'GOAL', tick: goalTick, teamIndex: 0, actorIndex: 9, x: 100, y: 34, zone: 0, meta: { kind: 'OPEN_PLAY' } });
      r.events.push(ev);
    }
    return r;
  };
  const first = ctrl.tickFrame(1 / 60);
  ctrl.engine.step = realStep;
  assert.equal(ctrl.engine.tick, goalTick, 'the engine stops on the goal tick');
  assert.ok(first.preRoll, 'the pre-roll starts');
  const T = goalTick;
  const startTick = first.renderSnapshot[0];
  assert.ok(T - startTick >= 100 && T - startTick <= 200, `rewound ${T - startTick} ticks (5-10 s)`);
  assert.equal(first.newEvents.some((e) => e.type === 'GOAL'), false, 'the goal is not announced yet');
  // At 1x the pre-roll takes (T - start) / 20 seconds; the engine does not move meanwhile.
  let last = first;
  let n = 0;
  let goalShownAt = -1;
  while (last.preRoll && n++ < 1000) {
    last = ctrl.tickFrame(1 / 60);
    assert.equal(ctrl.engine.tick, T, 'the live engine waits');
    if (last.newEvents.some((e) => e.type === 'GOAL')) goalShownAt = last.renderSnapshot[0];
  }
  assert.equal(goalShownAt, T, 'the goal comes out when the picture reaches it');
  assert.ok(Math.abs(n / 60 - (T - startTick) / 20) < 0.2, `played at 1x (${(n / 60).toFixed(2)} s for ${T - startTick} ticks)`);
  assert.equal(ctrl.autoPacing, 'WATCH', 'then live');
  assert.equal(s.tick, T);
  ctrl.destroy();
});

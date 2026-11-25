// VAR in Auto Highlights (docs/designs/var.md): VAR_CHECK is a crucial moment, so a fast-forward drops to 1x on its
// tick with the 7 s pre-roll; the review then plays live until VAR_DECISION, which the engine only reaches by playing
// on at 1x, so nothing is given away early (no decision event, no reverted score on screen before its tick). An
// overturn's reactions become the shout-style ring cue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, configHash } from '../../generated/config.js';
import { MatchController, isDangerousTick } from '../../src/runtime/MatchController.js';
import { isHighlightTrigger } from '../../src/runtime/BestMoments.js';
import { cuesForEvents } from '../../src/runtime/animationCues.js';
import { generateSquad } from '../../src/shared/squadgen.js';

const AH = config.playback.autoHighlights;
const NO = { checkP: 0, overturnP: 0 };

/** Config with only the red-card check on (yellow cards are not crucial: the check comes during fast-forward). */
const RED_ONLY = {
  ...config,
  var: {
    ...config.var,
    goalCheck: { ...config.var.goalCheck, tight: NO, routine: NO },
    penaltyCheck: { given: NO, missed: { checkP: 0, awardP: 0 } },
    redCardCheck: { minSeverity: 0, checkP: 1, upgradeP: 1 },
  },
};

/** @param {number} seed */
function makeInput(seed) {
  const home = generateSquad('A', (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', controlledBy: 'human' });
  const away = generateSquad('A', (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', controlledBy: 'ai' });
  return { v: /** @type {const} */ (1), seed, configHash, var: true, home, away };
}

test('VAR_CHECK is a highlight trigger; VAR_DECISION is not (it is reached live)', () => {
  assert.equal(isHighlightTrigger({ type: 'VAR_CHECK', meta: { incident: 'RED_CARD' } }, config), true);
  assert.equal(isHighlightTrigger({ type: 'VAR_DECISION', meta: {} }, config), false);
});

test('Auto Highlights catches a VAR check during fast-forward: 1x pre-roll, live review, no spoiler before VAR_DECISION', () => {
  const ctrl = new MatchController({ input: makeInput(7), config: RED_ONLY, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  const s = ctrl.engine.state;
  let checkFrame = null;
  let fastBeforeCheck = false;
  let frames = 0;
  // Play until the VAR_CHECK reaches the screen.
  while (checkFrame === null && frames++ < 200000 && ctrl.playbackState !== 'FULL_TIME') {
    if (ctrl.playbackState === 'HALF_TIME' || ctrl.playbackState === 'PAUSED_FORCED') {
      ctrl.continue();
      continue;
    }
    const wasFast = ctrl.autoPacing === 'FAST' && ctrl.preRoll === null;
    const f = ctrl.tickFrame(1 / 60);
    if (wasFast) fastBeforeCheck = true;
    assert.ok(!f.newEvents.some((/** @type {any} */ e) => e.type === 'VAR_DECISION'), 'no decision before its check');
    if (f.newEvents.some((/** @type {any} */ e) => e.type === 'VAR_CHECK')) checkFrame = f;
  }
  assert.ok(checkFrame, 'a VAR check happened');
  assert.ok(fastBeforeCheck, 'the match was fast-forwarding before the check');
  const check = /** @type {any} */ (checkFrame.newEvents.find((/** @type {any} */ e) => e.type === 'VAR_CHECK'));
  // Fast-forward stopped on the check: its build-up came out of the pre-roll at 1x, ending on the check tick.
  assert.equal(ctrl.engine.tick, check.tick, 'the live engine waits on the check tick');
  assert.ok(!ctrl.eventLog.some((/** @type {any} */ e) => e.type === 'VAR_DECISION'), 'the engine has not decided yet');
  assert.ok(isDangerousTick(s, []), 'a review on screen keeps play live');
  // The review plays live at 1x until the decision, which comes out on its own tick.
  let decisionFrame = null;
  let n = 0;
  while (decisionFrame === null && n++ < 5000) {
    const f = ctrl.tickFrame(1 / 60);
    assert.equal(f.autoPacing, 'WATCH', 'never fast during the review');
    assert.ok(f.effectiveSpeed === ctrl.watchSpeed);
    if (f.newEvents.some((/** @type {any} */ e) => e.type === 'VAR_DECISION')) decisionFrame = f;
    else assert.ok(f.renderSnapshot[0] < check.tick + RED_ONLY.var.reviewTicks, 'nothing past the decision tick is shown before it');
  }
  assert.ok(decisionFrame, 'the decision came out live');
  const decision = /** @type {any} */ (decisionFrame.newEvents.find((/** @type {any} */ e) => e.type === 'VAR_DECISION'));
  assert.equal(decision.tick, check.tick + RED_ONLY.var.reviewTicks);
  assert.equal(decision.meta.outcome, 'redCardUpgraded');
  // At 1x the review takes reviewTicks / 20 seconds of wall-clock time.
  assert.ok(Math.abs(n / 60 - RED_ONLY.var.reviewTicks / 20) < 0.3, `review played at 1x (${(n / 60).toFixed(2)} s)`);
  // The overturn's reactions are on the same frame as ring cues, and so is the red card's exit.
  const kinds = decisionFrame.animations.map((/** @type {any} */ a) => a.kind);
  assert.ok(kinds.includes('SHOUT') && kinds.includes('RED_CARD'), kinds.join(','));
  assert.ok(AH.preRollTicks > 0);
  ctrl.destroy();
});

test('a disallowed goal: the scoreboard shows the goal during the review and reverts only on the decision frame', () => {
  const cfg = { ...config, var: { ...config.var, goalCheck: { ...config.var.goalCheck, tight: { checkP: 1, overturnP: 1 }, routine: { checkP: 1, overturnP: 1 } }, penaltyCheck: { given: NO, missed: { checkP: 0, awardP: 0 } }, redCardCheck: { ...config.var.redCardCheck, checkP: 0 } } };
  const ctrl = new MatchController({ input: makeInput(3), config: cfg, mode: 'auto_highlights', schedule: () => 1, cancelSchedule: () => {} });
  ctrl.play();
  /** Score on screen (from the frame's snapshot). @param {any} f */
  const shown = (f) => f.renderSnapshot[1] + f.renderSnapshot[2];
  let goals = -1;
  let stage = 'before';
  let frames = 0;
  while (stage !== 'decided' && frames++ < 200000 && ctrl.playbackState !== 'FULL_TIME') {
    if (ctrl.playbackState === 'HALF_TIME' || ctrl.playbackState === 'PAUSED_FORCED') {
      ctrl.continue();
      continue;
    }
    const f = ctrl.tickFrame(1 / 60);
    const types = f.newEvents.map((/** @type {any} */ e) => e.type);
    if (stage === 'before' && types.includes('VAR_CHECK')) {
      stage = 'review';
      goals = shown(f);
    } else if (stage === 'review') {
      if (types.includes('VAR_DECISION')) {
        assert.equal(shown(f), goals - 1, 'the goal comes off on the decision frame');
        stage = 'decided';
      } else {
        assert.equal(shown(f), goals, 'the goal stands on screen until the decision');
      }
    }
  }
  assert.equal(stage, 'decided');
  ctrl.destroy();
});

test('an overturn becomes a ring cue: the favoured side positive, the other negative; a call that stands has none', () => {
  const ev = /** @type {any} */ ({ type: 'VAR_DECISION', tick: 900, teamIndex: 0, actorIndex: 9, secondaryIndices: [20, 21, 3], x: 10, y: 30, zone: 1, meta: { incident: 'GOAL', outcome: 'goalDisallowed', overturned: true, addedSeconds: 80, positive: 2, negative: 1, assist: -1 } });
  const [cue] = cuesForEvents([ev], null);
  assert.equal(/** @type {any} */ (cue).kind, 'SHOUT');
  assert.deepEqual(/** @type {any} */ (cue).reactions, [
    { actor: 20, outcome: 'positive' },
    { actor: 21, outcome: 'positive' },
    { actor: 3, outcome: 'negative' },
  ]);
  assert.deepEqual(cuesForEvents([{ ...ev, secondaryIndices: [], meta: { ...ev.meta, overturned: false, outcome: 'goalConfirmed', positive: 0, negative: 0 } }], null), []);
});

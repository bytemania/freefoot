/**
 * Playback controller (design §14, item 52) + FM-style `Auto Highlights`
 * dynamic pacing.
 *
 * Owns the live `MatchEngine`, the 500-frame `RenderRing`, `BestMoments`, the
 * full event log, and the pull-loop playback state machine:
 *   FULL_MATCH | FAST_FORWARD | REPLAY | PAUSED_HIGHLIGHT | PAUSED_FORCED |
 *   PAUSED | HALF_TIME | FULL_TIME
 *
 * Modes:
 *   - `'auto_highlights'`: fast-forwards calm play (`autoHighlights.fastSpeed`,
 *     150x) and drops to `watchSpeed` (1x) on the exact tick a crucial moment
 *     happens (every simulated tick of a fast batch is checked, so nothing is
 *     skipped), first replaying the `autoHighlights.preRollTicks` (7 s) of
 *     build-up from the RenderRing at 1x, then holds live play for
 *     `autoHighlights.cooldownTicks` (100 ticks, 5 s). A full match takes
 *     about 3 minutes of wall-clock time (under 5).
 *   - `'full'`: continuous play at `watchSpeed`.
 *   - `'best_moments'`: 8 ms fast-forward with 500-frame ring replays.
 *   - `'debug'`: `#seed` step-by-step inspector mode.
 */
import { MatchEngine, SNAP_LEN } from '../engine/MatchEngine.js';
import { PITCH_LENGTH } from '../engine/state/MatchState.js';
import { TICKS_PER_SECOND } from '../engine/TickConfig.js';
import { BestMoments, isHighlightTrigger } from './BestMoments.js';
import { RenderRing } from './RenderRing.js';
import { cuesForEvents } from './animationCues.js';

/** Auto Highlights fast-forward speed and live cooldown when `playback.autoHighlights` is absent (the shipped values). */
export const AUTO_FAST_SPEED = 150;
export const AUTO_COOLDOWN_TICKS = 100; // 5 seconds at 20 Hz of live play after the last crucial tick

/**
 * Seconds the live engine holds still (at 1x, in `full` playback; scaled by
 * `autoHighlights.holdScale` in `auto_highlights`) after an event with an
 * on-pitch animation, so it plays out before play moves on: the goal
 * celebration before the kick-off reset, the sent-off player's exit, the
 * substitutes swapping at the touchline.
 */
export const ANIMATION_HOLD_SECONDS = Object.freeze({ GOAL: 2, RED_CARD: 1.5, SUBSTITUTION: 1.8 });

/** Goal centre across the pitch (m). */
const GOAL_CENTRE_Y = 34;

/** Auto Highlights settings used when the config has no `playback.autoHighlights` section. */
const AUTO_DEFAULTS = Object.freeze({
  fastSpeed: AUTO_FAST_SPEED,
  fastMaxTicksPerFrame: 50,
  cooldownTicks: AUTO_COOLDOWN_TICKS,
  holdScale: 0.75,
  leadUpGoalDist: 0,
  passTargetGoalDist: 0,
  breakawayAlong: 0,
  freeKickDangerM: 22,
  preRollTicks: 140,
});

/**
 * @param {any} state `MatchState`
 * @returns {typeof AUTO_DEFAULTS}
 */
function autoSettings(state) {
  return state.config?.playback?.autoHighlights ?? AUTO_DEFAULTS;
}

/**
 * A set piece being set up (dead ball before the whistle) that Auto Highlights
 * shows at 1x, so the taker and the wall are seen getting ready: a penalty, or
 * a direct free kick within `autoHighlights.freeKickDangerM` of goal. Routine
 * corners and free kicks fast-forward.
 * @param {any} state `MatchState`
 * @returns {boolean}
 */
export function isSetPieceSetup(state) {
  const rs = state.restart;
  if (rs.state !== 'DEAD_BALL') return false;
  if (rs.kind === 'PENALTY') return true;
  if (rs.kind !== 'FREE_KICK' || !rs.direct) return false;
  const gx = state.attackDir(rs.teamIndex) > 0 ? PITCH_LENGTH : 0;
  const dx = gx - rs.x;
  const dy = GOAL_CENTRE_Y - rs.y;
  const r = autoSettings(state).freeKickDangerM;
  return dx * dx + dy * dy <= r * r;
}


/**
 * Pure crucial-moment predicate for FM-style `Auto Highlights` pacing, checked
 * on every simulated tick. Only genuinely crucial moments play at 1x:
 *  1. A crucial event on the tick: the Best Moments triggers (`isHighlightTrigger`: a goal, a penalty award,
 *     a red card, a big chance, woodwork, a high-xG shot or a major save). Routine fouls, low-xG shots, cards
 *     and injuries do not count;
 *  2. The chance being built (each off at 0, the shipped setting, since the pre-roll replays the build-up): the
 *     ball carrier within `leadUpGoalDist` of the goal centre, or a pass in flight to a point within
 *     `passTargetGoalDist` of it;
 *  3. A clean breakaway (off at 0): a carrier past `breakawayAlong` with no outfield defender goal-side;
 *  4. A penalty, or a direct free kick within `freeKickDangerM` (`isSetPieceSetup`). Corners fast-forward.
 *
 * @param {any} state `MatchState`
 * @param {any[]} [tickEvents] events emitted on this tick
 * @returns {boolean}
 */
export function isDangerousTick(state, tickEvents = []) {
  for (let i = 0; i < tickEvents.length; i++) {
    if (isHighlightTrigger(tickEvents[i], state.config)) return true;
  }
  const ah = autoSettings(state);
  const b = state.ball;
  const ref = b.owner >= 0 ? state.players[b.owner] : b.pass !== null ? state.players[b.pass.passer] : null;
  if (ref) {
    const dir = state.attackDir(ref.team);
    const gx = dir > 0 ? PITCH_LENGTH : 0;
    if (b.owner >= 0) {
      const dx = gx - b.x;
      const dy = GOAL_CENTRE_Y - b.y;
      if (ah.leadUpGoalDist > 0 && dx * dx + dy * dy <= ah.leadUpGoalDist * ah.leadUpGoalDist) return true;
      // Clean breakaway: no outfield opponent closer to goal than the carrier.
      const alongPos = dir > 0 ? ref.x : PITCH_LENGTH - ref.x;
      if (ah.breakawayAlong > 0 && alongPos >= ah.breakawayAlong) {
        let ahead = 0;
        for (let i = 0; i < state.onPitchList.length; i++) {
          const q = state.players[state.onPitchList[i]];
          if (q.team === ref.team || q.isKeeper === 1) continue;
          if (dir > 0 ? q.x > ref.x : q.x < ref.x) {
            ahead++;
            break;
          }
        }
        if (ahead === 0) return true;
      }
    } else if (b.pass !== null) {
      const dx = gx - b.pass.px;
      const dy = GOAL_CENTRE_Y - b.pass.py;
      if (ah.passTargetGoalDist > 0 && dx * dx + dy * dy <= ah.passTargetGoalDist * ah.passTargetGoalDist) return true;
    }
  }
  return isSetPieceSetup(state);
}

/**
 * @typedef {'FULL_MATCH' | 'FAST_FORWARD' | 'REPLAY' | 'PAUSED_HIGHLIGHT' | 'PAUSED_FORCED' | 'PAUSED' | 'HALF_TIME' | 'FULL_TIME'} PlaybackState
 * @typedef {'auto_highlights' | 'full' | 'best_moments' | 'debug'} PlaybackMode
 */

export class MatchController {
  /**
   * @param {{
   *   input: import('../engine/contracts/MatchInput.js').MatchInput,
   *   config: any,
   *   mode?: PlaybackMode,
   *   now?: () => number,
   *   schedule?: (cb: (ts: number) => void) => number,
   *   cancelSchedule?: (id: number) => void,
   *   onFrame?: (frame: any) => void,
   * }} opts
   */
  constructor({
    input,
    config,
    mode = 'full',
    now = () => performance.now(),
    schedule = (cb) => requestAnimationFrame(cb),
    cancelSchedule = (id) => cancelAnimationFrame(id),
    onFrame = () => {},
  }) {
    this.input = input;
    this.config = config;
    /** @type {PlaybackMode} */
    this.mode = mode;
    this.now = now;
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.onFrame = onFrame;

    const pb = config.playback;
    this.maxTicksPerFrame = pb.maxTicksPerFrame ?? 20;
    this.maxFrameSeconds = pb.maxFrameSeconds ?? 0.1;
    const ah = pb.autoHighlights ?? {};
    /** Auto Highlights: speed between crucial moments, its per-frame tick cap, the live cooldown and the hold scale. */
    this.autoFastSpeed = ah.fastSpeed ?? AUTO_FAST_SPEED;
    this.autoFastMaxTicks = ah.fastMaxTicksPerFrame ?? 50;
    this.autoCooldown = ah.cooldownTicks ?? AUTO_COOLDOWN_TICKS;
    this.autoHoldScale = ah.holdScale ?? 1;
    /** Ticks of build-up replayed at 1x from the ring when Auto Highlights drops from fast-forward to live. */
    this.preRollTicks = ah.preRollTicks ?? 0;
    /** The running pre-roll: ring cursor (float tick), the live tick it ends on, and the last tick whose events were released. */
    this.preRoll = /** @type {null | {cursor: number, end: number, released: number}} */ (null);
    /** First tick of the current half (a pre-roll never reaches back across half-time). */
    this.halfStartTick = 0;
    /** Last tick shown at live speed (a pre-roll never repeats it). */
    this.lastLiveTick = -1;

    this.engine = MatchEngine.create(input, config);
    this.ring = new RenderRing(pb.ring?.frames ?? 500);
    this.bestMoments = new BestMoments({ config, now });
    this.snapshot = new Float64Array(SNAP_LEN);
    this.engine.getSnapshot(this.snapshot);
    /** @type {import('../engine/events/MatchEvent.js').MatchEvent[]} */
    this.eventLog = [];
    this.ring.push(this.snapshot, 0, 0, 0);

    this.speed = 1;
    this.watchSpeed = 1;
    this.autoCooldownTicks = 0;
    this.holdLiveForManager = false;
    /** Playback state to return to when a tap-to-replay ends, or null when no instant replay runs. */
    this.instantReplayResume = /** @type {PlaybackState | null} */ (null);
    /** Seconds the live engine still holds for an on-pitch animation (ANIMATION_HOLD_SECONDS). */
    this.animationHold = 0;
    /** @type {'FAST' | 'WATCH'} */
    this.autoPacing = 'WATCH';
    this.budget = 0;
    this.droppedBudget = 0;
    /** @type {PlaybackState} */
    this.playbackState = 'PAUSED';
    this.rafId = 0;
    this.lastTs = -1;
    this.running = false;
  }

  /** Starts the pull loop in the active mode (`FULL_MATCH` or `FAST_FORWARD`). */
  play() {
    if (this.instantReplayResume !== null) this.#endInstantReplay();
    if (this.playbackState === 'FULL_TIME' || this.playbackState === 'PAUSED_FORCED') return;
    if (this.speed === 0) this.speed = this.watchSpeed > 0 ? this.watchSpeed : 1;
    if (this.playbackState === 'HALF_TIME') {
      this.stepTicks(1);
      if (/** @type {string} */ (this.playbackState) === 'FULL_TIME') return;
      this.halfStartTick = this.engine.tick;
      this.lastLiveTick = this.engine.tick;
    }
    if (this.playbackState === 'PAUSED_HIGHLIGHT') {
      this.bestMoments.continueFromHighlight();
    }
    this.playbackState = this.mode === 'best_moments' ? 'FAST_FORWARD' : 'FULL_MATCH';
    if (!this.running) {
      this.running = true;
      this.lastTs = -1;
      this.rafId = this.schedule((ts) => this.#onRaf(ts));
    }
  }

  /** Pauses playback and stops requesting animation frames. */
  pause() {
    if (this.instantReplayResume !== null) this.#endInstantReplay();
    this.running = false;
    if (this.rafId) {
      this.cancelSchedule(this.rafId);
      this.rafId = 0;
    }
    if (this.playbackState === 'FULL_MATCH' || this.playbackState === 'FAST_FORWARD') {
      this.playbackState = 'PAUSED';
    }
    this.budget = 0;
    this.onFrame(this.buildFrame([]));
  }

  togglePlay() {
    if (this.instantReplayResume !== null) this.#endInstantReplay();
    if (this.playbackState === 'FULL_MATCH' || this.playbackState === 'FAST_FORWARD') this.pause();
    else this.play();
  }

  /**
   * Sets playback speed. Non-zero speeds update `watchSpeed` so `Auto Highlights`
   * remembers the user's preferred normal watch speed; `0` pauses immediately.
   * @param {number} speed
   */
  setSpeed(speed) {
    const clamped = Math.max(0, Math.min(60, speed));
    this.speed = clamped;
    if (clamped > 0) {
      this.watchSpeed = clamped;
    } else if (this.playbackState === 'FULL_MATCH') {
      this.pause();
    }
  }

  /** @param {PlaybackMode} nextMode */
  setMode(nextMode) {
    if (this.playbackState === 'REPLAY') return;
    this.mode = nextMode;
    if (nextMode !== 'auto_highlights') {
      this.autoPacing = 'WATCH';
      this.preRoll = null;
    }
    if (this.playbackState === 'FULL_MATCH' && nextMode === 'best_moments') {
      this.playbackState = 'FAST_FORWARD';
    } else if (this.playbackState === 'FAST_FORWARD' && nextMode !== 'best_moments') {
      this.playbackState = 'FULL_MATCH';
    }
    this.onFrame(this.buildFrame([]));
  }

  /** Continues from `HALF_TIME` or `PAUSED_HIGHLIGHT`. */
  continue() {
    if (this.playbackState === 'HALF_TIME' || this.playbackState === 'PAUSED_HIGHLIGHT') {
      this.play();
    }
  }

  /**
   * Tap-to-replay (the top-right speed badge): replays the latest moments
   * (up to `ring.leadUpTicks`, 15 s) from the RenderRing at replay speed, then
   * returns to the playback state it interrupted. Calling it during that
   * replay skips the rest. Ignored while a Best Moments replay, a forced
   * decision, half-time or full time is showing, while Best Moments is
   * mid-highlight, or when nothing has been played yet.
   * @returns {boolean} whether a replay started (or a running one was skipped)
   */
  replayLastMoments() {
    if (this.preRoll !== null) return false;
    if (this.playbackState === 'REPLAY') {
      if (this.instantReplayResume === null) return false;
      this.#endInstantReplay();
      return true;
    }
    if (this.playbackState === 'PAUSED_FORCED' || this.playbackState === 'FULL_TIME' || this.playbackState === 'HALF_TIME') return false;
    if (this.bestMoments.phase !== 'IDLE' && this.bestMoments.phase !== 'PAUSED_HIGHLIGHT') return false;
    if (this.ring.count < 2) return false;
    const resume = this.playbackState === 'FULL_MATCH' || this.playbackState === 'FAST_FORWARD' ? this.playbackState : 'PAUSED';
    if (!this.bestMoments.startInstantReplay(this.ring)) return false;
    this.instantReplayResume = /** @type {PlaybackState} */ (resume);
    this.playbackState = 'REPLAY';
    this.budget = 0;
    if (!this.running) {
      this.running = true;
      this.lastTs = -1;
      this.rafId = this.schedule((ts) => this.#onRaf(ts));
    }
    this.onFrame(this.buildFrame([]));
    return true;
  }

  #endInstantReplay() {
    const resume = this.instantReplayResume ?? 'PAUSED';
    this.instantReplayResume = null;
    this.bestMoments.continueFromHighlight();
    this.playbackState = resume;
    this.budget = 0;
    if (resume === 'PAUSED') {
      this.running = false;
      if (this.rafId) {
        this.cancelSchedule(this.rafId);
        this.rafId = 0;
      }
    }
    this.onFrame(this.buildFrame([]));
  }

  /** Cancels the Best Moments post-highlight countdown (e.g. when Manager drawer opens). */
  cancelHighlightCountdown() {
    this.bestMoments.cancelCountdown();
  }

  /**
   * Tracks whether the Manager/Coach drawer is open so Auto Highlights holds at
   * `1x` while the coach inspects/edits tactics.
   * @param {boolean} isOpen
   */
  setManagerOpen(isOpen) {
    this.holdLiveForManager = isOpen;
    if (isOpen) this.slowForManager();
  }

  /**
   * Automatically slows active playback to `1x` whenever the Manager/Coach drawer
   * opens (if currently running > `1x` or in Auto Highlights fast-forward),
   * without unpausing if already paused at `0x` or `PAUSED_FORCED` / `HALF_TIME`.
   */
  slowForManager() {
    this.bestMoments.cancelCountdown();
    if (
      this.playbackState === 'PAUSED' ||
      this.playbackState === 'PAUSED_FORCED' ||
      this.playbackState === 'HALF_TIME' ||
      this.playbackState === 'FULL_TIME' ||
      this.speed === 0
    ) {
      return;
    }
    let changed = false;
    if (this.speed > 1) {
      this.speed = 1;
      changed = true;
    }
    if (this.watchSpeed > 1) {
      this.watchSpeed = 1;
      changed = true;
    }
    if (this.mode === 'auto_highlights') {
      this.autoCooldownTicks = this.autoCooldown;
      if (this.autoPacing !== 'WATCH') changed = true;
      this.autoPacing = 'WATCH';
      this.budget = 0;
    }
    if (changed) {
      this.onFrame(this.buildFrame([]));
    }
  }

  /**
   * Issues a manager command. Rejected during `REPLAY` (design §14).
   * @param {import('../engine/commands/Commands.js').Command} cmd
   * @returns {{ok: boolean, code: string | null, seq?: number}}
   */
  queueCommand(cmd) {
    if (this.playbackState === 'REPLAY') {
      return { ok: false, code: 'REPLAY_ACTIVE' };
    }
    const res = this.engine.applyCommand(cmd);
    if (res.ok) {
      if (cmd.type === 'RESOLVE_FORCED' && !this.engine.state.awaitingDecision && this.playbackState === 'PAUSED_FORCED') {
        this.playbackState = 'PAUSED';
      }
      // At a stoppage the engine makes the substitution at once: log its
      // SUBSTITUTION event and refresh the RenderSnapshot straight away.
      const events = res.events ?? [];
      /** @type {any[]} */
      let animations = [];
      if (events.length > 0) {
        const start = this.eventLog.length;
        for (const ev of events) this.eventLog.push(ev);
        this.engine.getSnapshot(this.snapshot);
        this.ring.push(this.snapshot, this.engine.tick, start, this.eventLog.length);
        animations = cuesForEvents(events, null);
        if (this.playbackState === 'FULL_MATCH') this.#holdFor(events);
      }
      this.onFrame(this.buildFrame(events, undefined, undefined, animations));
    }
    return res;
  }

  /**
   * Advances `n` ticks immediately (used by debug Step 1 / Step 20 buttons).
   * @param {number} n
   */
  stepTicks(n) {
    if (this.playbackState === 'FULL_TIME') return this.buildFrame([]);
    const newEvents = [];
    /** @type {any[]} */
    const animations = [];
    let remaining = n;
    while (remaining > 0) {
      const r = this.engine.step(1);
      const start = this.eventLog.length;
      for (let i = 0; i < r.events.length; i++) {
        this.eventLog.push(r.events[i]);
        newEvents.push(r.events[i]);
      }
      if (r.events.length > 0) animations.push(...cuesForEvents(r.events, this.snapshot));
      this.engine.getSnapshot(this.snapshot);
      this.ring.push(this.snapshot, this.engine.tick, start, this.eventLog.length);
      remaining--;
      if (r.stoppedFor === 'FULL_TIME') {
        this.playbackState = 'FULL_TIME';
        this.running = false;
        break;
      }
      if (r.stoppedFor === 'HALF_TIME') {
        this.playbackState = 'HALF_TIME';
        this.running = false;
        break;
      }
      if (r.stoppedFor === 'FORCED_DECISION') {
        this.playbackState = 'PAUSED_FORCED';
        this.running = false;
        break;
      }
    }
    this.budget = 0;
    const frame = this.buildFrame(newEvents, undefined, undefined, animations);
    this.onFrame(frame);
    return frame;
  }

  /**
   * Starts (or extends) the live hold for the animated events among `events`.
   * Only `full` and `auto_highlights` playback hold; Best Moments has its own
   * replays and the debug viewer steps by hand.
   * @param {import('../engine/events/MatchEvent.js').MatchEvent[]} events
   * @returns {boolean} whether a hold started
   */
  #holdFor(events) {
    if (this.mode !== 'full' && this.mode !== 'auto_highlights') return false;
    let hold = 0;
    let crucial = false;
    for (const e of events) {
      const h = /** @type {Record<string, number>} */ (ANIMATION_HOLD_SECONDS)[e.type] ?? 0;
      if (e.type === 'GOAL' || e.type === 'RED_CARD' || e.type === 'SUBSTITUTION') hold = h > hold ? h : hold;
      if (e.type === 'GOAL' || e.type === 'RED_CARD') crucial = true;
    }
    if (hold <= 0) return false;
    if (this.mode === 'auto_highlights') hold *= this.autoHoldScale;
    if (hold > this.animationHold) this.animationHold = hold;
    this.budget = 0;
    // A substitution only holds for its touchline swap; a goal or a red card also plays on live.
    if (this.mode === 'auto_highlights' && crucial) {
      this.autoCooldownTicks = this.autoCooldown;
      this.autoPacing = 'WATCH';
    }
    return true;
  }

  /**
   * Deterministically seeks to `targetTick` (replaying from tick 0 when seeking
   * backwards), then pauses. Used by the `#seed` debug viewer timeline.
   * @param {number} targetTick
   */
  seekToTick(targetTick) {
    const clamped = Math.max(0, Math.floor(targetTick));
    this.pause();
    if (clamped < this.engine.tick) {
      const log = this.engine.getCommandLog();
      const { engine, events } = MatchEngine.replay(this.input, this.config, log, clamped);
      this.engine = engine;
      this.eventLog = events;
      this.ring.clear();
      this.engine.getSnapshot(this.snapshot);
      this.ring.push(this.snapshot, this.engine.tick, 0, this.eventLog.length);
      this.playbackState =
        this.engine.state.restart.state === 'FULL_TIME'
          ? 'FULL_TIME'
          : this.engine.state.restart.state === 'HALF_TIME'
            ? 'HALF_TIME'
            : 'PAUSED';
    } else if (clamped > this.engine.tick) {
      let left = clamped - this.engine.tick;
      while (left > 0) {
        const step = left < 500 ? left : 500;
        const r = this.engine.step(step);
        for (let i = 0; i < r.events.length; i++) this.eventLog.push(r.events[i]);
        left -= r.ticksRun;
        if (r.stoppedFor === 'FULL_TIME') {
          this.playbackState = 'FULL_TIME';
          break;
        }
        if (r.stoppedFor === 'FORCED_DECISION') {
          this.playbackState = 'PAUSED_FORCED';
          break;
        }
        if (r.ticksRun === 0) break;
      }
      this.engine.getSnapshot(this.snapshot);
      this.ring.push(this.snapshot, this.engine.tick, this.eventLog.length, this.eventLog.length);
    }
    const frame = this.buildFrame([]);
    this.onFrame(frame);
    return frame;
  }

  /** Effective playback speed for the current frame. */
  getEffectiveSpeed() {
    if (this.speed <= 0) return 0;
    if (this.mode === 'auto_highlights') {
      const danger = this.holdLiveForManager || this.animationHold > 0 || this.autoCooldownTicks > 0 || isDangerousTick(this.engine.state, []);
      this.autoPacing = danger ? 'WATCH' : 'FAST';
      return danger ? this.watchSpeed : this.autoFastSpeed;
    }
    this.autoPacing = 'WATCH';
    return this.speed;
  }

  /**
   * Pull-loop step (design §14, item 52). Tests call this directly.
   * @param {number} frameSeconds
   */
  tickFrame(frameSeconds) {
    // 0. Tap-to-replay of the latest moments (the live engine is untouched).
    if (this.playbackState === 'REPLAY' && this.instantReplayResume !== null) {
      const rep = this.bestMoments.stepReplay(frameSeconds, this.ring, this.eventLog);
      if (rep.finished) {
        this.#endInstantReplay();
        return this.buildFrame([]);
      }
      const frame = this.buildFrame([], rep.snapshot, rep.alpha);
      this.onFrame(frame);
      return frame;
    }

    // 1. Best Moments: REPLAY
    if (this.playbackState === 'REPLAY') {
      const rep = this.bestMoments.stepReplay(frameSeconds, this.ring, this.eventLog);
      this.playbackState = rep.nextState;
      if (rep.finished && rep.nextState === 'PAUSED_FORCED') {
        this.running = false;
      }
      const frame = this.buildFrame(rep.newEvents, rep.snapshot, rep.alpha);
      this.onFrame(frame);
      return frame;
    }

    // 2. Best Moments: PAUSED_HIGHLIGHT countdown
    if (this.playbackState === 'PAUSED_HIGHLIGHT') {
      if (this.bestMoments.tickCountdown(frameSeconds)) {
        this.bestMoments.continueFromHighlight();
        this.playbackState = 'FAST_FORWARD';
      }
      const frame = this.buildFrame([]);
      this.onFrame(frame);
      return frame;
    }

    // 3. Best Moments: FAST_FORWARD
    if (this.playbackState === 'FAST_FORWARD') {
      const ff = this.bestMoments.stepFastForward(this);
      if (ff.startedReplay) {
        this.playbackState = 'REPLAY';
      } else if (ff.stoppedFor === 'FULL_TIME') {
        this.playbackState = 'FULL_TIME';
        this.running = false;
      } else if (ff.stoppedFor === 'HALF_TIME') {
        this.playbackState = 'HALF_TIME';
        this.running = false;
      } else if (ff.stoppedFor === 'FORCED_DECISION') {
        this.playbackState = 'PAUSED_FORCED';
        this.running = false;
      }
      const frame = this.buildFrame(ff.highlightEvents);
      this.onFrame(frame);
      return frame;
    }

    // 4. Full Match / Auto Highlights / Debug pull loop
    if (this.playbackState !== 'FULL_MATCH' || this.speed <= 0) {
      return this.buildFrame([]);
    }

    // 4a. An on-pitch animation (goal celebration, red card exit, substitution)
    // is playing: the live engine holds still until it is over.
    if (this.animationHold > 0) {
      this.animationHold -= Math.min(Math.max(0, frameSeconds), this.maxFrameSeconds);
      if (this.animationHold < 1e-9) this.animationHold = 0;
      this.budget = 0;
      if (this.mode === 'auto_highlights') this.autoPacing = 'WATCH';
      const frame = this.buildFrame([]);
      this.onFrame(frame);
      return frame;
    }

    // 4b. Auto Highlights pre-roll: the build-up to the moment that ended fast-forward plays at 1x from the
    // RenderRing while the live engine waits on that tick; its events (commentary, animations) come out as the
    // replay reaches them, so nothing is given away early.
    if (this.preRoll !== null) return this.#stepPreRoll(frameSeconds);

    const effectiveSpeed = this.getEffectiveSpeed();
    const wasFast = this.mode === 'auto_highlights' && this.autoPacing === 'FAST';
    const batchStart = this.engine.tick + 1;

    const dt = Math.min(Math.max(0, frameSeconds), this.maxFrameSeconds);
    this.budget += dt * TICKS_PER_SECOND * effectiveSpeed;
    let toStep = Math.floor(this.budget);
    const cap = wasFast ? this.autoFastMaxTicks : this.maxTicksPerFrame;
    if (toStep > cap) {
      this.droppedBudget += toStep - cap;
      toStep = cap;
      this.budget = Math.min(this.budget - toStep, 1);
    } else {
      this.budget -= toStep;
    }

    const newEvents = [];
    /** @type {any[]} */
    const animations = [];
    let held = false;
    for (let i = 0; i < toStep; i++) {
      const r = this.engine.step(1);
      const start = this.eventLog.length;
      for (let j = 0; j < r.events.length; j++) {
        this.eventLog.push(r.events[j]);
        newEvents.push(r.events[j]);
      }
      // `this.snapshot` still holds the previous tick: the pre-goal positions.
      if (r.events.length > 0) animations.push(...cuesForEvents(r.events, this.snapshot));
      this.engine.getSnapshot(this.snapshot);
      this.ring.push(this.snapshot, this.engine.tick, start, this.eventLog.length);
      if (!wasFast) this.lastLiveTick = this.engine.tick;
      if (r.events.length > 0 && r.stoppedFor === null && this.#holdFor(r.events)) held = true;

      if (r.stoppedFor === 'FULL_TIME') {
        this.playbackState = 'FULL_TIME';
        this.running = false;
        this.budget = 0;
        break;
      }
      if (r.stoppedFor === 'HALF_TIME') {
        this.playbackState = 'HALF_TIME';
        this.running = false;
        this.budget = 0;
        break;
      }
      if (r.stoppedFor === 'FORCED_DECISION') {
        this.playbackState = 'PAUSED_FORCED';
        this.running = false;
        this.budget = 0;
        break;
      }

      if (this.mode === 'auto_highlights') {
        // Every simulated tick is inspected: a crucial moment (or a set piece
        // being set up) on this exact tick ends the fast batch here, so it (and
        // what follows) plays live.
        if (isDangerousTick(this.engine.state, r.events)) {
          this.autoCooldownTicks = this.autoCooldown;
          this.autoPacing = 'WATCH';
          if (wasFast) {
            this.budget = 0;
            if (this.#startPreRoll(batchStart)) {
              // This batch's events and holds now come out as the pre-roll reaches them.
              newEvents.length = 0;
              animations.length = 0;
              this.animationHold = 0;
              const frame = this.#stepPreRoll(0);
              return frame;
            }
            break;
          }
        } else if (this.autoCooldownTicks > 0) {
          this.autoCooldownTicks--;
          if (this.autoCooldownTicks === 0 && !this.holdLiveForManager) this.autoPacing = 'FAST';
        }
      }

      // The animation plays before the next tick (after the Auto Highlights check above, so a crucial tick that
      // also holds for an animation still switches pacing to live).
      if (held) break;
    }

    const frame = this.buildFrame(newEvents, undefined, undefined, animations);
    this.onFrame(frame);
    return frame;
  }

  /**
   * Starts an Auto Highlights pre-roll ending on the live tick: from `preRollTicks` back, but never before
   * the oldest ring frame, the start of the half, or the last tick already shown live.
   * @param {number} batchStart first tick of the fast batch that is ending (its events are still unreleased)
   * @returns {boolean} whether a pre-roll started (a gap under a second is not worth one)
   */
  #startPreRoll(batchStart) {
    if (this.preRollTicks <= 0) return false;
    const end = this.engine.tick;
    const start = Math.max(end - this.preRollTicks, this.ring.oldestTick(), this.halfStartTick, this.lastLiveTick);
    if (end - start < TICKS_PER_SECOND) return false;
    // Ticks before the batch already had their events shown (at fast-forward); the batch's are released as reached.
    this.preRoll = { cursor: start, end, released: batchStart - 1 };
    this.autoPacing = 'WATCH';
    return true;
  }

  /**
   * One frame of the running pre-roll at watch speed (see 4b in `tickFrame`).
   * @param {number} frameSeconds
   */
  #stepPreRoll(frameSeconds) {
    const pr = /** @type {{cursor: number, end: number, released: number}} */ (this.preRoll);
    const dt = Math.min(Math.max(0, frameSeconds), this.maxFrameSeconds);
    pr.cursor = Math.min(pr.end, pr.cursor + dt * TICKS_PER_SECOND * this.watchSpeed);
    let shown = Math.floor(pr.cursor);
    /** @type {any[]} */
    const events = [];
    /** @type {any[]} */
    const animations = [];
    for (let t = pr.released + 1; t <= shown; t++) {
      pr.released = t;
      const f = this.ring.frameAt(t);
      if (f === null || f.eventEnd <= f.eventStart) continue;
      const evs = this.eventLog.slice(f.eventStart, f.eventEnd);
      for (const e of evs) events.push(e);
      const prev = this.ring.frameAt(t - 1);
      animations.push(...cuesForEvents(evs, prev ? prev.snapshot : null));
      if (this.#holdFor(evs)) {
        // A goal or a red card: its animation plays out before the pre-roll goes on.
        pr.cursor = t;
        shown = t;
        break;
      }
    }
    const alpha = pr.cursor - shown;
    const f = this.ring.frameAt(shown) ?? this.ring.frameAt(this.ring.latestTick());
    const snap = f ? new Float64Array(f.snapshot) : this.snapshot;
    this.autoPacing = 'WATCH';
    if (shown >= pr.end) {
      // Caught up with the live engine: carry on live, with the usual cooldown.
      this.preRoll = null;
      this.lastLiveTick = pr.end;
      this.autoCooldownTicks = this.autoCooldown;
      this.budget = 0;
    }
    const frame = this.buildFrame(events, snap, shown >= pr.end ? 1 : alpha, animations);
    this.onFrame(frame);
    return frame;
  }

  /**
   * @param {import('../engine/events/MatchEvent.js').MatchEvent[]} newEvents
   * @param {Float64Array} [snapshotOverride]
   * @param {number} [alphaOverride]
   * @param {import('./animationCues.js').AnimationCue[]} [animations] on-pitch animation cues for this frame's events
   */
  buildFrame(newEvents, snapshotOverride, alphaOverride, animations = []) {
    const alpha = alphaOverride ?? (this.budget < 0 ? 0 : this.budget > 1 ? 1 : this.budget);
    const rs = this.engine.state.restart;
    return {
      animations,
      animationHold: this.animationHold,
      restart: { state: rs.state, kind: rs.kind, teamIndex: rs.teamIndex, x: rs.x, y: rs.y, direct: rs.direct, taker: rs.taker },
      renderSnapshot: snapshotOverride ?? this.snapshot,
      alpha,
      newEvents,
      stats: this.engine.getStats(),
      playbackState: this.playbackState,
      mode: this.mode,
      tick: this.engine.tick,
      speed: this.speed,
      watchSpeed: this.watchSpeed,
      autoPacing: this.autoPacing,
      effectiveSpeed: this.mode === 'auto_highlights' && this.autoPacing === 'FAST' ? this.autoFastSpeed : this.watchSpeed,
      autoCooldownTicks: this.autoCooldownTicks,
      /** Whether this frame shows Auto Highlights pre-roll (recorded build-up) rather than the live engine. */
      preRoll: this.preRoll !== null,
      countdownRemaining: this.bestMoments.countdownRemaining,
    };
  }

  /** @param {number} ts */
  #onRaf(ts) {
    if (!this.running) return;
    const frameSeconds = this.lastTs < 0 ? 1 / 60 : (ts - this.lastTs) / 1000;
    this.lastTs = ts;
    this.tickFrame(frameSeconds);
    if (this.running) {
      this.rafId = this.schedule((nextTs) => this.#onRaf(nextTs));
    }
  }

  destroy() {
    this.running = false;
    if (this.rafId) {
      this.cancelSchedule(this.rafId);
      this.rafId = 0;
    }
  }
}

/**
 * Best Moments highlight engine (design §14, item 53, G6).
 *
 * Drives fast-forward stepping inside an 8 ms time slice (capped at
 * `ffMaxTicksPerFrame`), detects highlight triggers (goals, big chances,
 * woodwork, penalties, red cards, major saves), advances the live engine
 * through the post-roll (40 ticks, extended up to 160 ticks past the first
 * trigger, cut short on forced decisions), and plays back the highlight from
 * the 500-frame `RenderRing` without ever mutating the live engine.
 */
import { SNAP_BALL } from '../engine/MatchEngine.js';
import { PITCH_LENGTH } from '../engine/state/MatchState.js';
import { TICKS_PER_SECOND } from '../engine/TickConfig.js';

/**
 * Whether an event qualifies as a Best Moments highlight trigger (design G6, §14).
 * @param {any} ev
 * @param {any} config
 * @returns {boolean}
 */
export function isHighlightTrigger(ev, config) {
  const hi = config.playback.highlights;
  switch (ev.type) {
    case 'GOAL':
    case 'PENALTY_AWARDED':
    case 'RED_CARD':
    case 'BIG_CHANCE':
    case 'VAR_CHECK':
      return true;
    case 'SHOT':
      return ev.meta?.result === 'WOODWORK' || (ev.meta?.xg ?? 0) >= hi.bigChanceXg;
    case 'SAVE':
      return (ev.meta?.psxg ?? 0) >= hi.majorSavePsxg;
    default:
      return false;
  }
}

export class BestMoments {
  /**
   * @param {{config: any, now?: () => number}} opts
   */
  constructor({ config, now = () => performance.now() }) {
    this.config = config;
    this.now = now;
    const pb = config.playback;
    this.leadUpTicks = pb.ring?.leadUpTicks ?? 300;
    this.postRollTicks = pb.ring?.postRollTicks ?? 40;
    this.extensionCapTicks = pb.ring?.extensionCapTicks ?? 160;
    this.replaySpeed = pb.replay?.speed ?? 1.5;
    this.replayCap = pb.replay?.cap ?? 25;
    this.countdownSeconds = pb.countdownSeconds ?? 5;
    this.sliceMs = pb.fastForward?.sliceMs ?? 8;
    this.ffMaxTicksPerFrame = pb.fastForward?.maxTicksPerFrame ?? 2000;

    this.replaysShown = 0;
    /** @type {'IDLE' | 'POST_ROLL' | 'REPLAY' | 'PAUSED_HIGHLIGHT'} */
    this.phase = 'IDLE';

    // Active highlight window
    this.firstTriggerTick = -1;
    this.replayStartTick = -1;
    this.replayEndTick = -1;
    this.cutShortByForced = false;
    this.replayCursor = 0; // float tick index inside [replayStartTick, replayEndTick]
    this.lastReleasedTick = -1;
    this.countdownRemaining = 0;
    this.countdownCancelled = false;

    /**
     * Smooth shot-to-net visual interpolation metadata for SHOT+GOAL ticks.
     * @type {null | {goalTick: number, fromX: number, fromY: number, toX: number, toY: number, durationTicks: number}}
     */
    this.shotAnimation = null;
  }

  /** Cancels the auto-continue countdown (e.g. when the Manager drawer opens). */
  cancelCountdown() {
    this.countdownCancelled = true;
    this.countdownRemaining = 0;
  }

  /** Resumes fast-forward after `PAUSED_HIGHLIGHT`. */
  continueFromHighlight() {
    this.phase = 'IDLE';
    this.firstTriggerTick = -1;
    this.replayStartTick = -1;
    this.replayEndTick = -1;
    this.cutShortByForced = false;
    this.countdownRemaining = 0;
    this.countdownCancelled = false;
    this.shotAnimation = null;
  }

  /**
   * Runs one fast-forward frame against `controller` (steps 1 tick at a time
   * until `sliceMs` elapses, `ffMaxTicksPerFrame` is reached, a replay starts,
   * or the match stops for half-time / full-time / forced decision).
   * @param {any} controller
   * @returns {{ticksRun: number, highlightEvents: any[], startedReplay: boolean, stoppedFor: string | null}}
   */
  stepFastForward(controller) {
    const startMs = this.now();
    let ticksRun = 0;
    const highlightEvents = [];
    /** @type {string | null} */
    let stoppedFor = null;

    while (ticksRun < this.ffMaxTicksPerFrame) {
      const r = controller.engine.step(1);
      ticksRun++;
      const evStart = controller.eventLog.length;
      let tickHasTrigger = false;
      let shotEv = null;
      let goalEv = null;

      for (let i = 0; i < r.events.length; i++) {
        const ev = r.events[i];
        controller.eventLog.push(ev);
        if (isHighlightTrigger(ev, this.config)) {
          highlightEvents.push(ev);
          tickHasTrigger = true;
        }
        if (ev.type === 'SHOT') shotEv = ev;
        if (ev.type === 'GOAL') goalEv = ev;
      }

      controller.engine.getSnapshot(controller.snapshot);
      const tick = controller.engine.tick;
      controller.ring.push(controller.snapshot, tick, evStart, controller.eventLog.length);

      // Capture shot-to-net trajectory for smooth highlight visual interpolation.
      if (shotEv && goalEv) {
        const goalX = shotEv.x > PITCH_LENGTH / 2 ? PITCH_LENGTH : 0;
        const goalY = 34 + (shotEv.meta?.goalY ?? 0);
        this.shotAnimation = {
          goalTick: tick,
          fromX: shotEv.x,
          fromY: shotEv.y,
          toX: goalX,
          toY: goalY,
          durationTicks: 14,
        };
      }

      // Trigger handling (only if under replay cap)
      if (tickHasTrigger && this.replaysShown < this.replayCap) {
        if (this.phase === 'IDLE') {
          this.phase = 'POST_ROLL';
          this.firstTriggerTick = tick;
          this.replayEndTick = tick + this.postRollTicks;
          this.cutShortByForced = false;
        } else if (this.phase === 'POST_ROLL') {
          const capEnd = this.firstTriggerTick + this.extensionCapTicks;
          this.replayEndTick = Math.min(capEnd, Math.max(this.replayEndTick, tick + this.postRollTicks));
        }
      }

      if (r.stoppedFor === 'FORCED_DECISION') {
        stoppedFor = 'FORCED_DECISION';
        if (this.phase === 'POST_ROLL') {
          this.replayEndTick = tick;
          this.cutShortByForced = true;
          this.#beginReplay(controller.ring);
          return { ticksRun, highlightEvents, startedReplay: true, stoppedFor };
        }
        break;
      }

      if (r.stoppedFor === 'HALF_TIME' || r.stoppedFor === 'FULL_TIME') {
        stoppedFor = r.stoppedFor;
        if (this.phase === 'POST_ROLL') {
          // A replay never spans half-time; end it right here.
          this.replayEndTick = tick;
          this.#beginReplay(controller.ring);
          return { ticksRun, highlightEvents, startedReplay: true, stoppedFor };
        }
        break;
      }

      if (this.phase === 'POST_ROLL' && tick >= this.replayEndTick) {
        this.#beginReplay(controller.ring);
        return { ticksRun, highlightEvents, startedReplay: true, stoppedFor: null };
      }

      if (this.now() - startMs >= this.sliceMs) break;
    }

    return { ticksRun, highlightEvents, startedReplay: false, stoppedFor };
  }

  /**
   * Starts a tap-to-replay of the latest moments: the last `leadUpTicks` of
   * the ring, up to its newest frame. Does not count toward `replayCap`.
   * @param {import('./RenderRing.js').RenderRing} ring
   * @returns {boolean} whether there was anything to replay
   */
  startInstantReplay(ring) {
    const latest = ring.latestTick();
    if (latest < 0) return false;
    const oldest = ring.oldestTick();
    const start = Math.max(oldest, latest - this.leadUpTicks);
    if (start >= latest) return false;
    this.firstTriggerTick = latest;
    this.replayStartTick = start;
    this.replayEndTick = latest;
    this.replayCursor = start;
    this.lastReleasedTick = start - 1;
    this.cutShortByForced = false;
    this.shotAnimation = null;
    this.phase = 'REPLAY';
    return true;
  }

  /** @param {import('./RenderRing.js').RenderRing} ring */
  #beginReplay(ring) {
    const oldest = ring.oldestTick();
    const desired = Math.max(0, this.firstTriggerTick - this.leadUpTicks);
    this.replayStartTick = oldest >= 0 ? Math.max(oldest, desired) : desired;
    this.replayCursor = this.replayStartTick;
    this.lastReleasedTick = this.replayStartTick - 1;
    this.phase = 'REPLAY';
    this.replaysShown++;
  }

  /**
   * Advances the ring replay by `frameSeconds` at `replaySpeed`.
   * Returns the frame snapshot (with optional smooth shot-to-net ball overlay)
   * and the newly released events. Never touches the live engine!
   * @param {number} frameSeconds
   * @param {import('./RenderRing.js').RenderRing} ring
   * @param {any[]} fullEventLog
   * @returns {{snapshot: Float64Array, alpha: number, newEvents: any[], finished: boolean, nextState: 'REPLAY' | 'PAUSED_HIGHLIGHT' | 'PAUSED_FORCED'}}
   */
  stepReplay(frameSeconds, ring, fullEventLog) {
    const dt = Math.min(Math.max(0, frameSeconds), this.config.playback.maxFrameSeconds ?? 0.1);
    this.replayCursor += dt * TICKS_PER_SECOND * this.replaySpeed;
    const done = this.replayCursor >= this.replayEndTick;
    const clampedTick = done ? this.replayEndTick : Math.floor(this.replayCursor);
    const alpha = done ? 1 : this.replayCursor - clampedTick;

    // Collect newly reached events from the ring.
    const newEvents = [];
    for (let t = this.lastReleasedTick + 1; t <= clampedTick; t++) {
      const f = ring.frameAt(t);
      if (f) {
        for (let i = f.eventStart; i < f.eventEnd; i++) newEvents.push(fullEventLog[i]);
      }
    }
    this.lastReleasedTick = clampedTick;

    const frame = ring.frameAt(clampedTick) ?? ring.frameAt(ring.latestTick());
    const snap = frame ? new Float64Array(frame.snapshot) : new Float64Array(371);

    // Smooth shot-to-net visual interpolation on SHOT+GOAL ticks.
    if (this.shotAnimation) {
      const sa = this.shotAnimation;
      const elapsed = clampedTick + alpha - sa.goalTick;
      if (elapsed >= 0 && elapsed <= sa.durationTicks) {
        const s = elapsed / sa.durationTicks;
        const bx = sa.fromX + (sa.toX - sa.fromX) * s;
        const by = sa.fromY + (sa.toY - sa.fromY) * s;
        snap[SNAP_BALL] = bx;
        snap[SNAP_BALL + 1] = by;
        snap[SNAP_BALL + 2] = bx;
        snap[SNAP_BALL + 3] = by;
        snap[SNAP_BALL + 4] = 1.2 * Math.sin(s * Math.PI);
      }
    }

    if (done) {
      const nextState = this.cutShortByForced ? 'PAUSED_FORCED' : 'PAUSED_HIGHLIGHT';
      this.phase = this.cutShortByForced ? 'IDLE' : 'PAUSED_HIGHLIGHT';
      this.countdownRemaining = this.cutShortByForced ? 0 : this.countdownSeconds;
      this.countdownCancelled = false;
      return { snapshot: snap, alpha: 1, newEvents, finished: true, nextState };
    }
    return { snapshot: snap, alpha, newEvents, finished: false, nextState: 'REPLAY' };
  }

  /**
   * Ticks the post-highlight countdown in `PAUSED_HIGHLIGHT`.
   * Returns `true` when the countdown expires and should auto-continue.
   * @param {number} frameSeconds
   * @returns {boolean}
   */
  tickCountdown(frameSeconds) {
    if (this.phase !== 'PAUSED_HIGHLIGHT' || this.countdownCancelled) return false;
    this.countdownRemaining = Math.max(0, this.countdownRemaining - Math.max(0, frameSeconds));
    return this.countdownRemaining <= 0;
  }
}

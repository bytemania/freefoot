/**
 * Playback controller (design §14, item 52).
 *
 * Owns the live `MatchEngine`, the 500-frame `RenderRing`, `BestMoments`, the
 * full event log, and the pull-loop playback state machine:
 *   FULL_MATCH | FAST_FORWARD | REPLAY | PAUSED_HIGHLIGHT | PAUSED_FORCED |
 *   PAUSED | HALF_TIME | FULL_TIME
 *
 * Supports `mode: 'full' | 'best_moments' | 'debug'`.
 */
import { MatchEngine, SNAP_LEN } from '../engine/MatchEngine.js';
import { TICKS_PER_SECOND } from '../engine/TickConfig.js';
import { BestMoments } from './BestMoments.js';
import { RenderRing } from './RenderRing.js';

/**
 * @typedef {'FULL_MATCH' | 'FAST_FORWARD' | 'REPLAY' | 'PAUSED_HIGHLIGHT' | 'PAUSED_FORCED' | 'PAUSED' | 'HALF_TIME' | 'FULL_TIME'} PlaybackState
 * @typedef {'full' | 'best_moments' | 'debug'} PlaybackMode
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
   *   persistence?: import('./Persistence.js').Persistence | null,
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
    persistence = null,
    onFrame = () => {},
  }) {
    this.input = input;
    this.config = config;
    /** @type {PlaybackMode} */
    this.mode = mode;
    this.now = now;
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.persistence = persistence;
    this.onFrame = onFrame;

    const pb = config.playback;
    this.maxTicksPerFrame = pb.maxTicksPerFrame ?? 20;
    this.maxFrameSeconds = pb.maxFrameSeconds ?? 0.1;

    this.engine = MatchEngine.create(input, config);
    this.ring = new RenderRing(pb.ring?.frames ?? 500);
    this.bestMoments = new BestMoments({ config, now });
    this.snapshot = new Float64Array(SNAP_LEN);
    this.engine.getSnapshot(this.snapshot);
    /** @type {import('../engine/events/MatchEvent.js').MatchEvent[]} */
    this.eventLog = [];
    this.ring.push(this.snapshot, 0, 0, 0);

    this.speed = 1;
    this.budget = 0;
    this.droppedBudget = 0;
    /** @type {PlaybackState} */
    this.playbackState = 'PAUSED';
    this.rafId = 0;
    this.lastTs = -1;
    this.running = false;
  }

  /**
   * Restores controller internals from a verified `Persistence.resume()` result.
   * @param {{engine: MatchEngine, events: any[], playbackState: string, mode: string}} resumed
   */
  restoreFrom(resumed) {
    this.pause();
    this.engine = resumed.engine;
    this.eventLog = resumed.events.slice();
    this.ring.clear();
    this.engine.getSnapshot(this.snapshot);
    this.ring.push(this.snapshot, this.engine.tick, 0, this.eventLog.length);
    this.mode = /** @type {PlaybackMode} */ (resumed.mode === 'best_moments' ? 'best_moments' : resumed.mode === 'debug' ? 'debug' : 'full');
    this.playbackState = /** @type {PlaybackState} */ (
      resumed.playbackState === 'PAUSED_HIGHLIGHT' ? 'PAUSED' : (resumed.playbackState ?? 'PAUSED')
    );
    this.onFrame(this.buildFrame([]));
  }

  /** Starts the pull loop in the active mode (`FULL_MATCH` or `FAST_FORWARD`). */
  play() {
    if (this.playbackState === 'FULL_TIME' || this.playbackState === 'PAUSED_FORCED') return;
    if (this.playbackState === 'HALF_TIME') {
      this.stepTicks(1);
      if (/** @type {string} */ (this.playbackState) === 'FULL_TIME') return;
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
    if (this.playbackState === 'FULL_MATCH' || this.playbackState === 'FAST_FORWARD') this.pause();
    else this.play();
  }

  /** @param {number} speed */
  setSpeed(speed) {
    this.speed = Math.max(0, Math.min(60, speed));
    if (this.speed === 0 && this.playbackState === 'FULL_MATCH') {
      this.pause();
    }
  }

  /** @param {PlaybackMode} nextMode */
  setMode(nextMode) {
    if (this.playbackState === 'REPLAY') return;
    this.mode = nextMode;
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

  /** Cancels the Best Moments post-highlight countdown (e.g. when Manager drawer opens). */
  cancelHighlightCountdown() {
    this.bestMoments.cancelCountdown();
  }

  /**
   * Issues a manager command. Rejected during `REPLAY` (design §14).
   * Persists immediately on accepted commands (design §20).
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
      if (this.persistence) {
        void this.persistence.save(this, { force: true });
      }
      this.onFrame(this.buildFrame([]));
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
    let remaining = n;
    while (remaining > 0) {
      const r = this.engine.step(1);
      const start = this.eventLog.length;
      for (let i = 0; i < r.events.length; i++) {
        this.eventLog.push(r.events[i]);
        newEvents.push(r.events[i]);
      }
      this.engine.getSnapshot(this.snapshot);
      this.ring.push(this.snapshot, this.engine.tick, start, this.eventLog.length);
      remaining--;
      if (r.stoppedFor === 'FULL_TIME') {
        this.playbackState = 'FULL_TIME';
        this.running = false;
        void this.persistence?.clear();
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
    const frame = this.buildFrame(newEvents);
    this.onFrame(frame);
    return frame;
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

  /**
   * Pull-loop step (design §14, item 52). Tests call this directly.
   * @param {number} frameSeconds
   */
  tickFrame(frameSeconds) {
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
        void this.persistence?.clear();
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

    // 4. Full Match / Debug pull loop
    if (this.playbackState !== 'FULL_MATCH' || this.speed <= 0) {
      return this.buildFrame([]);
    }
    const dt = Math.min(Math.max(0, frameSeconds), this.maxFrameSeconds);
    this.budget += dt * TICKS_PER_SECOND * this.speed;
    let toStep = Math.floor(this.budget);
    if (toStep > this.maxTicksPerFrame) {
      this.droppedBudget += toStep - this.maxTicksPerFrame;
      toStep = this.maxTicksPerFrame;
      this.budget = Math.min(this.budget - toStep, 1);
    } else {
      this.budget -= toStep;
    }

    const newEvents = [];
    for (let i = 0; i < toStep; i++) {
      const r = this.engine.step(1);
      const start = this.eventLog.length;
      for (let j = 0; j < r.events.length; j++) {
        this.eventLog.push(r.events[j]);
        newEvents.push(r.events[j]);
      }
      this.engine.getSnapshot(this.snapshot);
      this.ring.push(this.snapshot, this.engine.tick, start, this.eventLog.length);
      if (r.stoppedFor === 'FULL_TIME') {
        this.playbackState = 'FULL_TIME';
        this.running = false;
        this.budget = 0;
        void this.persistence?.clear();
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
    }

    const frame = this.buildFrame(newEvents);
    this.onFrame(frame);
    return frame;
  }

  /**
   * @param {import('../engine/events/MatchEvent.js').MatchEvent[]} newEvents
   * @param {Float64Array} [snapshotOverride]
   * @param {number} [alphaOverride]
   */
  buildFrame(newEvents, snapshotOverride, alphaOverride) {
    const alpha = alphaOverride ?? (this.budget < 0 ? 0 : this.budget > 1 ? 1 : this.budget);
    return {
      renderSnapshot: snapshotOverride ?? this.snapshot,
      alpha,
      newEvents,
      stats: this.engine.getStats(),
      playbackState: this.playbackState,
      mode: this.mode,
      tick: this.engine.tick,
      speed: this.speed,
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

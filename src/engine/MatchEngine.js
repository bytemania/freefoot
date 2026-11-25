/**
 * Engine facade (design item 27). Together with the MatchInput and
 * MatchResult contracts this is the whole surface callers use.
 *
 * The full per-tick order of design §3 runs every subsystem: decisions,
 * movement, ball, contacts, restarts and clock, fitness and injuries, and the
 * AI coach.
 */
import { buildTickConfig, DT } from './TickConfig.js';
import { MatchState, TOTAL_PLAYERS } from './state/MatchState.js';
import { validateMatchInput } from './contracts/MatchInput.js';
import { buildMatchResult } from './contracts/MatchResult.js';
import { applyCommand, applyPendingCommands, executeAtStoppage, isStoppage } from './commands/Commands.js';
import { advanceRestart, handleBallOut, settleKickOff, startSecondHalf } from './restarts/RestartMachine.js';
import { updateAdvantage } from './officiating/Referee.js';
import { updateVar, varReviewing } from './officiating/VarSystem.js';
import { advanceClock, addStoppageFor, clockSeconds } from './clock/MatchClock.js';
import { checkInvariants } from './debug/invariants.js';
import { runDecisions } from './decisions/CarrierDecision.js';
import { updateMovement, separatePlayers } from './movement/Movement.js';
import { updateBall } from './ball/BallPhysics.js';
import { resolveContacts } from './resolve/contacts.js';
import { updateFitness } from './fitness/Fitness.js';
import { updateInjuries } from './injuries/Injuries.js';
import { onPlayerEvents, updateMorale } from './morale/Morale.js';
import { updateShouts } from './tactics/Shouts.js';
import { rateEvents } from './stats/Rating.js';
import { evaluate as evaluateAiCoach } from './ai/AiCoach.js';

export const ENGINE_VERSION = '0.3.0';

// getSnapshot layout (design item 27). Each player: prevX, prevY, x, y,
// onPitch, team, card, injury, isKeeper, fitness, rating (0-10), morale (0-100).
export const SNAP_HEADER = 0;
export const SNAP_BALL = 6;
export const SNAP_PLAYERS = 11;
export const SNAP_PLAYER_STRIDE = 12;
export const SNAP_LEN = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * TOTAL_PLAYERS;
export const FLAG_AWAITING_DECISION = 1;
export const FLAG_DEAD_BALL = 2;
export const FLAG_FULL_TIME = 4;
/** A VAR review is on (VAR_CHECK shown, VAR_DECISION not yet). */
export const FLAG_VAR_REVIEW = 8;

/** @typedef {null | 'FORCED_DECISION' | 'HALF_TIME' | 'FULL_TIME'} StoppedFor */
/** @typedef {import('./events/MatchEvent.js').MatchEvent} MatchEvent */
/** @typedef {import('./commands/Commands.js').Command} Command */
/** @typedef {import('./commands/Commands.js').LoggedCommand} LoggedCommand */

export class MatchEngine {
  /**
   * @param {MatchState} state
   * @param {import('./contracts/MatchInput.js').MatchInput} input
   * @param {any} config
   * @param {boolean} debug
   */
  constructor(state, input, config, debug) {
    this.state = state;
    this.input = input;
    this.config = config;
    this.debug = debug;
    /** @type {LoggedCommand[]} */
    this.commandLog = state.commandLog;
    /** @type {MatchEvent[]} every event since this engine was created or restored */
    this.eventLog = [];
    this.lastSeq = state.eventSeq - 1;
  }

  /**
   * @param {import('./contracts/MatchInput.js').MatchInput} matchInput
   * @param {any} config compiled config (generated/config.js)
   * @param {{debug?: boolean}} [options]
   * @returns {MatchEngine}
   */
  static create(matchInput, config, { debug = false } = {}) {
    const errors = validateMatchInput(matchInput, config);
    if (errors.length > 0) throw new Error(`invalid MatchInput:\n${errors.join('\n')}`);
    const state = new MatchState(matchInput, config, buildTickConfig(config), debug);
    settleKickOff(state); // the opening kick-off lines up by Law 8 too
    return new MatchEngine(state, matchInput, config, debug);
  }

  /**
   * Restores an engine from `serialize()` output. The command log and the
   * event history are not part of the state: callers keep their own.
   * @param {Record<string, any>} serialized
   * @param {import('./contracts/MatchInput.js').MatchInput} matchInput
   * @param {any} config
   * @param {{debug?: boolean}} [options]
   * @returns {MatchEngine}
   */
  static fromState(serialized, matchInput, config, { debug = false } = {}) {
    const errors = validateMatchInput(matchInput, config);
    if (errors.length > 0) throw new Error(`invalid MatchInput:\n${errors.join('\n')}`);
    const state = MatchState.restore(serialized, matchInput, config, buildTickConfig(config), debug);
    return new MatchEngine(state, matchInput, config, debug);
  }

  /** The last completed tick. */
  get tick() {
    return this.state.tick;
  }

  /**
   * Runs up to `n` ticks. Stops early at a forced decision, half-time or
   * full-time; calling `step` again after half-time starts the second half.
   * @param {number} [n]
   * @returns {{ticksRun: number, events: MatchEvent[], stoppedFor: StoppedFor}}
   */
  step(n = 1) {
    const s = this.state;
    /** @type {MatchEvent[]} */
    const events = [];
    /** @type {() => string} */
    const phase = () => s.restart.state;
    if (s.restart.state === 'FULL_TIME') return { ticksRun: 0, events, stoppedFor: 'FULL_TIME' };
    if (s.restart.state === 'HALF_TIME') startSecondHalf(s);
    if (s.awaitingDecision) return { ticksRun: 0, events, stoppedFor: 'FORCED_DECISION' };

    let ticksRun = 0;
    /** @type {StoppedFor} */
    let stoppedFor = null;
    while (ticksRun < n) {
      this.#runTick(events);
      ticksRun++;
      if (phase() === 'HALF_TIME') stoppedFor = 'HALF_TIME';
      else if (phase() === 'FULL_TIME') stoppedFor = 'FULL_TIME';
      else if (s.awaitingDecision) stoppedFor = 'FORCED_DECISION';
      if (stoppedFor !== null) break;
    }
    return { ticksRun, events, stoppedFor };
  }

  /**
   * One tick, in the fixed order of design §3.
   * @param {MatchEvent[]} out
   */
  #runTick(out) {
    const s = this.state;
    s.tick++;
    s.tickEvents.length = 0;
    s.released = null;

    applyPendingCommands(s); // 1. commands issued on the previous tick
    runDecisions(s); // 2. decisions
    updateMovement(s, DT); // 3. movement
    separatePlayers(s); //    then player bodies are kept apart
    updateBall(s, DT); // 4. ball
    resolveContacts(s); // 5. contacts
    handleBallOut(s); // 6. ball out of play, restart state machine
    updateVar(s); //    VAR checks and decisions (nothing in a match without VAR)
    advanceRestart(s);
    updateAdvantage(s);
    advanceClock(s); //    and clock
    updateFitness(s); // 7. fitness, injuries and morale
    updateInjuries(s);
    updateMorale(s);
    updateShouts(s); //    and coach shouts (nothing for a team that has not shouted)
    if (s.tick % s.k.evalIntervalTicks === 0) {
      for (const team of s.teams) {
        if (team.controlledBy === 'ai') evaluateAiCoach(s, team); // 8. AI coach
      }
    }

    // 9. append events and update stats
    for (let i = 0; i < s.onPitchList.length; i++) s.players[s.onPitchList[i]].ticksOnPitch++;
    s.stats.onTick(s);
    rateEvents(s, s.tickEvents); //    per-player match ratings
    onPlayerEvents(s, s.tickEvents); //    and individual morale
    for (const event of s.tickEvents) {
      s.stats.onEvent(event);
      addStoppageFor(s, event);
      out.push(event);
      this.eventLog.push(event);
    }
    if (this.debug) {
      checkInvariants(s, s.tickEvents, this.lastSeq);
      s.hash(); // throws on NaN or Infinity in state
    }
    if (s.tickEvents.length > 0) this.lastSeq = s.tickEvents[s.tickEvents.length - 1].seq;
  }

  /**
   * Queues a command (§12). Returns `{ok, code}`.
   *
   * When the ball is stopped (any dead ball, half-time or a forced-decision
   * pause) an accepted command takes effect at once: queued substitutions are
   * made and their `SUBSTITUTION` events are returned in `events` (and added
   * to the stats and the event log), so a paused coach sees the change
   * immediately. `replay` calls this the same way, so replays stay identical.
   * @param {Command} cmd
   * @returns {{ok: boolean, code: string | null, seq?: number, events?: MatchEvent[]}}
   */
  applyCommand(cmd) {
    const s = this.state;
    const stopped = isStoppage(s);
    const res = applyCommand(s, cmd, this.commandLog);
    if (!res.ok || !stopped || (s.pendingCommands.length === 0 && s.pendingSubs.length === 0)) return res;
    const mark = s.tickEvents.length;
    executeAtStoppage(s);
    const events = s.tickEvents.splice(mark);
    if (events.length === 0) return res;
    for (const event of events) {
      s.stats.onEvent(event);
      addStoppageFor(s, event);
      this.eventLog.push(event);
    }
    this.lastSeq = events[events.length - 1].seq;
    return { ...res, events };
  }

  /**
   * Fills a caller-owned Float64Array of length SNAP_LEN for rendering.
   * @param {Float64Array} out
   * @returns {Float64Array}
   */
  getSnapshot(out) {
    const s = this.state;
    out[0] = s.tick;
    out[1] = s.teams[0].score;
    out[2] = s.teams[1].score;
    out[3] = clockSeconds(s);
    out[4] = s.clock.half;
    out[5] =
      (s.awaitingDecision ? FLAG_AWAITING_DECISION : 0) |
      (s.restart.state === 'DEAD_BALL' ? FLAG_DEAD_BALL : 0) |
      (s.restart.state === 'FULL_TIME' ? FLAG_FULL_TIME : 0) |
      (varReviewing(s) ? FLAG_VAR_REVIEW : 0);
    const b = s.ball;
    out[SNAP_BALL] = b.prevX;
    out[SNAP_BALL + 1] = b.prevY;
    out[SNAP_BALL + 2] = b.x;
    out[SNAP_BALL + 3] = b.y;
    out[SNAP_BALL + 4] = b.height;
    for (let i = 0; i < TOTAL_PLAYERS; i++) {
      const p = s.players[i];
      const o = SNAP_PLAYERS + SNAP_PLAYER_STRIDE * i;
      out[o] = p.prevX;
      out[o + 1] = p.prevY;
      out[o + 2] = p.x;
      out[o + 3] = p.y;
      out[o + 4] = p.onPitch;
      out[o + 5] = p.team;
      out[o + 6] = p.card;
      out[o + 7] = p.injury;
      out[o + 8] = p.isKeeper;
      out[o + 9] = p.fitness;
      out[o + 10] = p.rating;
      out[o + 11] = p.morale;
    }
    return out;
  }

  /** Per-team statistics. Callers should call it at most once per frame. */
  getStats() {
    return this.state.stats.toJSON(this.state);
  }

  /**
   * The result, available at full time.
   * @returns {import('./contracts/MatchResult.js').MatchResult}
   */
  getResult() {
    if (this.state.restart.state !== 'FULL_TIME') throw new Error('getResult: the match is not finished');
    return buildMatchResult(this.state, this.eventLog, ENGINE_VERSION);
  }

  /** @returns {Record<string, any>} the full restorable state */
  serialize() {
    return this.state.serialize();
  }

  /** @returns {number} state hash (uint32) */
  hash() {
    return this.state.hash();
  }

  /** @returns {LoggedCommand[]} accepted commands, human and AI */
  getCommandLog() {
    return this.commandLog.slice();
  }

  /**
   * Re-simulates a match to `toTick`: before stepping tick t + 1 it applies the
   * log's human entries stamped t, in `seq` order. AI entries are not applied;
   * the AI coach re-derives them. A forced decision that stops `step()` is
   * resolved by that tick's pending human entries; half-time continues
   * automatically.
   * @param {import('./contracts/MatchInput.js').MatchInput} input
   * @param {any} config
   * @param {LoggedCommand[]} log
   * @param {number} toTick
   * @param {{debug?: boolean}} [opts]
   * @returns {{engine: MatchEngine, events: MatchEvent[]}}
   */
  static replay(input, config, log, toTick, opts = {}) {
    const engine = MatchEngine.create(input, config, opts);
    const human = log.filter((e) => e.issuer === 'human').sort((a, b) => a.seq - b.seq);
    /** @type {MatchEvent[]} */
    const events = [];
    let next = 0;
    while (engine.tick < toTick) {
      const before = next;
      while (next < human.length && human[next].tick <= engine.tick) {
        const e = human[next++];
        const res = engine.applyCommand({ issuer: 'human', type: e.type, teamIndex: e.teamIndex, payload: e.payload });
        if (res.events) events.push(...res.events);
      }
      const r = engine.step(1);
      events.push(...r.events);
      if (r.stoppedFor === 'FULL_TIME') break;
      if (r.ticksRun === 0 && r.stoppedFor === 'FORCED_DECISION' && next === before) break; // nothing can resolve it
    }
    return { engine, events };
  }
}

/**
 * All state that changes during a match (design §4, item 30). Entities refer
 * to each other by integer index, never by object reference, so
 * `serialize()` and `restore()` round-trip through JSON.
 */
import { hashValue } from '../math/hash.js';
import { formatShortName } from '../contracts/MatchInput.js';
import { seedSfc32 } from '../rng/streams.js';
import { makeEvent } from '../events/MatchEvent.js';
import { MatchStats } from '../stats/MatchStats.js';
import { PlayerMatchState } from './PlayerMatchState.js';
import { TeamState } from './TeamState.js';
import { BallState } from './BallState.js';
import { initialMorale, refreshTeamMorale } from '../morale/Morale.js';
import { ageFactors } from '../fitness/Fitness.js';
import { ratingFromPoints } from '../stats/Rating.js';
import { isDefaultInstructions, setInstructions } from '../tactics/Instructions.js';
import { refreshShoutKnobs } from '../tactics/Shouts.js';

export const STATE_VERSION = 1;
export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;
export const PLAYERS_PER_TEAM = 18;
export const TOTAL_PLAYERS = 36;
export const STARTERS = 11;

/**
 * @param {number} v
 * @param {string} path
 * @returns {number}
 */
function num(v, path) {
  if (!Number.isFinite(v)) throw new Error(`serialize: non-finite number at ${path}`);
  return v === 0 ? 0 : v;
}

export class MatchState {
  /**
   * @param {import('../contracts/MatchInput.js').MatchInput} input
   * @param {any} config compiled config
   * @param {import('../TickConfig.js').TickConfig} tickConfig
   * @param {boolean} debug
   */
  constructor(input, config, tickConfig, debug) {
    // Cold data and wiring: not part of the saved state.
    this.config = config;
    this.k = tickConfig;
    this.debug = debug;
    this.seed = input.seed >>> 0;
    this.configHash = input.configHash;
    /** Events built during the current tick; `step()` drains it. */
    this.tickEvents = /** @type {import('../events/MatchEvent.js').MatchEvent[]} */ ([]);
    /**
     * Set on the tick a restart is released (play resumes), null otherwise:
     * what the restart was and how many players the referee had to move.
     * Transient like `tickEvents`: never serialized or hashed.
     * @type {null | {kind: string, teamIndex: number, x: number, y: number, taker: number, snapped: number}}
     */
    this.released = null;
    /**
     * Test probe: called as a restart is released, with the live positions
     * (before the restart's action runs). Never set by the engine itself.
     * @type {null | ((state: MatchState, released: NonNullable<MatchState['released']>) => void)}
     */
    this.onRelease = null;
    /**
     * The direct free-kick wall being set this tick (restarts/wall.js), in order across it, and the tick it was
     * set on: its members stand shoulder to shoulder, so body separation leaves them be (movement/Movement.js).
     * Rebuilt every dead-ball tick before movement; transient like `tickEvents`: never serialized or hashed.
     */
    this.wall = { tick: -1, members: /** @type {number[]} */ ([]) };
    /** Where the ball left play this tick (scratch, set by `updateBall`): code, then the point. */
    this.ballStatus = { code: 0, x: 0, y: 0, side: 0, landed: false, speed: 0 };
    /** Accepted commands, human and AI, in order (owned by the engine; not saved state). */
    this.commandLog = /** @type {import('../commands/Commands.js').LoggedCommand[]} */ ([]);

    // Saved state, in serialize() order.
    this.stateVersion = STATE_VERSION;
    this.tick = 0;
    this.rng = seedSfc32(new Uint32Array(4), this.seed);
    this.clock = { half: 1, halfTick: 0, addedSeconds: 0, addedTicks: 0, announced: false };
    this.restart = {
      state: /** @type {'IN_PLAY' | 'DEAD_BALL' | 'HALF_TIME' | 'FULL_TIME'} */ ('DEAD_BALL'),
      kind: /** @type {string} */ ('KICK_OFF'),
      teamIndex: 0,
      x: PITCH_LENGTH / 2,
      y: PITCH_WIDTH / 2,
      resumeTick: config.tactics.setPieces.KICK_OFF.seconds * 20,
      /** Player index of the taker, or -1. */
      taker: -1,
      /** Whether a free kick is direct. */
      direct: false,
      /** Whether the restart event has been emitted. */
      announced: false,
    };
    this.ball = new BallState();
    this.teams = [
      new TeamState(0, input.home.controlledBy, input.home.formationId),
      new TeamState(1, input.away.controlledBy, input.away.formationId),
    ];
    for (const [idx, teamIn] of [input.home, input.away].entries()) {
      const team = this.teams[idx];
      if (teamIn.tacticalPlans) {
        const freezeSlot = (/** @type {import('../contracts/MatchInput.js').TacticalPlanSlot} */ slot) =>
          Object.freeze({
            tacticId: slot.tacticId,
            formationId: slot.formationId,
            instructions: Object.freeze({ ...(slot.instructions ?? {}) }),
            formFam: slot.formFam,
            instrFam: slot.instrFam,
          });
        team.tacticalPlans = Object.freeze({
          planA: freezeSlot(teamIn.tacticalPlans.planA),
          planB: freezeSlot(teamIn.tacticalPlans.planB),
        });
        team.activePlan = 'A';
        team.planTicks = { A: 0, B: 0, modA: 0, modB: 0 };
      }
    }
    setInstructions(config.tactics?.instructions, this.teams[0], input.home.instructions);
    setInstructions(config.tactics?.instructions, this.teams[1], input.away.instructions);
    // The silence clock of coach shouts runs only for a side that asks for it.
    this.teams[0].shoutsEnabled = input.home.shouts === true && config.shouts !== undefined;
    this.teams[1].shoutsEnabled = input.away.shouts === true && config.shouts !== undefined;
    /** @type {PlayerMatchState[]} 36 permanent indices: home 0-17, away 18-35 */
    this.players = [];
    for (const [t, team] of [input.home, input.away].entries()) {
      team.players.forEach((p, i) => {
        const cold = Object.freeze({ ...p, shortName: p.shortName || formatShortName(p.name) });
        const player = new PlayerMatchState(t * PLAYERS_PER_TEAM + i, t, cold);
        player.baseMorale = initialMorale(p, team, tickConfig.weights.morale.neutral);
        const age = ageFactors(p.age, p.attributes.stamina, tickConfig.weights.fitness.age);
        player.ageDrain = age.drain;
        player.ageRecovery = age.recovery;
        this.players.push(player);
      });
    }
    refreshTeamMorale(this, 0);
    refreshTeamMorale(this, 1);
    /** @type {{seq: number, teamIndex: number, outIndex: number, inIndex: number}[]} */
    this.pendingSubs = [];
    /**
     * The last completed pass, for KEY_PASS and ASSIST.
     * @type {null | {passer: number, receiver: number, tick: number, kind: string}}
     */
    this.lastPass = null;
    /**
     * An advantage being played after a foul.
     * @type {null | {team: number, startTick: number, startAlong: number, x: number, y: number, fouler: number, fouled: number}}
     */
    this.advantage = null;
    this.stats = new MatchStats(config.events.types);
    this.eventSeq = 0;
    this.commandSeq = 0;
    /** Accepted commands that take effect at step 1 of the next tick. */
    this.pendingCommands = /** @type {{seq: number, tick: number, issuer: string, type: string, teamIndex: number, payload: Record<string, any>}[]} */ ([]);
    this.awaitingDecision = false;
    /**
     * VAR (officiating/VarSystem.js): null in a match without it (the match input has no `var: true`), and
     * then never serialized, so those matches keep their hash.
     * @type {import('../officiating/VarSystem.js').VarState | null}
     */
    this.var = input.var === true && config.var?.enabled === true ? { review: null, move: null } : null;

    /** Ascending indices of players on the pitch. Derived from `onPitch`. */
    this.onPitchList = /** @type {number[]} */ ([]);
    this.#placeStarters();
    this.rebuildOnPitchList();
  }

  /** Puts each team's starters on the pitch at their formation slots. */
  #placeStarters() {
    for (const team of this.teams) {
      const slots = this.config.tactics.formations[team.formationId].slots;
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
        const p = this.players[team.index * PLAYERS_PER_TEAM + i];
        if (i < STARTERS) {
          p.onPitch = 1;
          p.slot = i;
          p.isKeeper = i === 0 ? 1 : 0;
          this.placeAtAnchor(p, slots[i].defend);
        } else {
          // Bench: parked beside the halfway line.
          p.x = p.prevX = p.tx = PITCH_LENGTH / 2;
          p.y = p.prevY = p.ty = -2;
        }
      }
    }
  }

  /**
   * Puts a player at a formation anchor (pitch fractions from their team's
   * own goal), converted to pitch metres for the current attacking direction.
   * Kick-off positions stay in the team's own half.
   * @param {PlayerMatchState} p
   * @param {number[]} anchor [x, y] fractions
   */
  placeAtAnchor(p, anchor) {
    const fx = anchor[0] > 0.49 ? 0.49 : anchor[0];
    const dir = this.attackDir(p.team);
    p.x = dir > 0 ? fx * PITCH_LENGTH : PITCH_LENGTH - fx * PITCH_LENGTH;
    p.y = dir > 0 ? anchor[1] * PITCH_WIDTH : PITCH_WIDTH - anchor[1] * PITCH_WIDTH;
    p.prevX = p.tx = p.x;
    p.prevY = p.ty = p.y;
    p.vx = 0;
    p.vy = 0;
  }

  /**
   * +1 when the team attacks toward x = 105. Home attacks +x in the first
   * half; sides swap at half-time.
   * @param {number} teamIndex
   * @returns {1 | -1}
   */
  attackDir(teamIndex) {
    return (teamIndex === 0) === (this.clock.half === 1) ? 1 : -1;
  }

  rebuildOnPitchList() {
    this.onPitchList.length = 0;
    for (let i = 0; i < TOTAL_PLAYERS; i++) {
      if (this.players[i].onPitch === 1) this.onPitchList.push(i);
    }
  }

  /**
   * Builds an event for the current tick and queues it for step 9.
   * @param {string} type
   * @param {Parameters<typeof makeEvent>[2]} [fields]
   * @returns {import('../events/MatchEvent.js').MatchEvent}
   */
  emit(type, fields) {
    const event = makeEvent(this, type, fields);
    this.tickEvents.push(event);
    return event;
  }

  /**
   * Swaps two players: the incoming player takes the outgoing player's
   * formation slot and place on the pitch. A sent-off player's `onPitch`
   * stays 0 and they never return.
   * @param {number} outIndex
   * @param {number} inIndex
   */
  substitute(outIndex, inIndex) {
    const out = this.players[outIndex];
    const incoming = this.players[inIndex];
    incoming.onPitch = 1;
    incoming.slot = out.slot;
    incoming.isKeeper = out.isKeeper;
    incoming.x = incoming.prevX = incoming.tx = out.x;
    incoming.y = incoming.prevY = incoming.ty = out.y;
    incoming.vx = 0;
    incoming.vy = 0;
    out.onPitch = 0;
    out.slot = -1;
    out.isKeeper = 0;
    this.rebuildOnPitchList();
  }

  /**
   * Plain object of the full restorable state, with fields in a fixed order.
   * `-0` is written as `+0`; throws on NaN or Infinity.
   * @returns {Record<string, any>}
   */
  serialize() {
    const b = this.ball;
    const f = b.flight;
    return {
      stateVersion: this.stateVersion,
      tick: this.tick,
      rng: [this.rng[0], this.rng[1], this.rng[2], this.rng[3]],
      clock: { ...this.clock },
      restart: {
        state: this.restart.state,
        kind: this.restart.kind,
        teamIndex: this.restart.teamIndex,
        x: num(this.restart.x, 'restart.x'),
        y: num(this.restart.y, 'restart.y'),
        resumeTick: this.restart.resumeTick,
        announced: this.restart.announced,
        taker: this.restart.taker,
        direct: this.restart.direct,
      },
      ball: {
        x: num(b.x, 'ball.x'),
        y: num(b.y, 'ball.y'),
        prevX: num(b.prevX, 'ball.prevX'),
        prevY: num(b.prevY, 'ball.prevY'),
        vx: num(b.vx, 'ball.vx'),
        vy: num(b.vy, 'ball.vy'),
        vz: num(b.vz, 'ball.vz'),
        az: num(b.az, 'ball.az'),
        z: num(b.z, 'ball.z'),
        maxZ: num(b.maxZ, 'ball.maxZ'),
        height: num(b.height, 'ball.height'),
        owner: b.owner,
        lastTouch: b.lastTouch,
        touchTick: b.touchTick,
        pass: b.pass === null ? null : { ...b.pass, tried: [...b.pass.tried], px: num(b.pass.px, 'ball.pass.px'), py: num(b.pass.py, 'ball.pass.py') },
        flight:
          f === null
            ? null
            : {
                launchTick: f.launchTick,
                x0: num(f.x0, 'ball.flight.x0'),
                y0: num(f.y0, 'ball.flight.y0'),
                x1: num(f.x1, 'ball.flight.x1'),
                y1: num(f.y1, 'ball.flight.y1'),
                flightTicks: f.flightTicks,
                peak: num(f.peak, 'ball.flight.peak'),
              },
      },
      teams: this.teams.map((t) => ({
        score: t.score,
        formationId: t.formationId,
        reduced: t.reduced,
        subsUsed: t.subsUsed,
        pressTicks: t.pressTicks,
        phase: t.phase,
        phaseTick: t.phaseTick,
        supportPlayer: [...t.supportPlayer],
        supportX: [num(t.supportX[0], 'team.supportX'), num(t.supportX[1], 'team.supportX')],
        supportY: [num(t.supportY[0], 'team.supportY'), num(t.supportY[1], 'team.supportY')],
        subWindows: t.subWindows,
        inSubWindow: t.inSubWindow,
        forcedDecision: t.forcedDecision,
        forcedKind: t.forcedKind,
        forcedPlayer: t.forcedPlayer,
        aiFired: [...t.aiFired],
        moraleShift: num(t.moraleShift, 'team.moraleShift'),
        // Written only when a Plan A/B snapshot is active (omitted for `tacticalPlans === null`).
        ...(t.activePlan === 'B' ? { activePlan: 'B' } : {}),
        ...(t.planTicks === null ? {} : { planTicks: { A: t.planTicks.A, B: t.planTicks.B, modA: t.planTicks.modA, modB: t.planTicks.modB } }),
        // Written only when an instruction is off its default, so all-default matches keep their hash.
        ...(isDefaultInstructions(this.config.tactics?.instructions, t.instructions) ? {} : { instructions: { ...t.instructions } }),
        // Written only once the team has shouted (or runs the silence clock and it moved), so matches
        // without shouts keep their hash.
        ...(t.shout === null
          ? {}
          : {
              shout: {
                lastTick: t.shout.lastTick,
                count: t.shout.count,
                load: num(t.shout.load, 'team.shout.load'),
                active: t.shout.active === null ? null : { ...t.shout.active, share: num(t.shout.active.share, 'team.shout.active.share') },
                cooldowns: { ...t.shout.cooldowns },
              },
            }),
      })),
      players: this.players.map((p, i) => {
        const at = `players[${i}]`;
        return {
          slot: p.slot,
          onPitch: p.onPitch,
          x: num(p.x, `${at}.x`),
          y: num(p.y, `${at}.y`),
          prevX: num(p.prevX, `${at}.prevX`),
          prevY: num(p.prevY, `${at}.prevY`),
          vx: num(p.vx, `${at}.vx`),
          vy: num(p.vy, `${at}.vy`),
          tx: num(p.tx, `${at}.tx`),
          ty: num(p.ty, `${at}.ty`),
          fitness: num(p.fitness, `${at}.fitness`),
          distance: num(p.distance, `${at}.distance`),
          sprints: p.sprints,
          sprinting: p.sprinting,
          sprintCooldown: num(p.sprintCooldown, `${at}.sprintCooldown`),
          decisionTimer: p.decisionTimer,
          pendingAction: p.pendingAction,
          px: num(p.px, `${at}.px`),
          py: num(p.py, `${at}.py`),
          markTarget: p.markTarget,
          out: p.out,
          injury: p.injury,
          card: p.card,
          fouls: p.fouls,
          isKeeper: p.isKeeper,
          ticksOnPitch: p.ticksOnPitch,
          morale: num(p.morale, `${at}.morale`),
          personalShift: num(p.personalShift, `${at}.personalShift`),
          ratingPoints: num(p.ratingPoints, `${at}.ratingPoints`),
          ...(p.focus === 0 ? {} : { focus: num(p.focus, `${at}.focus`) }),
        };
      }),
      pendingSubs: this.pendingSubs.map((s) => ({ ...s })),
      lastPass: this.lastPass === null ? null : { ...this.lastPass },
      advantage: this.advantage === null ? null : { ...this.advantage, startAlong: num(this.advantage.startAlong, 'advantage.startAlong'), x: num(this.advantage.x, 'advantage.x'), y: num(this.advantage.y, 'advantage.y') },
      stats: this.stats.serialize(),
      eventSeq: this.eventSeq,
      commandSeq: this.commandSeq,
      pendingCommands: this.pendingCommands.map((c) => ({
        seq: c.seq,
        tick: c.tick,
        issuer: c.issuer,
        type: c.type,
        teamIndex: c.teamIndex,
        payload: { ...c.payload },
      })),
      awaitingDecision: this.awaitingDecision,
      ...(this.var === null
        ? {}
        : {
            var: {
              review:
                this.var.review === null
                  ? null
                  : { ...this.var.review, x: num(this.var.review.x, 'var.review.x'), y: num(this.var.review.y, 'var.review.y'), fx: num(this.var.review.fx, 'var.review.fx'), fy: num(this.var.review.fy, 'var.review.fy') },
              move: this.var.move === null ? null : { ...this.var.move, margin: num(this.var.move.margin, 'var.move.margin'), x: num(this.var.move.x, 'var.move.x'), y: num(this.var.move.y, 'var.move.y') },
            },
          }),
    };
  }

  /**
   * Rebuilds a state from `serialize()` output (possibly JSON round-tripped)
   * and the cold input data.
   * @param {Record<string, any>} data
   * @param {import('../contracts/MatchInput.js').MatchInput} input
   * @param {any} config
   * @param {import('../TickConfig.js').TickConfig} tickConfig
   * @param {boolean} debug
   * @returns {MatchState}
   */
  static restore(data, input, config, tickConfig, debug) {
    if (data.stateVersion !== STATE_VERSION) {
      throw new Error(`restore: unsupported stateVersion ${data.stateVersion}`);
    }
    const s = new MatchState(input, config, tickConfig, debug);
    s.tick = data.tick;
    for (let i = 0; i < 4; i++) s.rng[i] = data.rng[i];
    Object.assign(s.clock, data.clock);
    Object.assign(s.restart, data.restart);
    Object.assign(s.ball, data.ball);
    s.ball.flight = data.ball.flight === null ? null : { ...data.ball.flight };
    s.ball.pass = data.ball.pass === null ? null : { ...data.ball.pass, tried: [...data.ball.pass.tried] };
    data.teams.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
      const team = s.teams[i];
      team.score = t.score;
      team.formationId = t.formationId;
      team.reduced = t.reduced;
      team.subsUsed = t.subsUsed;
      team.pressTicks = t.pressTicks ?? 0;
      team.phase = t.phase ?? 0;
      team.phaseTick = t.phaseTick ?? 0;
      team.supportPlayer = t.supportPlayer ? [...t.supportPlayer] : [-1, -1];
      team.supportX = t.supportX ? [...t.supportX] : [0, 0];
      team.supportY = t.supportY ? [...t.supportY] : [0, 0];
      team.subWindows = t.subWindows ?? 0;
      team.inSubWindow = t.inSubWindow ?? false;
      team.forcedDecision = t.forcedDecision;
      team.forcedKind = t.forcedKind;
      team.forcedPlayer = t.forcedPlayer;
      team.aiFired = [...t.aiFired];
      team.moraleShift = t.moraleShift ?? 0;
      if (team.tacticalPlans !== null) {
        team.activePlan = t.activePlan === 'B' ? 'B' : 'A';
        team.planTicks = t.planTicks
          ? { A: t.planTicks.A ?? 0, B: t.planTicks.B ?? 0, modA: t.planTicks.modA ?? 0, modB: t.planTicks.modB ?? 0 }
          : { A: 0, B: 0, modA: 0, modB: 0 };
      }
      team.shout = t.shout ? { ...t.shout, active: t.shout.active ? { ...t.shout.active } : null, cooldowns: { ...t.shout.cooldowns } } : null;
      if (team.shout !== null) refreshShoutKnobs(config.shouts, team);
      setInstructions(config.tactics?.instructions, team, t.instructions);
    });
    data.players.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
      Object.assign(s.players[i], p);
      s.players[i].rating = ratingFromPoints(s.players[i].ratingPoints, tickConfig.weights.rating ?? undefined);
    });
    s.pendingSubs = data.pendingSubs.map((/** @type {any} */ x) => ({ ...x }));
    s.lastPass = data.lastPass === null ? null : { ...data.lastPass };
    s.advantage = data.advantage === null ? null : { ...data.advantage };
    s.stats.restore(data.stats);
    s.eventSeq = data.eventSeq;
    s.commandSeq = data.commandSeq;
    s.pendingCommands = data.pendingCommands.map((/** @type {any} */ c) => ({ ...c, payload: { ...c.payload } }));
    s.awaitingDecision = data.awaitingDecision;
    if (s.var !== null && data.var) s.var = { review: data.var.review ? { ...data.var.review } : null, move: data.var.move ? { ...data.var.move } : null };
    s.rebuildOnPitchList();
    refreshTeamMorale(s, 0);
    refreshTeamMorale(s, 1);
    return s;
  }

  /**
   * FNV-1a over the canonical bytes of `serialize()`.
   * @returns {number} uint32
   */
  hash() {
    return hashValue(this.serialize());
  }
}

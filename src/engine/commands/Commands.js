/**
 * Commands (design §12, item 48). One entry point validates in the §12 order,
 * assigns `seq`, stamps `tick` (the last completed tick), queues the command to
 * take effect at step 1 of the next tick, and logs it. Only human entries are
 * re-applied by `MatchEngine.replay`; the AI coach re-derives its own.
 */
import { setFormation, reduce, swapPlayerPositions } from '../tactics/Formation.js';
import { performSubstitution, applyQueuedSubstitutions } from '../restarts/RestartMachine.js';
import { benchOf, leavePitch, standInKeeper, substitutionsLeft, substitutionWindowsExhausted } from './Forced.js';
import { normalizeInstructions, setInstructions, validateInstructions } from '../tactics/Instructions.js';
import { issueShout, shoutRefusal } from '../tactics/Shouts.js';

export const COMMAND_TYPES = Object.freeze([
  'SUBSTITUTE',
  'SET_FORMATION',
  'CANCEL_SUBSTITUTION',
  'RESOLVE_FORCED',
  'SWAP_POSITIONS',
  'SET_INSTRUCTIONS',
  'ISSUE_SHOUT',
  'SWITCH_TACTIC_PLAN',
  'CANCEL_TACTIC_PLAN',
]);

/**
 * @typedef {object} Command
 * @property {'human' | 'ai'} issuer
 * @property {string} type
 * @property {number} teamIndex
 * @property {Record<string, any>} [payload]
 *
 * @typedef {object} LoggedCommand
 * @property {number} seq
 * @property {number} tick the last completed tick when the command was issued
 * @property {'human' | 'ai'} issuer
 * @property {string} type
 * @property {number} teamIndex
 * @property {Record<string, any>} payload
 */

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {Command} cmd
 * @param {LoggedCommand[]} log
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} [queued] what to queue for step 1 of the next tick, if anything
 * @returns {{ok: true, code: null, seq: number}}
 */
function accept(state, cmd, log, payload, queued) {
  const seq = ++state.commandSeq;
  const entry = { seq, tick: state.tick, issuer: cmd.issuer, type: cmd.type, teamIndex: cmd.teamIndex, payload: { ...payload } };
  if (queued !== undefined) state.pendingCommands.push({ ...entry, payload: { ...queued } });
  log.push(Object.freeze({ ...entry, payload: Object.freeze({ ...payload }) }));
  return { ok: true, code: null, seq };
}

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {Command} cmd
 * @param {LoggedCommand[]} log
 * @returns {{ok: boolean, code: string | null, seq?: number}}
 */
export function applyCommand(state, cmd, log) {
  const fail = (/** @type {string} */ code) => ({ ok: false, code });
  if (!COMMAND_TYPES.includes(cmd.type)) return fail('UNKNOWN_TYPE');
  if (cmd.teamIndex !== 0 && cmd.teamIndex !== 1) return fail('BAD_TEAM');
  if (state.restart.state === 'FULL_TIME') return fail('MATCH_OVER');
  const team = state.teams[cmd.teamIndex];
  const payload = cmd.payload ?? {};
  if (team.forcedDecision && cmd.type !== 'RESOLVE_FORCED') return fail('DECISION_PENDING');
  const own = (/** @type {number} */ i) => Number.isInteger(i) && i >= cmd.teamIndex * 18 && i < (cmd.teamIndex + 1) * 18;

  switch (cmd.type) {
    case 'SET_FORMATION':
      if (team.tacticalPlans !== null) return fail('USE_TACTIC_PLAN');
      if (!(payload.formationId in state.config.tactics.formations)) return fail('UNKNOWN_FORMATION');
      return accept(state, cmd, log, payload, { formationId: payload.formationId });

    case 'SWITCH_TACTIC_PLAN': {
      if (team.tacticalPlans === null) return fail('NO_TACTIC_PLANS');
      if (payload.plan !== 'A' && payload.plan !== 'B') return fail('UNKNOWN_PLAN');
      if (payload.plan === team.activePlan) return fail('ALREADY_ACTIVE_PLAN');
      for (let i = state.pendingCommands.length - 1; i >= 0; i--) {
        const c = state.pendingCommands[i];
        if (c.teamIndex === cmd.teamIndex && (c.type === 'SWITCH_TACTIC_PLAN' || c.type === 'SET_INSTRUCTIONS')) {
          state.pendingCommands.splice(i, 1);
        }
      }
      return accept(state, cmd, log, { plan: payload.plan }, { plan: payload.plan });
    }

    case 'CANCEL_TACTIC_PLAN': {
      const idx = state.pendingCommands.findIndex((c) => c.type === 'SWITCH_TACTIC_PLAN' && c.teamIndex === cmd.teamIndex);
      if (idx < 0) return fail('NO_PENDING_PLAN_SWITCH');
      const switchSeq = state.pendingCommands[idx].seq;
      state.pendingCommands.splice(idx, 1);
      for (let i = state.pendingCommands.length - 1; i >= 0; i--) {
        const c = state.pendingCommands[i];
        if (c.type === 'SET_INSTRUCTIONS' && c.teamIndex === cmd.teamIndex && c.seq > switchSeq) {
          state.pendingCommands.splice(i, 1);
        }
      }
      return accept(state, cmd, log, {});
    }

    case 'SET_INSTRUCTIONS': {
      // Team instructions: queued like the others, but carried out only at the next stoppage (or at once when
      // the ball is already dead). A newer change replaces one still waiting.
      const cfg = state.config.tactics.instructions;
      const code = validateInstructions(cfg, payload.instructions);
      if (code !== null) return fail(code);
      const instructions = normalizeInstructions(cfg, payload.instructions);
      for (let i = state.pendingCommands.length - 1; i >= 0; i--) {
        const c = state.pendingCommands[i];
        if (c.type === 'SET_INSTRUCTIONS' && c.teamIndex === cmd.teamIndex) state.pendingCommands.splice(i, 1);
      }
      return accept(state, cmd, log, { instructions }, { instructions });
    }

    case 'ISSUE_SHOUT': {
      // A touchline shout (tactics/Shouts.js): carried out at step 1 of the next tick (at once while the ball is
      // dead); its random draws happen there, so a replay of the log draws the same.
      const code = shoutRefusal(state, cmd.teamIndex, payload.shout);
      if (code !== null) return fail(code);
      return accept(state, cmd, log, { shout: payload.shout }, { shout: payload.shout });
    }

    case 'SUBSTITUTE': {
      const { outIndex, inIndex } = payload;
      if (substitutionsLeft(state, team) <= 0) return fail('NO_SUBS_LEFT');
      if (substitutionWindowsExhausted(state, team)) return fail('NO_WINDOWS_LEFT');
      if (!own(outIndex) || state.players[outIndex].onPitch !== 1) return fail('PLAYER_NOT_ON_PITCH');
      if (!own(inIndex) || state.players[inIndex].onPitch !== 0 || state.players[inIndex].out !== 0) return fail('PLAYER_NOT_ON_BENCH');
      if (state.players[outIndex].card === 2 || state.players[inIndex].card === 2) return fail('SENT_OFF_PLAYER');
      if (state.pendingSubs.some((s) => s.outIndex === outIndex || s.inIndex === inIndex || s.outIndex === inIndex || s.inIndex === outIndex)) return fail('ALREADY_PENDING');
      const result = accept(state, cmd, log, payload);
      state.pendingSubs.push({ seq: result.seq, teamIndex: cmd.teamIndex, outIndex, inIndex });
      return result;
    }

    case 'CANCEL_SUBSTITUTION': {
      const at = state.pendingSubs.findIndex((s) => s.seq === payload.seq && s.teamIndex === cmd.teamIndex);
      if (at < 0) return fail('UNKNOWN_SEQ');
      state.pendingSubs.splice(at, 1);
      return accept(state, cmd, log, payload);
    }

    case 'SWAP_POSITIONS': {
      const { playerA, playerB } = payload;
      if (!own(playerA) || state.players[playerA].onPitch !== 1) return fail('PLAYER_NOT_ON_PITCH');
      if (!own(playerB) || state.players[playerB].onPitch !== 1) return fail('PLAYER_NOT_ON_PITCH');
      if (playerA === playerB) return fail('SAME_PLAYER');
      return accept(state, cmd, log, payload, { playerA, playerB });
    }

    case 'RESOLVE_FORCED': {
      if (!team.forcedDecision) return fail('NOT_AWAITING_DECISION');
      const inIndex = payload.inIndex ?? null;
      const outIndex = payload.outIndex ?? null;
      if (inIndex !== null && (!own(inIndex) || !benchOf(state, cmd.teamIndex).includes(inIndex))) {
        return fail(own(inIndex) && state.players[inIndex].card === 2 ? 'SENT_OFF_PLAYER' : 'PLAYER_NOT_ON_BENCH');
      }
      if (outIndex !== null && (!own(outIndex) || state.players[outIndex].onPitch !== 1)) return fail('PLAYER_NOT_ON_PITCH');
      if (team.forcedKind === 2 && inIndex !== null && outIndex === null) return fail('OUT_REQUIRED');
      const result = accept(state, cmd, log, payload, { inIndex, outIndex, kind: team.forcedKind, player: team.forcedPlayer });
      team.forcedDecision = false;
      team.forcedKind = 0;
      team.forcedPlayer = -1;
      state.awaitingDecision = state.teams[0].forcedDecision || state.teams[1].forcedDecision;
      return result;
    }
    default:
      return fail('UNKNOWN_TYPE');
  }
}

/**
 * Whether the ball is stopped: any dead ball (foul / free kick, offside, throw-in,
 * goal kick, corner, penalty, kick-off, injury drop ball), half-time, or a
 * forced-decision pause. Queued substitutions are made at every stoppage.
 * @param {import('../state/MatchState.js').MatchState} state
 * @returns {boolean}
 */
export function isStoppage(state) {
  const r = state.restart.state;
  return r === 'DEAD_BALL' || r === 'HALF_TIME' || state.awaitingDecision;
}

/**
 * Applies every queued command and substitution right now. Called by
 * `MatchEngine.applyCommand` when a command arrives while the ball is stopped,
 * so a confirmed substitution happens at once instead of waiting for a tick.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function executeAtStoppage(state) {
  flushPendingCommands(state, true);
  applyQueuedSubstitutions(state);
  flushPostSubTactics(state, true);
}

/**
 * Tick step 1: applies the commands issued since the last tick, in order, and
 * makes queued substitutions if the match is at a dead ball.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function applyPendingCommands(state) {
  flushPendingCommands(state, isStoppage(state));
  if (state.restart.state === 'DEAD_BALL' && state.restart.announced) applyQueuedSubstitutions(state);
  flushPostSubTactics(state, false);
}

/**
 * Applies queued formation, swap, shout, forced-decision, and standalone instruction commands in order.
 * `SWITCH_TACTIC_PLAN` (and any `SET_INSTRUCTIONS` for a team that has a pending `SWITCH_TACTIC_PLAN`)
 * are deferred to `flushPostSubTactics` so substitutions enter the pitch before Hungarian remapping runs.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {boolean} stopped
 */
function flushPendingCommands(state, stopped) {
  if (state.pendingCommands.length > 0) {
    const hasPendingPlan = [false, false];
    for (const cmd of state.pendingCommands) {
      if (cmd.type === 'SWITCH_TACTIC_PLAN') hasPendingPlan[cmd.teamIndex] = true;
    }
    let kept = 0;
    for (const cmd of state.pendingCommands) {
      const team = state.teams[cmd.teamIndex];
      if (cmd.type === 'SWITCH_TACTIC_PLAN') {
        state.pendingCommands[kept++] = cmd;
      } else if (cmd.type === 'SET_INSTRUCTIONS') {
        if (hasPendingPlan[cmd.teamIndex] || !stopped) state.pendingCommands[kept++] = cmd;
        else setInstructions(state.config.tactics.instructions, team, cmd.payload.instructions);
      } else if (cmd.type === 'ISSUE_SHOUT') {
        issueShout(state, cmd.teamIndex, cmd.payload.shout);
      } else if (cmd.type === 'SET_FORMATION') {
        team.formationId = cmd.payload.formationId;
        team.reduced = false;
        setFormation(state, team, team.formationId);
        let onPitch = 0;
        for (let i = cmd.teamIndex * 18; i < (cmd.teamIndex + 1) * 18; i++) if (state.players[i].onPitch === 1) onPitch++;
        if (onPitch < 11) reduce(state, team);
        state.emit('FORMATION_CHANGE', { teamIndex: cmd.teamIndex, meta: { formationId: team.formationId } });
      } else if (cmd.type === 'SWAP_POSITIONS') {
        swapPlayerPositions(state, cmd.payload.playerA, cmd.payload.playerB);
      } else if (cmd.type === 'RESOLVE_FORCED') {
        const { inIndex, outIndex, kind, player } = cmd.payload;
        if (kind === 1) {
          const out = outIndex ?? player;
          if (inIndex === null) {
            leavePitch(state, out);
            reduce(state, team);
          } else {
            performSubstitution(state, cmd.teamIndex, out, inIndex);
            setFormation(state, team, team.formationId);
          }
        } else if (inIndex === null) {
          standInKeeper(state, team);
          reduce(state, team);
        } else {
          performSubstitution(state, cmd.teamIndex, outIndex, inIndex);
          setFormation(state, team, team.formationId);
        }
      }
    }
    state.pendingCommands.length = kept;
  }
}

/**
 * Pass 3: flushes queued `SWITCH_TACTIC_PLAN` (and any `SET_INSTRUCTIONS` stacked after it) once
 * substitutions have been applied and no forced decision is pending.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {boolean} atStoppage true when called from `executeAtStoppage` (after `applyQueuedSubstitutions`)
 */
function flushPostSubTactics(state, atStoppage) {
  if (state.pendingCommands.length === 0 || state.awaitingDecision) return;
  const ready = atStoppage || state.restart.state === 'HALF_TIME' || (state.restart.state === 'DEAD_BALL' && state.restart.announced);
  if (!ready) return;
  let kept = 0;
  for (const cmd of state.pendingCommands) {
    if (cmd.type !== 'SWITCH_TACTIC_PLAN' && cmd.type !== 'SET_INSTRUCTIONS') {
      state.pendingCommands[kept++] = cmd;
      continue;
    }
    if (!atStoppage && state.pendingSubs.some((s) => s.teamIndex === cmd.teamIndex)) {
      state.pendingCommands[kept++] = cmd;
      continue;
    }
    const team = state.teams[cmd.teamIndex];
    if (cmd.type === 'SWITCH_TACTIC_PLAN' && team.tacticalPlans !== null) {
      const plan = /** @type {'A' | 'B'} */ (cmd.payload.plan);
      const slot = plan === 'B' ? team.tacticalPlans.planB : team.tacticalPlans.planA;
      team.activePlan = plan;
      team.reduced = false;
      setFormation(state, team, slot.formationId);
      let onPitch = 0;
      for (let i = cmd.teamIndex * 18; i < (cmd.teamIndex + 1) * 18; i++) if (state.players[i].onPitch === 1) onPitch++;
      if (onPitch < 11) reduce(state, team);
      setInstructions(state.config.tactics.instructions, team, slot.instructions);
      state.emit('FORMATION_CHANGE', {
        teamIndex: cmd.teamIndex,
        meta: { formationId: team.formationId, baseFormationId: slot.formationId, plan, tacticId: slot.tacticId },
      });
    } else if (cmd.type === 'SET_INSTRUCTIONS') {
      setInstructions(state.config.tactics.instructions, team, cmd.payload.instructions);
    } else {
      state.pendingCommands[kept++] = cmd;
    }
  }
  state.pendingCommands.length = kept;
}

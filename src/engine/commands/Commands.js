/**
 * Commands (design §12, item 48). One entry point validates in the §12 order,
 * assigns `seq`, stamps `tick` (the last completed tick), queues the command to
 * take effect at step 1 of the next tick, and logs it. Only human entries are
 * re-applied by `MatchEngine.replay`; the AI coach re-derives its own.
 */
import { setFormation, reduce, swapPlayerPositions } from '../tactics/Formation.js';
import { performSubstitution, applyQueuedSubstitutions } from '../restarts/RestartMachine.js';
import { benchOf, leavePitch, standInKeeper, substitutionsLeft } from './Forced.js';

export const COMMAND_TYPES = Object.freeze(['SUBSTITUTE', 'SET_FORMATION', 'CANCEL_SUBSTITUTION', 'RESOLVE_FORCED', 'SWAP_POSITIONS']);

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
      if (!(payload.formationId in state.config.tactics.formations)) return fail('UNKNOWN_FORMATION');
      return accept(state, cmd, log, payload, { formationId: payload.formationId });

    case 'SUBSTITUTE': {
      const { outIndex, inIndex } = payload;
      if (substitutionsLeft(state, team) <= 0) return fail('NO_SUBS_LEFT');
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
 * Tick step 1: applies the commands issued since the last tick, in order, and
 * makes queued substitutions if the match is at a dead ball.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function applyPendingCommands(state) {
  if (state.pendingCommands.length > 0) {
    for (const cmd of state.pendingCommands) {
      const team = state.teams[cmd.teamIndex];
      if (cmd.type === 'SET_FORMATION') {
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
    state.pendingCommands.length = 0;
  }
  if (state.restart.state === 'DEAD_BALL' && state.restart.announced) applyQueuedSubstitutions(state);
}

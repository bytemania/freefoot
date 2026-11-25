/**
 * What the manager has submitted and the match has not yet carried out, and whether a forced
 * injury replacement is waiting on the manager. Read-only views of the engine state used by the
 * controller and the Manager panel: a confirmed batch locks further staging until it is applied,
 * and a HIGH injury to the human team makes the panel a mandatory replacement dialog.
 */

/**
 * A confirmed change still waiting to be carried out: a substitution (made at the next stoppage)
 * or a formation change / position swap (applied on the next tick).
 * @typedef {{kind: 'SUB', seq: number, outIndex: number, inIndex: number}
 *   | {kind: 'FORMATION', formationId: string}
 *   | {kind: 'SWAP', playerA: number, playerB: number}} PendingItem
 */

/**
 * @param {any} state the engine `MatchState`
 * @param {number} teamIndex
 * @returns {PendingItem[]} the team's submitted changes not yet carried out, formation and swaps first
 */
export function pendingSubmission(state, teamIndex) {
  /** @type {PendingItem[]} */
  const items = [];
  for (const c of state.pendingCommands ?? []) {
    if (c.teamIndex !== teamIndex) continue;
    if (c.type === 'SET_FORMATION') items.push({ kind: 'FORMATION', formationId: c.payload.formationId });
    else if (c.type === 'SWAP_POSITIONS') items.push({ kind: 'SWAP', playerA: c.payload.playerA, playerB: c.payload.playerB });
  }
  for (const s of state.pendingSubs ?? []) {
    if (s.teamIndex === teamIndex) items.push({ kind: 'SUB', seq: s.seq, outIndex: s.outIndex, inIndex: s.inIndex });
  }
  return items;
}

/**
 * Whether the team has a confirmed batch still waiting for the match (the next dead ball for a
 * substitution): while it does, the Manager panel does not stage or confirm anything new.
 * @param {any} state
 * @param {number} teamIndex
 */
export function hasPendingSubmission(state, teamIndex) {
  return pendingSubmission(state, teamIndex).length > 0;
}

/**
 * The injured player the team must replace before play can go on, or -1. The engine raises this
 * forced decision only when a replacement is possible (a substitution and a window left, a bench
 * player available); otherwise the player just goes off and the team plays on with ten.
 * @param {any} state
 * @param {number} teamIndex
 */
export function mandatoryReplacement(state, teamIndex) {
  const team = state.teams[teamIndex];
  return team.forcedDecision && team.forcedKind === 1 ? team.forcedPlayer : -1;
}

/**
 * Whether the Manager panel may be closed: not while the team owes the referee a forced decision
 * (an injured player to replace, or a sent-off goalkeeper).
 * @param {any} state
 * @param {number} teamIndex
 */
export function canDismissManager(state, teamIndex) {
  return !state.teams[teamIndex].forcedDecision;
}

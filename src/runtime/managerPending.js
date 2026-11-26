/**
 * What the manager has submitted and the match has not yet carried out, and whether a forced
 * injury replacement is waiting on the manager. Read-only views of the engine state used by the
 * controller and the Manager panel: a confirmed batch locks further staging until it is applied,
 * and a HIGH injury to the human team makes the panel a mandatory replacement dialog.
 */

/**
 * A confirmed change still waiting to be carried out: a substitution or new team instructions (both at the
 * next stoppage), or a formation change / position swap (applied on the next tick).
 * @typedef {{kind: 'SUB', seq: number, outIndex: number, inIndex: number}
 *   | {kind: 'FORMATION', formationId: string}
 *   | {kind: 'SWAP', playerA: number, playerB: number}
 *   | {kind: 'INSTRUCTIONS', seq: number, instructions: Record<string, string>}
 *   | {kind: 'PLAN_SWITCH', seq: number, plan: 'A' | 'B'}} PendingItem
 */

/**
 * @param {any} state the engine `MatchState`
 * @param {number} teamIndex
 * @returns {PendingItem[]} the team's submitted changes not yet carried out: formation and swaps first, then plan
 *   switch and team instructions, then substitutions
 */
export function pendingSubmission(state, teamIndex) {
  /** @type {PendingItem[]} */
  const items = [];
  for (const c of state.pendingCommands ?? []) {
    if (c.teamIndex !== teamIndex) continue;
    if (c.type === 'SET_FORMATION') items.push({ kind: 'FORMATION', formationId: c.payload.formationId });
    else if (c.type === 'SWAP_POSITIONS') items.push({ kind: 'SWAP', playerA: c.payload.playerA, playerB: c.payload.playerB });
  }
  const plan = pendingPlanSwitch(state, teamIndex);
  if (plan !== null) items.push({ kind: 'PLAN_SWITCH', seq: plan.seq, plan: plan.plan });
  const instr = pendingInstructions(state, teamIndex);
  if (instr !== null) items.push({ kind: 'INSTRUCTIONS', seq: instr.seq, instructions: instr.instructions });
  for (const s of state.pendingSubs ?? []) {
    if (s.teamIndex === teamIndex) items.push({ kind: 'SUB', seq: s.seq, outIndex: s.outIndex, inIndex: s.inIndex });
  }
  return items;
}

/**
 * The team's queued Plan A/B switch still waiting for a stoppage, or null.
 * @param {any} state
 * @param {number} teamIndex
 * @returns {null | {seq: number, plan: 'A' | 'B'}}
 */
export function pendingPlanSwitch(state, teamIndex) {
  const c = (state.pendingCommands ?? []).find((/** @type {any} */ x) => x.type === 'SWITCH_TACTIC_PLAN' && x.teamIndex === teamIndex);
  return c ? { seq: c.seq, plan: c.payload.plan } : null;
}

/**
 * The formation ID that will be in effect after a queued `SWITCH_TACTIC_PLAN` or `SET_FORMATION`,
 * resolving through `reducedTo` / `emergencyShape` when 10 or 9 players are on the pitch, or `null`
 * if no formation-changing command is pending.
 * @param {any} state
 * @param {number} teamIndex
 * @returns {string | null}
 */
export function pendingTargetFormation(state, teamIndex) {
  const team = state.teams?.[teamIndex];
  if (!team) return null;
  let baseId = null;
  const plan = pendingPlanSwitch(state, teamIndex);
  if (plan !== null && team.tacticalPlans) {
    baseId = (plan.plan === 'B' ? team.tacticalPlans.planB : team.tacticalPlans.planA).formationId;
  } else {
    const formCmd = (state.pendingCommands ?? []).find((/** @type {any} */ x) => x.type === 'SET_FORMATION' && x.teamIndex === teamIndex);
    if (formCmd) baseId = formCmd.payload.formationId;
  }
  if (!baseId) return null;
  let onPitch = 0;
  for (let i = teamIndex * 18; i < (teamIndex + 1) * 18; i++) {
    if (state.players?.[i]?.onPitch === 1) onPitch++;
  }
  const key = onPitch === 10 ? 'ten' : onPitch === 9 ? 'nine' : null;
  if (key === null) return baseId;
  const tactics = state.config?.tactics;
  return tactics?.formations?.[baseId]?.reducedTo?.[key] ?? tactics?.emergencyShape?.[key] ?? baseId;
}

/**
 * The team's confirmed instructions still waiting for a stoppage (the newest replaces any older one), or null.
 * @param {any} state
 * @param {number} teamIndex
 * @returns {null | {seq: number, instructions: Record<string, string>}}
 */
export function pendingInstructions(state, teamIndex) {
  const c = (state.pendingCommands ?? []).find((/** @type {any} */ x) => x.type === 'SET_INSTRUCTIONS' && x.teamIndex === teamIndex);
  return c ? { seq: c.seq, instructions: { ...c.payload.instructions } } : null;
}

/**
 * Whether the team has a confirmed Manager batch (formation, swaps, substitutions) still waiting for the
 * match (the next dead ball for a substitution): while it does, the Manager panel does not stage or confirm
 * anything new. Pending team instructions and plan switches are listed but do not lock the Manager.
 * @param {any} state
 * @param {number} teamIndex
 */
export function hasPendingSubmission(state, teamIndex) {
  return pendingSubmission(state, teamIndex).some((it) => it.kind !== 'INSTRUCTIONS' && it.kind !== 'PLAN_SWITCH');
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

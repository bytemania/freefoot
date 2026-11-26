/**
 * Development-only hooks for end-to-end tests (loaded by main.js under `import.meta.env.DEV`, so the
 * production build leaves this module out). They reach into the live match the way the engine itself
 * would, to set up situations a test cannot wait for, such as a HIGH injury to the human team or
 * fast-advancing to FULL_TIME.
 */
import { raiseForced } from '../engine/commands/Forced.js';
import { startRestart } from '../engine/restarts/RestartMachine.js';
import { deriveEffectiveFamiliarity } from '../engine/tactics/Familiarity.js';
import { pendingPlanSwitch } from '../runtime/managerPending.js';

/**
 * Installs `window.__freefootDev` for the current match.
 * @param {import('../runtime/MatchController.js').MatchController} ctrl
 * @returns {() => void} uninstall
 */
export function installDevHooks(ctrl) {
  const hooks = {
    /**
     * Gives home player `playerIndex` a HIGH injury in play: the ball goes dead and the forced
     * decision is raised (the Manager panel then opens in mandatory replacement mode).
     * @param {number} playerIndex
     */
    injure(playerIndex) {
      // Paused first, then one engine tick: the decision lands at once, even mid pre-roll or animation hold.
      ctrl.pause();
      const s = ctrl.engine.state;
      const p = s.players[playerIndex];
      p.injury = 3;
      if (s.restart.state === 'IN_PLAY') startRestart(s, 'DROP_BALL', 1 - p.team, s.ball.x, s.ball.y, { holdSeconds: 3 });
      raiseForced(s, s.teams[p.team], 1, playerIndex);
      ctrl.stepTicks(1);
      return { playbackState: ctrl.playbackState, forcedPlayer: ctrl.mandatoryReplacement(p.team) };
    },
    /**
     * Opens a VAR review of a home defender's box challenge on the away striker that VAR overturns into a
     * penalty: play stops, VAR_CHECK comes on the next tick and VAR_DECISION `reviewTicks` later.
     * @returns {boolean} whether the match has VAR
     */
    varCheck() {
      const s = ctrl.engine.state;
      if (s.var === null) return false;
      const fouler = s.players.findIndex((p) => p.team === 0 && p.onPitch === 1 && p.isKeeper === 0);
      const fouled = s.players.findIndex((p) => p.team === 1 && p.onPitch === 1 && p.isKeeper === 0);
      const x = s.attackDir(0) > 0 ? 8 : 97;
      if (s.restart.state === 'IN_PLAY') startRestart(s, 'DROP_BALL', 0, x, 30);
      const checkTick = s.tick + 1;
      s.var.review = {
        incident: 'POSSIBLE_PENALTY', team: 0, subject: fouler, other: fouled, x, y: 30, fx: x, fy: 30, direct: true,
        overturnP: 1, checkTick, checked: false, decideTick: checkTick + s.config.var.reviewTicks,
      };
      return true;
    },
    /**
     * Inspects tactical plan, active formation, pending plan switch, effective familiarity, and knobs.
     * @param {number} [teamIndex]
     */
    tacticalState(teamIndex = 0) {
      const s = ctrl.engine.state;
      const team = s.teams[teamIndex];
      const plan = pendingPlanSwitch(s, teamIndex);
      let familiarity = null;
      if (team.tacticalPlans) {
        const slot = team.activePlan === 'B' ? team.tacticalPlans.planB : team.tacticalPlans.planA;
        familiarity = deriveEffectiveFamiliarity(s.config?.tactics?.instructions, slot, team.instructions);
      }
      const baseFormationId = team.tacticalPlans
        ? (team.activePlan === 'B' ? team.tacticalPlans.planB : team.tacticalPlans.planA).formationId
        : team.formationId;
      return {
        activePlan: team.activePlan,
        formationId: team.formationId,
        baseFormationId,
        pendingPlan: plan ? plan.plan : null,
        familiarity,
        knobs: { ...team.familiarityKnobs },
      };
    },
    /**
     * Deterministically steps the current match through HALF_TIME (and any PAUSED_FORCED decisions)
     * straight to FULL_TIME so E2E tests can reach PostMatchReportView without waiting minutes.
     */
    finishMatch() {
      ctrl.pause();
      for (let guard = 0; guard < 5000 && ctrl.playbackState !== 'FULL_TIME'; guard++) {
        if (ctrl.playbackState === 'HALF_TIME') {
          ctrl.continue();
          ctrl.pause();
          continue;
        }
        if (ctrl.playbackState === 'PAUSED_FORCED') {
          const s = ctrl.engine.state;
          for (let t = 0; t < 2; t++) {
            const team = s.teams[t];
            if (!team.forcedDecision) continue;
            let inIndex = null;
            if (team.forcedKind === 1) {
              const base = t * 18;
              for (let i = base; i < base + 18; i++) {
                const p = s.players[i];
                if (p.onPitch === 0 && p.out === 0 && p.card !== 2) {
                  inIndex = i;
                  break;
                }
              }
            }
            ctrl.queueCommand({ issuer: 'human', type: 'RESOLVE_FORCED', teamIndex: t, payload: { inIndex, outIndex: null } });
          }
          continue;
        }
        ctrl.stepTicks(1000);
      }
      return {
        playbackState: ctrl.playbackState,
        score: { home: ctrl.engine.state.teams[0].score, away: ctrl.engine.state.teams[1].score },
      };
    },
    /** @returns {string} */
    playbackState: () => ctrl.playbackState,
    /** @returns {number} the match seed (`?seed=` or random) */
    seed: () => ctrl.input.seed,
  };
  /** @type {any} */ (window).__freefootDev = hooks;
  return () => {
    delete (/** @type {any} */ (window).__freefootDev);
  };
}

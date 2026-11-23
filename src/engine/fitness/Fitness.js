/**
 * Fitness (design §6, §9a, item 47): the only owner of fitness drain and
 * recovery, at tick step 7. Drain per second is
 * `c[band] x (1.5 - stamina / 20) x (0.8 + workRate / 50) x ageDrain`, by speed
 * band (walk < 2, jog < 5, run < 7 (the sprint threshold), sprint). Recovery is
 * `rec x ageRecovery` per second while walking and during dead balls, when
 * nobody drains.
 *
 * Age (weights.yaml `fitness.age`): players up to `peakMax` (27) drain at 1.0x;
 * each year past it adds `perYear` (capped at `maxExtra`, so about +12% at 31
 * and +25% from 35-36), and a lower Stamina attribute compounds that extra by
 * up to `staminaComp`. Older players also recover a little slower
 * (`recoveryShare` of the extra).
 */
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';

/** Age used when a player's input has none. */
export const DEFAULT_AGE = 25;

/**
 * Age multipliers for a player (pure; computed once per player at match start).
 * @param {number | undefined} age years
 * @param {number} stamina raw Stamina attribute 1-20
 * @param {{default?: number, peakMax: number, perYear: number, maxExtra: number, staminaComp: number, recoveryShare: number} | undefined} cfg
 *   unwrapped `weights.fitness.age`
 * @returns {{drain: number, recovery: number}}
 */
export function ageFactors(age, stamina, cfg) {
  if (!cfg) return { drain: 1, recovery: 1 };
  const years = typeof age === 'number' && Number.isFinite(age) ? age : (cfg.default ?? DEFAULT_AGE);
  const past = years - cfg.peakMax;
  if (past <= 0) return { drain: 1, recovery: 1 };
  let extra = past * cfg.perYear;
  if (extra > cfg.maxExtra) extra = cfg.maxExtra;
  const s = stamina < 1 ? 1 : stamina > 20 ? 20 : stamina;
  extra *= 1 + (cfg.staminaComp * (20 - s)) / 19;
  return { drain: 1 + extra, recovery: 1 / (1 + cfg.recoveryShare * extra) };
}

/**
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function updateFitness(state) {
  const k = state.k;
  const m = k.weights.movement;
  const f = k.weights.fitness;
  const deadBall = state.restart.state === 'DEAD_BALL';
  const list = state.onPitchList;
  for (let n = 0; n < list.length; n++) {
    const p = state.players[list[n]];
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    let v = p.fitness;
    const rec = f.rec * p.ageRecovery;
    if (deadBall) {
      v += rec;
    } else {
      const cost = speed < m.walkMax ? f.c.walk : speed < m.jogMax ? f.c.jog : speed < m.sprintThreshold ? f.c.run : f.c.sprint;
      const stamina = getEffectiveAttribute(p, 'stamina', k);
      const workRate = getEffectiveAttribute(p, 'workRate', k);
      v -= cost * (f.staminaBase - stamina / f.staminaDiv) * (f.workBase + workRate / f.workDiv) * p.ageDrain;
      if (speed < m.walkMax) v += rec;
    }
    p.fitness = v < 0 ? 0 : v > 1 ? 1 : v;
  }
}

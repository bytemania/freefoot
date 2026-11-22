/**
 * Fitness (design §6, §9a, item 47): the only owner of fitness drain and
 * recovery, at tick step 7. Drain per second is
 * `c[band] x (1.5 - stamina / 20) x (0.8 + workRate / 50)`, by speed band
 * (walk < 2, jog < 5, run < 7 (the sprint threshold), sprint). Recovery is
 * `rec` per second while walking and during dead balls, when nobody drains.
 */
import { getEffectiveAttribute } from '../state/PlayerMatchState.js';

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
    if (deadBall) {
      v += f.rec;
    } else {
      const cost = speed < m.walkMax ? f.c.walk : speed < m.jogMax ? f.c.jog : speed < m.sprintThreshold ? f.c.run : f.c.sprint;
      const stamina = getEffectiveAttribute(p, 'stamina', k);
      const workRate = getEffectiveAttribute(p, 'workRate', k);
      v -= cost * (f.staminaBase - stamina / f.staminaDiv) * (f.workBase + workRate / f.workDiv);
      if (speed < m.walkMax) v += f.rec;
    }
    p.fitness = v < 0 ? 0 : v > 1 ? 1 : v;
  }
}

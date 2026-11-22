/**
 * Injuries (design §9a, §9b, §11, item 47): rolls on contact events and on
 * high fatigue, with the engine RNG. LIGHT and MEDIUM apply attribute
 * multipliers; HIGH stops play and raises a forced decision (or the player
 * simply leaves when the team has no substitute).
 */
import { nextFloat } from '../rng/sfc32.js';
import { getEffectiveAttribute, INJURY_LEVELS } from '../state/PlayerMatchState.js';
import { n } from '../resolve/passing.js';
import { raiseForced } from '../commands/Forced.js';
import { startRestart } from '../restarts/RestartMachine.js';

/**
 * Rolls the per-contact injury for the player who took the contact:
 * pInj = i0 (1 + i1 (1 - fitness)) (1 + i2 n(opponent.aggression)).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} victim
 * @param {number} other the opponent in the contact
 */
export function rollContactInjury(state, victim, other) {
  const p = state.players[victim];
  const i = state.k.injuries.perContact;
  const aggression = getEffectiveAttribute(state.players[other], 'aggression', state.k);
  const pInj = i.i0 * (1 + i.i1 * (1 - p.fitness)) * (1 + i.i2 * n(aggression));
  if (nextFloat(state.rng) < pInj) applyInjury(state, victim);
}

/**
 * Tick step 7: each tick with fitness below 0.3, roll pFat = j0 (0.3 - fitness) (j0 is per tick).
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function updateInjuries(state) {
  const j0 = state.k.injuries.fatigue.j0;
  const list = state.onPitchList;
  for (let n2 = 0; n2 < list.length; n2++) {
    const p = state.players[list[n2]];
    if (p.fitness >= 0.3) continue;
    if (nextFloat(state.rng) < j0 * (0.3 - p.fitness)) applyInjury(state, p.index);
  }
}

/**
 * Picks the level by the split in injuries.yaml and applies it.
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {number} index
 */
function applyInjury(state, index) {
  const p = state.players[index];
  const split = state.k.injuries.levelSplit;
  const u = nextFloat(state.rng);
  const level = u < split.LIGHT ? 1 : u < split.LIGHT + split.MEDIUM ? 2 : 3;
  if (level <= p.injury) return;
  p.injury = level;
  state.emit('INJURY', { teamIndex: p.team, actorIndex: index, x: p.x, y: p.y, meta: { level: INJURY_LEVELS[level] } });
  if (level < 3) return;
  state.emit('INJURY_STOPPAGE', { teamIndex: p.team, actorIndex: index, x: p.x, y: p.y });
  if (state.restart.state === 'IN_PLAY') {
    const b = state.ball;
    const owner = b.owner >= 0 ? state.players[b.owner].team : b.lastTouch >= 0 ? state.players[b.lastTouch].team : p.team;
    startRestart(state, 'DROP_BALL', owner, b.x, b.y, { holdSeconds: state.k.injuries.stoppageSeconds.HIGH });
  }
  raiseForced(state, state.teams[p.team], 1, index);
}

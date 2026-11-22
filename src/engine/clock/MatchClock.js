/**
 * Match clock (design §10, item 46). The clock runs during dead balls. Each
 * goal, substitution, card and injury stoppage adds configured seconds to an
 * accumulator; at 45:00 and 90:00 it is rounded up to whole minutes,
 * announced, and played.
 */
import { HALF_TICKS, DT } from '../TickConfig.js';
import { computeAddedTime } from '../officiating/Referee.js';
import { enterHalfTime, enterFullTime } from '../restarts/RestartMachine.js';

/**
 * Match seconds elapsed (the first half counts 2,700 s, the second half starts at 2,700).
 * @param {import('../state/MatchState.js').MatchState} state
 * @returns {number}
 */
export function clockSeconds(state) {
  return (state.clock.half - 1) * 2700 + state.clock.halfTick * DT;
}

/**
 * Adds stoppage seconds for one event (called from tick step 9).
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../events/MatchEvent.js').MatchEvent} event
 */
export function addStoppageFor(state, event) {
  const t = state.config.officiating.addedTime;
  switch (event.type) {
    case 'GOAL':
      state.clock.addedSeconds += t.perGoal;
      break;
    case 'SUBSTITUTION':
      state.clock.addedSeconds += t.perSubstitution;
      break;
    case 'YELLOW_CARD':
    case 'RED_CARD':
      state.clock.addedSeconds += t.perCard;
      break;
    case 'INJURY_STOPPAGE':
      state.clock.addedSeconds += t.perInjuryStoppage;
      break;
    default:
  }
}

/**
 * Advances the clock by one tick (tick step 6). Announces added time when the
 * regular 45 minutes are up, and ends the half when added time has been played.
 * @param {import('../state/MatchState.js').MatchState} state
 */
export function advanceClock(state) {
  const c = state.clock;
  c.halfTick++;
  if (!c.announced && c.halfTick >= HALF_TICKS) {
    const minutes = computeAddedTime(state);
    c.addedTicks = minutes * 60 * 20;
    c.announced = true;
    if (minutes > 0) state.emit('ADDED_TIME', { meta: { minutes } });
  }
  if (c.announced && c.halfTick >= HALF_TICKS + c.addedTicks) {
    if (c.half === 1) enterHalfTime(state);
    else enterFullTime(state);
  }
}

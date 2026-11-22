/**
 * Debug-mode state checks (design item 51). Throws with the tick and details
 * on the first failure.
 */
import { PITCH_LENGTH, PITCH_WIDTH } from '../state/MatchState.js';

const MARGIN = 5;

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../events/MatchEvent.js').MatchEvent[]} events events built this tick
 * @param {number} lastSeq `seq` of the last event before this tick (-1 for none)
 */
export function checkInvariants(state, events, lastSeq) {
  /** @param {string} what */
  const fail = (what) => {
    throw new Error(`invariant violated at tick ${state.tick}: ${what}`);
  };
  const onPitch = [0, 0];
  for (const p of state.players) {
    if (p.onPitch === 1) {
      onPitch[p.team]++;
      if (p.x < -MARGIN || p.x > PITCH_LENGTH + MARGIN || p.y < -MARGIN || p.y > PITCH_WIDTH + MARGIN) {
        fail(`player ${p.index} off the pitch at (${p.x}, ${p.y})`);
      }
    }
    if (p.card === 2 && p.onPitch === 1) fail(`sent-off player ${p.index} is on the pitch`);
  }
  if (onPitch[0] > 11 || onPitch[1] > 11) fail(`more than 11 on the pitch (${onPitch[0]}, ${onPitch[1]})`);
  const b = state.ball;
  if (b.owner !== -1 && (b.owner < 0 || b.owner >= state.players.length || state.players[b.owner].onPitch !== 1)) {
    fail(`ball owner ${b.owner} is not an on-pitch player`);
  }
  if (b.x < -MARGIN || b.x > PITCH_LENGTH + MARGIN || b.y < -MARGIN || b.y > PITCH_WIDTH + MARGIN) {
    fail(`ball off the pitch at (${b.x}, ${b.y})`);
  }
  for (const t of state.teams) {
    if (t.subsUsed + state.pendingSubs.filter((s) => s.teamIndex === t.index).length > 5) {
      fail(`team ${t.index} exceeds 5 substitutions`);
    }
  }
  let seq = lastSeq;
  for (const e of events) {
    if (e.tick !== state.tick) fail(`event ${e.seq} has tick ${e.tick}`);
    if (e.seq <= seq) fail(`event seq ${e.seq} does not increase`);
    seq = e.seq;
  }
}

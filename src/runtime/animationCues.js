/**
 * On-pitch animation cues (presentation only). The MatchController attaches
 * them to the frame on which the event happens (`frame.animations`) and the
 * pitch canvas plays them (ui/pitchAnimations.js): a GOAL celebration carries
 * the snapshot from the tick before the goal (the engine lines everyone up
 * for the kick-off on the goal tick itself), a RED_CARD exit and a
 * SUBSTITUTION carry where they happened. A coach shout (SHOUT_REACTION) lists the players who reacted and how;
 * so does a VAR overturn (VAR_DECISION): the side it favours positive, the other negative, with the same rings.
 */
import { PLAYERS_PER_TEAM } from '../engine/state/MatchState.js';
import { shoutReactions } from '../engine/tactics/Shouts.js';

/**
 * @typedef {{kind: 'GOAL', tick: number, actor: number, team: number, x: number, y: number, snapshot: Float64Array | null}} GoalCue
 * @typedef {GoalCue
 *   | {kind: 'RED_CARD', tick: number, actor: number, team: number, x: number, y: number}
 *   | {kind: 'SUBSTITUTION', tick: number, actor: number, incoming: number, team: number, x: number, y: number}
 *   | ShoutCue} AnimationCue
 * @typedef {{kind: 'SHOUT', tick: number, team: number, shout: string, reactions: {actor: number, outcome: 'positive' | 'negative'}[]}} ShoutCue
 */

/**
 * Animation cues for one tick's events.
 * @param {import('../engine/events/MatchEvent.js').MatchEvent[]} events
 * @param {Float64Array | null} preSnapshot the snapshot before this tick (for a goal)
 * @returns {AnimationCue[]}
 */
export function cuesForEvents(events, preSnapshot) {
  /** @type {AnimationCue[]} */
  const cues = [];
  for (const e of events) {
    if (e.type === 'GOAL' && e.actorIndex >= 0) {
      const own = e.meta?.kind === 'OWN_GOAL';
      const scorerTeam = Math.floor(e.actorIndex / PLAYERS_PER_TEAM);
      const team = own ? 1 - scorerTeam : scorerTeam;
      cues.push({ kind: 'GOAL', tick: e.tick, actor: own ? -1 : e.actorIndex, team, x: e.x, y: e.y, snapshot: preSnapshot ? preSnapshot.slice() : null });
    } else if (e.type === 'RED_CARD' && e.actorIndex >= 0) {
      cues.push({ kind: 'RED_CARD', tick: e.tick, actor: e.actorIndex, team: e.teamIndex, x: e.x, y: e.y });
    } else if (e.type === 'SUBSTITUTION' && e.actorIndex >= 0) {
      cues.push({ kind: 'SUBSTITUTION', tick: e.tick, actor: e.actorIndex, incoming: e.secondaryIndices[0] ?? -1, team: e.teamIndex, x: e.x, y: e.y });
    } else if (e.type === 'SHOUT_REACTION' && e.secondaryIndices.length > 0) {
      cues.push({ kind: 'SHOUT', tick: e.tick, team: e.teamIndex, shout: String(e.meta.shout), reactions: shoutReactions(e) });
    } else if (e.type === 'VAR_DECISION' && e.meta.overturned === true && e.secondaryIndices.length > 0) {
      // Same layout as a shout reaction: `meta.positive` players first, then the negative ones.
      cues.push({ kind: 'SHOUT', tick: e.tick, team: e.teamIndex, shout: 'VAR', reactions: shoutReactions(e) });
    }
  }
  return cues;
}


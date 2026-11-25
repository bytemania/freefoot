/**
 * On-pitch animation cues (presentation only). The MatchController attaches
 * them to the frame on which the event happens (`frame.animations`) and the
 * pitch canvas plays them (ui/pitchAnimations.js): a GOAL celebration carries
 * the snapshot from the tick before the goal (the engine lines everyone up
 * for the kick-off on the goal tick itself), a RED_CARD exit and a
 * SUBSTITUTION carry where they happened. A coach shout (SHOUT_REACTION) lists the players who reacted and how;
 * so does a VAR overturn (VAR_DECISION): the side it favours positive, the other negative, with the same rings.
 */
import { PITCH_LENGTH, PITCH_WIDTH, PLAYERS_PER_TEAM } from '../engine/state/MatchState.js';
import { SNAP_BALL } from '../engine/MatchEngine.js';
import { DT } from '../engine/TickConfig.js';
import { shoutReactions } from '../engine/tactics/Shouts.js';

/**
 * @typedef {{kind: 'GOAL', tick: number, actor: number, team: number, x: number, y: number, snapshot: Float64Array | null, ball: GoalBall}} GoalCue
 * @typedef {{fromX: number, fromY: number, fromZ: number, lineX: number, lineY: number, lineZ: number, speed: number}} GoalBall
 *   the goal's ball flight: from where it was struck (or where it was the tick before it crossed the line) to the
 *   point it crossed the goal line, at `speed` m/s. The engine resolves a shot at the strike (the ball never travels
 *   on the engine's pitch), so the celebration draws this flight into the net instead.
 * @typedef {GoalCue
 *   | {kind: 'RED_CARD', tick: number, actor: number, team: number, x: number, y: number}
 *   | {kind: 'SUBSTITUTION', tick: number, actor: number, incoming: number, team: number, x: number, y: number}
 *   | ShoutCue} AnimationCue
 * @typedef {{kind: 'SHOUT', tick: number, team: number, shout: string, reactions: {actor: number, outcome: 'positive' | 'negative'}[]}} ShoutCue
 */

/** Shot speed (m/s) assumed when the events do not carry one. */
const DEFAULT_SHOT_SPEED = 22;

/**
 * The ball flight of a goal (see `GoalBall`). A shot on target the same tick gives the line point (`goalY` across the
 * goal mouth, `goalZ` high) and the speed; a ball that rolled or bounced over the line (an own goal, a deflection)
 * crosses where the GOAL event is, at the speed it had the tick before.
 * @param {import('../engine/events/MatchEvent.js').MatchEvent} goal
 * @param {import('../engine/events/MatchEvent.js').MatchEvent[]} events
 * @param {Float64Array | null} pre
 * @returns {GoalBall}
 */
function goalBall(goal, events, pre) {
  const shot = events.find((e) => e.type === 'SHOT' && e.actorIndex === goal.actorIndex && e.meta?.result === 'ON_TARGET');
  const bx = pre ? pre[SNAP_BALL + 2] : goal.x;
  const by = pre ? pre[SNAP_BALL + 3] : goal.y;
  const bz = pre ? pre[SNAP_BALL + 4] : 0;
  if (shot) {
    const lineX = shot.x > PITCH_LENGTH / 2 ? PITCH_LENGTH : 0;
    const v = Number(shot.meta.vShot);
    return {
      fromX: bx,
      fromY: by,
      fromZ: bz,
      lineX,
      lineY: PITCH_WIDTH / 2 + Number(shot.meta.goalY ?? 0),
      lineZ: Math.max(0, Number(shot.meta.goalZ ?? 0)),
      speed: v > 1 ? v : DEFAULT_SHOT_SPEED,
    };
  }
  const lineX = goal.x > PITCH_LENGTH / 2 ? PITCH_LENGTH : 0;
  const v = pre ? Math.hypot(pre[SNAP_BALL + 2] - pre[SNAP_BALL], pre[SNAP_BALL + 3] - pre[SNAP_BALL + 1]) / DT : 0;
  return {
    fromX: bx,
    fromY: by,
    fromZ: bz,
    lineX,
    lineY: goal.y,
    lineZ: Math.max(0, Number(goal.meta?.z ?? 0)),
    speed: v > 1 ? v : DEFAULT_SHOT_SPEED,
  };
}

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
      cues.push({ kind: 'GOAL', tick: e.tick, actor: own ? -1 : e.actorIndex, team, x: e.x, y: e.y, snapshot: preSnapshot ? preSnapshot.slice() : null, ball: goalBall(e, events, preSnapshot) });
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


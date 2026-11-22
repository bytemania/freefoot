/**
 * MatchResult contract (design §12, item 29).
 */

/**
 * @typedef {object} MatchResult
 * @property {1} v
 * @property {string} engineVersion
 * @property {string} configHash
 * @property {number} seed
 * @property {{home: number, away: number}} score
 * @property {import('../events/MatchEvent.js').MatchEvent[]} events
 * @property {Record<string, any>} stats
 * @property {{index: number, id: string, minutes: number, distanceKm: number, fitness: number, card: number, injury: number, goals: number, assists: number}[]} players
 * @property {string[]} suspensions ids of players sent off
 * @property {number} finalStateHash
 */

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../events/MatchEvent.js').MatchEvent[]} events
 * @param {string} engineVersion
 * @returns {MatchResult}
 */
export function buildMatchResult(state, events, engineVersion) {
  return {
    v: 1,
    engineVersion,
    configHash: state.configHash,
    seed: state.seed,
    score: { home: state.teams[0].score, away: state.teams[1].score },
    events,
    stats: state.stats.toJSON(state),
    players: state.players.map((p) => ({
      index: p.index,
      id: p.cold.id,
      minutes: p.ticksOnPitch / 1200,
      distanceKm: p.distance / 1000,
      fitness: p.fitness,
      card: p.card,
      injury: p.injury,
      goals: state.stats.playerGoals[p.index],
      assists: state.stats.playerAssists[p.index],
    })),
    suspensions: state.players.filter((p) => p.card === 2).map((p) => p.cold.id),
    finalStateHash: state.hash(),
  };
}

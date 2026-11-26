/**
 * MatchResult contract (design §12, item 29).
 */

/**
 * @typedef {object} TeamPlanUsage
 * @property {{minutes: number, modifiedMinutes: number}} A
 * @property {{minutes: number, modifiedMinutes: number}} B
 *
 * @typedef {object} MatchResult
 * @property {1} v
 * @property {string} engineVersion
 * @property {string} configHash
 * @property {number} seed
 * @property {{home: number, away: number}} score
 * @property {import('../events/MatchEvent.js').MatchEvent[]} events
 * @property {Record<string, any>} stats
 * @property {{index: number, id: string, minutes: number, distanceKm: number, fitness: number, card: number, injury: number, goals: number, assists: number, rating: number}[]} players
 * @property {string[]} suspensions ids of players sent off
 * @property {number} finalStateHash
 * @property {{home?: TeamPlanUsage, away?: TeamPlanUsage}} [planUsage]
 */

/**
 * @param {{A: number, B: number, modA: number, modB: number}} ticks
 * @returns {TeamPlanUsage}
 */
function planUsageFromTicks(ticks) {
  return {
    A: { minutes: ticks.A / 1200, modifiedMinutes: ticks.modA / 1200 },
    B: { minutes: ticks.B / 1200, modifiedMinutes: ticks.modB / 1200 },
  };
}

/**
 * @param {import('../state/MatchState.js').MatchState} state
 * @param {import('../events/MatchEvent.js').MatchEvent[]} events
 * @param {string} engineVersion
 * @returns {MatchResult}
 */
export function buildMatchResult(state, events, engineVersion) {
  const homeTicks = state.teams[0].planTicks;
  const awayTicks = state.teams[1].planTicks;
  /** @type {{home?: TeamPlanUsage, away?: TeamPlanUsage} | undefined} */
  const planUsage =
    homeTicks !== null || awayTicks !== null
      ? {
          ...(homeTicks !== null ? { home: planUsageFromTicks(homeTicks) } : {}),
          ...(awayTicks !== null ? { away: planUsageFromTicks(awayTicks) } : {}),
        }
      : undefined;
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
      rating: p.rating,
    })),
    suspensions: state.players.filter((p) => p.card === 2).map((p) => p.cold.id),
    finalStateHash: state.hash(),
    ...(planUsage ? { planUsage } : {}),
  };
}

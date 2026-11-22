/**
 * Metric formulas (design item 73). The one place the derived percentages and
 * soft extras are computed; `MatchStats` calls it, and `src/calibration/metrics.js`
 * re-exports it (the engine boundary forbids importing the other way).
 */

/**
 * @param {Record<string, number>} own event counters of the team
 * @param {Record<string, number>} opp event counters of the opponent
 * @param {{ticks: number, timeOnBallTicks: number, distanceM: number, sprints: number}} extras read from state
 * @returns {Record<string, number>} the counters plus every derived metric
 */
export function teamMetrics(own, opp, extras) {
  const passes = own.passes ?? 0;
  const totalPasses = passes + (opp.passes ?? 0);
  return {
    ...own,
    passCompletionPct: passes > 0 ? (100 * (own.passesCompleted ?? 0)) / passes : 0,
    possessionPct: totalPasses > 0 ? (100 * passes) / totalPasses : 0,
    timeOnBallPct: extras.ticks > 0 ? (100 * extras.timeOnBallTicks) / extras.ticks : 0,
    distanceKm: extras.distanceM / 1000,
    sprints: extras.sprints,
  };
}

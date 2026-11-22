// Metric formulas (design item 73).
// Re-exports `teamMetrics` from the engine so MatchStats and calibration share
// one implementation, and provides `metricsFromEvents` to recompute every
// hard and soft event-based metric directly from a MatchEvent stream.
import { teamMetrics } from '../engine/stats/metrics.js';

export { teamMetrics };

/**
 * Recomputes per-team hard and soft metrics directly from a MatchEvent log.
 * Restarts (KICK_OFF, THROW_IN, GOAL_KICK, CORNER, FREE_KICK, DROP_BALL) are
 * never counted as PASS events, matching §13 and the StatsBomb extractor.
 *
 * @param {Array<{type: string, teamIndex: number, x: number, y: number, zone: number, meta?: Record<string, any>}>} events
 * @param {{home?: {ticks?: number, timeOnBallTicks?: number, distanceM?: number, sprints?: number}, away?: {ticks?: number, timeOnBallTicks?: number, distanceM?: number, sprints?: number}}} [extras]
 * @returns {{home: Record<string, number>, away: Record<string, number>}}
 */
export function metricsFromEvents(events, extras = {}) {
  const blank = () => ({
    goals: 0,
    xG: 0,
    shots: 0,
    shotsOnTarget: 0,
    passes: 0,
    passesCompleted: 0,
    foulsCommitted: 0,
    // Soft counters
    bigChances: 0,
    woodwork: 0,
    shotsInBox: 0,
    finalThirdPasses: 0,
    progressivePasses: 0,
    crosses: 0,
    crossesCompleted: 0,
    tackles: 0,
    tacklesWon: 0,
    interceptions: 0,
    clearances: 0,
    aerialDuels: 0,
    aerialDuelsWon: 0,
    recoveries: 0,
    yellows: 0,
    reds: 0,
    corners: 0,
    offsides: 0,
    gkSaves: 0,
    psxgTotal: 0,
    oppPassesInOpp60: 0,
    defActionsInOpp60: 0,
  });

  const c = [blank(), blank()];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const t = ev.teamIndex;
    if (t !== 0 && t !== 1) continue;
    const own = c[t];
    const opp = c[1 - t];
    const m = ev.meta ?? {};

    switch (ev.type) {
      case 'GOAL':
        if (m.kind === 'OWN_GOAL') opp.goals++;
        else own.goals++;
        break;
      case 'SHOT':
        own.shots++;
        own.xG += Number(m.xg ?? 0);
        own.psxgTotal += Number(m.psxg ?? 0);
        if (m.result === 'ON_TARGET') own.shotsOnTarget++;
        if (m.result === 'WOODWORK') own.woodwork++;
        if (Number(m.distance ?? 99) <= 18) own.shotsInBox++;
        break;
      case 'BIG_CHANCE':
        own.bigChances++;
        break;
      case 'PASS':
        own.passes++;
        if (m.completed === true) own.passesCompleted++;
        if (ev.zone >= 13) own.finalThirdPasses++;
        if (m.kind === 'THROUGH' || m.kind === 'LONG') own.progressivePasses++;
        // Opponent's defensive 60% = zones 1..12 of the passing team.
        if (ev.zone >= 1 && ev.zone <= 12) opp.oppPassesInOpp60++;
        break;
      case 'CROSS':
        own.crosses++;
        if (m.completed === true) own.crossesCompleted++;
        break;
      case 'FOUL':
        own.foulsCommitted++;
        if (ev.zone >= 7) own.defActionsInOpp60++;
        break;
      case 'TACKLE':
        own.tackles++;
        if (m.won === true) own.tacklesWon++;
        if (ev.zone >= 7) own.defActionsInOpp60++;
        break;
      case 'INTERCEPTION':
        own.interceptions++;
        if (ev.zone >= 7) own.defActionsInOpp60++;
        break;
      case 'CLEARANCE':
        own.clearances++;
        break;
      case 'AERIAL_DUEL':
        own.aerialDuels++;
        if (m.won === true) own.aerialDuelsWon++;
        break;
      case 'RECOVERY':
        own.recoveries++;
        break;
      case 'YELLOW_CARD':
        own.yellows++;
        break;
      case 'RED_CARD':
        own.reds++;
        break;
      case 'CORNER':
        own.corners++;
        break;
      case 'OFFSIDE':
        own.offsides++;
        break;
      case 'SAVE':
        own.gkSaves++;
        break;
      default:
        break;
    }
  }

  const finalize = (/** @type {number} */ t, /** @type {any} */ ex) => {
    const own = c[t];
    const opp = c[1 - t];
    const base = teamMetrics(own, opp, {
      ticks: ex?.ticks ?? 0,
      timeOnBallTicks: ex?.timeOnBallTicks ?? 0,
      distanceM: ex?.distanceM ?? 0,
      sprints: ex?.sprints ?? 0,
    });
    const totalFinalThird = own.finalThirdPasses + opp.finalThirdPasses;
    return {
      ...base,
      shotsInBoxPct: own.shots > 0 ? (100 * own.shotsInBox) / own.shots : 0,
      finalThirdPassPct: own.passes > 0 ? (100 * own.finalThirdPasses) / own.passes : 0,
      crossCompletionPct: own.crosses > 0 ? (100 * own.crossesCompleted) / own.crosses : 0,
      tackleWinPct: own.tackles > 0 ? (100 * own.tacklesWon) / own.tackles : 0,
      aerialWinPct: own.aerialDuels > 0 ? (100 * own.aerialDuelsWon) / own.aerialDuels : 0,
      fieldTiltPct: totalFinalThird > 0 ? (100 * own.finalThirdPasses) / totalFinalThird : 50,
      ppda: own.defActionsInOpp60 > 0 ? own.oppPassesInOpp60 / own.defActionsInOpp60 : 0,
    };
  };

  return {
    home: finalize(0, extras.home),
    away: finalize(1, extras.away),
  };
}

/**
 * Statistics (design §13, item 33). Updated only from events, using the stat
 * entries of the event registry; timeOnBallPct, distance and sprints are soft
 * extras read from state.
 */

import { teamMetrics } from './metrics.js';

/**
 * @param {any} when registry `when` clause
 * @param {Record<string, any>} meta
 * @returns {boolean}
 */
function matches(when, meta) {
  for (const key of Object.keys(when)) {
    const wanted = when[key];
    if (Array.isArray(wanted) ? !wanted.includes(meta[key]) : meta[key] !== wanted) return false;
  }
  return true;
}

export class MatchStats {
  /**
   * @param {Record<string, any>} eventTypes `config.events.types`
   */
  constructor(eventTypes) {
    this.eventTypes = eventTypes;
    const names = new Set();
    for (const type of Object.keys(eventTypes)) {
      for (const stat of eventTypes[type].stats) names.add(stat.metric);
    }
    /** @type {string[]} */
    this.metrics = [...names].sort();
    /** @type {Record<string, number>[]} */
    this.counters = [this.#blank(), this.#blank()];
    this.timeOnBallTicks = [0, 0];
    this.yellowCards = [0, 0];
    this.redCards = [0, 0];
    this.playerGoals = new Array(36).fill(0);
    this.playerAssists = new Array(36).fill(0);
  }

  #blank() {
    /** @type {Record<string, number>} */
    const c = {};
    for (const m of this.metrics) c[m] = 0;
    return c;
  }

  /**
   * @param {import('../events/MatchEvent.js').MatchEvent} event
   */
  onEvent(event) {
    const def = this.eventTypes[event.type];
    for (const stat of def.stats) {
      if (stat.when !== undefined && !matches(stat.when, event.meta)) continue;
      const team = stat.side === 'actor' ? event.teamIndex : 1 - event.teamIndex;
      const inc = stat.incFrom !== undefined ? /** @type {number} */ (event.meta[stat.incFrom]) : (stat.inc ?? 1);
      this.counters[team][stat.metric] += inc;
    }
    if (event.type === 'GOAL' && event.meta.kind !== 'OWN_GOAL' && event.actorIndex >= 0) {
      this.playerGoals[event.actorIndex]++;
    } else if (event.type === 'ASSIST' && event.actorIndex >= 0) {
      this.playerAssists[event.actorIndex]++;
    } else if (event.type === 'YELLOW_CARD' && (event.teamIndex === 0 || event.teamIndex === 1)) {
      this.yellowCards[event.teamIndex]++;
    } else if (event.type === 'RED_CARD' && (event.teamIndex === 0 || event.teamIndex === 1)) {
      this.redCards[event.teamIndex]++;
    } else if (event.type === 'VAR_DECISION') {
      // A disallowed goal comes off the scorer (and the assister); an upgraded yellow is rescinded (its red follows).
      const m = event.meta;
      if (m.outcome === 'goalDisallowed' && event.actorIndex >= 0) {
        this.playerGoals[event.actorIndex]--;
        if (typeof m.assist === 'number' && m.assist >= 0) this.playerAssists[m.assist]--;
      } else if (m.outcome === 'redCardUpgraded' && (event.teamIndex === 0 || event.teamIndex === 1)) {
        this.yellowCards[event.teamIndex]--;
      }
    }
  }

  /**
   * Counts a tick in control for the team owning the ball (soft metric).
   * @param {import('./../state/MatchState.js').MatchState} state
   */
  onTick(state) {
    const owner = state.ball.owner;
    if (owner >= 0) this.timeOnBallTicks[state.players[owner].team]++;
  }

  /** @returns {Record<string, any>} */
  serialize() {
    return {
      counters: this.counters.map((c) => ({ ...c })),
      timeOnBallTicks: [...this.timeOnBallTicks],
      yellowCards: [...this.yellowCards],
      redCards: [...this.redCards],
      playerGoals: [...this.playerGoals],
      playerAssists: [...this.playerAssists],
    };
  }

  /** @param {Record<string, any>} data */
  restore(data) {
    this.counters = [this.#blank(), this.#blank()];
    for (let t = 0; t < 2; t++) {
      for (const m of this.metrics) this.counters[t][m] = data.counters[t][m];
    }
    this.timeOnBallTicks = [...data.timeOnBallTicks];
    this.yellowCards = data.yellowCards ? [...data.yellowCards] : [0, 0];
    this.redCards = data.redCards ? [...data.redCards] : [0, 0];
    this.playerGoals = [...data.playerGoals];
    this.playerAssists = [...data.playerAssists];
  }

  /**
   * Per-team report: event counters, derived percentages, and distance and
   * sprints from player state. Callers should call it at most once per frame.
   * @param {import('./../state/MatchState.js').MatchState} state
   * @returns {{home: Record<string, number>, away: Record<string, number>}}
   */
  toJSON(state) {
    const teams = [0, 1].map((t) => {
      const c = this.counters[t];
      const o = this.counters[1 - t];
      let distance = 0;
      let sprints = 0;
      for (const p of state.players) {
        if (p.team === t) {
          distance += p.distance;
          sprints += p.sprints;
        }
      }
      const m = teamMetrics(c, o, { ticks: state.tick, timeOnBallTicks: this.timeOnBallTicks[t], distanceM: distance, sprints });
      m.yellowCards = this.yellowCards[t];
      m.redCards = this.redCards[t];
      return m;
    });
    return { home: teams[0], away: teams[1] };
  }
}

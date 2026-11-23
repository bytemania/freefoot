/**
 * 15-minute timing benchmarks from StatsBomb Open Data (used by fetch-league-benchmarks.mjs).
 *
 * Goals, shots and cards come from the 2015/16 Big-5 league seasons (the same matches as the
 * other StatsBomb figures). Substitutions come from the five-substitution era (2020/21 on),
 * because the 2015/16 seasons were played with three: the open data has those later seasons only
 * as single-club collections (Barcelona, Paris Saint-Germain, Bayer Leverkusen), so the
 * substitution shares describe those clubs and are labelled that way in the output.
 */
import { TIMING_BUCKETS, TIMING_KINDS, addStatsbombTiming, blankTiming, shares } from '../../src/calibration/timing.js';

/** Seasons of the five-substitution era available as open data (single-club collections). */
export const SUB_ERA_SEASONS = [
  { competition_id: 11, season_id: 90, label: 'La Liga 2020/21 (Barcelona)' },
  { competition_id: 7, season_id: 108, label: 'Ligue 1 2021/22 (Paris Saint-Germain)' },
  { competition_id: 7, season_id: 235, label: 'Ligue 1 2022/23 (Paris Saint-Germain)' },
  { competition_id: 9, season_id: 281, label: '1. Bundesliga 2023/24 (Bayer Leverkusen)' },
];

/**
 * @typedef {(...parts: string[]) => Promise<any | null>} JsonReader reads a file under the StatsBomb `data/` directory
 */

/**
 * Counts one season's matches into `into`, only for the kinds in `kinds`.
 * @param {JsonReader} readJson
 * @param {{competition_id: number, season_id: number, label: string}} season
 * @param {Record<string, Record<string, number>>} into
 * @param {number} limit most matches to read from the season
 * @returns {Promise<number>} matches counted
 */
async function countSeason(readJson, season, into, limit) {
  /** @type {any[] | null} */
  const list = await readJson('matches', String(season.competition_id), `${season.season_id}.json`);
  if (!list) {
    console.warn(`benchmarks: StatsBomb ${season.label} unavailable`);
    return 0;
  }
  const chosen = list
    .slice()
    .sort((a, b) => a.match_id - b.match_id)
    .filter((_, i, arr) => limit >= arr.length || i % Math.ceil(arr.length / limit) === 0)
    .slice(0, limit);
  let used = 0;
  for (const mt of chosen) {
    /** @type {any[] | null} */
    const events = await readJson('events', `${mt.match_id}.json`);
    if (!events) continue;
    addStatsbombTiming(events, into);
    used++;
  }
  return used;
}

/**
 * @param {Record<string, Record<string, number>>} counts
 * @param {string[]} kinds
 * @returns {Record<string, {total: number, counts: Record<string, number>, share: Record<string, number>}>}
 */
function summarise(counts, kinds) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const kind of kinds) {
    const c = counts[kind];
    out[kind] = { total: TIMING_BUCKETS.reduce((a, b) => a + c[b], 0), counts: { ...c }, share: roundShares(shares(c)) };
  }
  return out;
}

/** @param {Record<string, number>} s */
function roundShares(s) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const b of TIMING_BUCKETS) out[b] = Math.round(s[b] * 1e4) / 1e4;
  return out;
}

/**
 * Builds the `timing` section of the benchmark file.
 * @param {object} opts
 * @param {JsonReader} opts.readJson
 * @param {Array<{competition_id: number, season_id: number, label: string}>} opts.leagueSeasons the 2015/16 Big-5 seasons
 * @param {number} opts.limit most matches read per season
 * @returns {Promise<Record<string, any>>}
 */
export async function buildTimingBenchmark({ readJson, leagueSeasons, limit }) {
  const league = blankTiming();
  let leagueMatches = 0;
  /** @type {Array<{season: string, matches: number}>} */
  const leagueUsed = [];
  for (const s of leagueSeasons) {
    const n = await countSeason(readJson, s, league, limit);
    leagueMatches += n;
    leagueUsed.push({ season: s.label, matches: n });
  }
  const subs = blankTiming();
  let subMatches = 0;
  /** @type {Array<{season: string, matches: number}>} */
  const subUsed = [];
  for (const s of SUB_ERA_SEASONS) {
    const n = await countSeason(readJson, s, subs, limit);
    subMatches += n;
    subUsed.push({ season: s.label, matches: n });
  }
  const kinds = TIMING_KINDS.filter((k) => k !== 'substitutions');
  return {
    description: 'Share of each match total falling in each 15-minute bucket (45+ and 90+ are first- and second-half stoppage time)',
    buckets: [...TIMING_BUCKETS],
    league: { source: 'StatsBomb Open Data 2015/16 Big-5', matches: leagueMatches, seasons: leagueUsed, ...summarise(league, kinds) },
    fiveSubEra: {
      source: 'StatsBomb Open Data, five-substitution era (single-club collections, so team-specific)',
      matches: subMatches,
      seasons: subUsed,
      ...summarise(subs, ['substitutions']),
    },
  };
}

/**
 * Shared StatsBomb Open Data reader (design item 26b, §18a).
 *
 * Used by both `scripts/fit-xg.mjs` and `scripts/build-reference.mjs` so both
 * use the exact same 2015/16 top-five league allow-list, yard-to-metre
 * geometry, open-play pass filter and xG feature extraction.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { angleToPosts, inCone } from '../../src/engine/math/geom.js';
import { xg as xgModel } from '../../src/engine/xg/ShotModels.js';

export const YARD_TO_M = 0.9144;
export const SB_GOAL_X = 120;
export const SB_GOAL_Y = 40;
export const HALF_GOAL_M = 3.66;

/**
 * 2015/16 top-five European league seasons (design item 26b).
 * Single-club collections are excluded because they skew possession and passes.
 */
export const ALLOW_LIST = [
  { competition_id: 2, season_id: 27, label: 'Premier League' },
  { competition_id: 11, season_id: 27, label: 'La Liga' },
  { competition_id: 12, season_id: 27, label: 'Serie A' },
  { competition_id: 9, season_id: 27, label: 'Bundesliga' },
  { competition_id: 7, season_id: 27, label: 'Ligue 1' },
];

const RESTART_PASS_TYPES = new Set(['Corner', 'Free Kick', 'Goal Kick', 'Kick Off', 'Throw-in']);
const ON_TARGET_OUTCOMES = new Set(['Goal', 'Saved', 'Saved to Post']);

/**
 * Reads and parses a JSON file under the StatsBomb data directory.
 * @param {string} sbDir repository root containing `data/`
 * @param {...string} parts path segments under `data/`
 * @returns {any}
 */
function readSbJson(sbDir, ...parts) {
  const full = path.join(sbDir, 'data', ...parts);
  return JSON.parse(readFileSync(full, 'utf8'));
}

/**
 * Checks each competition/season pair in ALLOW_LIST against `data/competitions.json`.
 * @param {string} sbDir
 * @returns {{found: Array<{competition_id: number, season_id: number, label: string, competition_name: string, season_name: string}>, missing: Array<{competition_id: number, season_id: number, label: string}>}}
 */
export function loadAllowListCompetitions(sbDir) {
  /** @type {any[]} */
  const all = readSbJson(sbDir, 'competitions.json');
  const found = [];
  const missing = [];
  for (const entry of ALLOW_LIST) {
    const match = all.find((c) => c.competition_id === entry.competition_id && c.season_id === entry.season_id);
    if (match) {
      found.push({
        ...entry,
        competition_name: match.competition_name,
        season_name: match.season_name,
      });
    } else {
      missing.push(entry);
    }
  }
  return { found, missing };
}

/**
 * Loads the match list for one competition and season.
 * @param {string} sbDir
 * @param {number} competitionId
 * @param {number} seasonId
 * @returns {any[]}
 */
export function loadSeasonMatches(sbDir, competitionId, seasonId) {
  const full = path.join(sbDir, 'data', 'matches', String(competitionId), `${seasonId}.json`);
  if (!existsSync(full)) return [];
  return JSON.parse(readFileSync(full, 'utf8'));
}

/**
 * Loads the raw event array for one match.
 * @param {string} sbDir
 * @param {number} matchId
 * @returns {any[] | null}
 */
export function loadMatchEvents(sbDir, matchId) {
  const full = path.join(sbDir, 'data', 'events', `${matchId}.json`);
  if (!existsSync(full)) return null;
  return JSON.parse(readFileSync(full, 'utf8'));
}

/**
 * Whether a StatsBomb event is an open-play pass, matching the engine's PASS
 * rule (§13, item 26a): excludes Corner, Free Kick, Goal Kick, Kick Off and
 * Throw-in; includes crosses, keeper distribution, Recovery and Interception passes.
 * @param {any} ev
 * @returns {boolean}
 */
export function isOpenPlayPass(ev) {
  if (ev.type?.name !== 'Pass') return false;
  const passType = ev.pass?.type?.name;
  return passType === undefined || !RESTART_PASS_TYPES.has(passType);
}

/**
 * Extracts xG features from a StatsBomb Shot event in metres relative to the
 * goal centre (120, 40) at 0.9144 m per yard (design item 26b).
 * Uses `detmath.fastAtan2` via `angleToPosts` and `inCone` from the engine.
 * @param {any} shotEv
 * @param {Map<string, any>} eventById
 * @returns {{distance: number, angle: number, isHeader: boolean, defendersInCone: number, assistType: 'none' | 'cross' | 'through' | 'cutback' | 'setPiece', isPenalty: boolean, isGoal: boolean}}
 */
export function extractShotFeatures(shotEv, eventById) {
  const [sx, sy] = shotEv.location ?? [SB_GOAL_X, SB_GOAL_Y];
  const dx = (SB_GOAL_X - sx) * YARD_TO_M;
  const dy = (sy - SB_GOAL_Y) * YARD_TO_M;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const angle = angleToPosts(dx, dy, 0, 0, HALF_GOAL_M);
  const isHeader = shotEv.shot?.body_part?.name === 'Head';
  const isPenalty = shotEv.shot?.type?.name === 'Penalty';
  const isGoal = shotEv.shot?.outcome?.name === 'Goal';

  let defendersInCone = 0;
  const freeze = shotEv.shot?.freeze_frame;
  if (Array.isArray(freeze)) {
    for (let i = 0; i < freeze.length; i++) {
      const f = freeze[i];
      if (f.teammate !== false) continue;
      if (f.position?.name === 'Goalkeeper') continue;
      const [fx, fy] = f.location ?? [0, 0];
      const fdx = (SB_GOAL_X - fx) * YARD_TO_M;
      const fdy = (fy - SB_GOAL_Y) * YARD_TO_M;
      if (inCone(dx, dy, 0, -HALF_GOAL_M, 0, HALF_GOAL_M, fdx, fdy)) {
        defendersInCone++;
      }
    }
  }

  /** @type {'none' | 'cross' | 'through' | 'cutback' | 'setPiece'} */
  let assistType = 'none';
  const keyPassId = shotEv.shot?.key_pass_id;
  if (keyPassId && eventById.has(keyPassId)) {
    const kp = eventById.get(keyPassId);
    const p = kp.pass ?? {};
    if (p.cross === true) assistType = 'cross';
    else if (p.through_ball === true) assistType = 'through';
    else if (p.cut_back === true) assistType = 'cutback';
    else if (RESTART_PASS_TYPES.has(p.type?.name)) assistType = 'setPiece';
  } else if (shotEv.shot?.type?.name === 'Free Kick' || shotEv.shot?.type?.name === 'Corner') {
    assistType = 'setPiece';
  }

  return { distance, angle, isHeader, defendersInCone, assistType, isPenalty, isGoal };
}

/**
 * Extracts the 8 hard per-team metrics from one match's raw StatsBomb events
 * (design item 26a). Period 5 (penalty shoot-outs) is excluded.
 * @param {any[]} events
 * @param {number} homeTeamId
 * @param {number} awayTeamId
 * @param {any} xgConfig `{logistic, penaltyXg}` from `config/xg.yaml`
 * @returns {{home: Record<string, number>, away: Record<string, number>}}
 */
export function extractMatchMetrics(events, homeTeamId, awayTeamId, xgConfig) {
  /** @type {Map<string, any>} */
  const eventById = new Map();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.id) eventById.set(ev.id, ev);
  }

  const blank = () => ({
    goals: 0,
    xG: 0,
    shots: 0,
    shotsOnTarget: 0,
    passes: 0,
    passesCompleted: 0,
    foulsCommitted: 0,
  });

  /** @type {Record<number, ReturnType<typeof blank>>} */
  const byTeam = {
    [homeTeamId]: blank(),
    [awayTeamId]: blank(),
  };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.period === 5) continue;
    const teamId = ev.team?.id;
    const row = byTeam[teamId];
    if (!row) continue;

    const typeName = ev.type?.name;
    if (typeName === 'Shot') {
      row.shots++;
      const outcome = ev.shot?.outcome?.name;
      if (outcome === 'Goal') row.goals++;
      if (ON_TARGET_OUTCOMES.has(outcome)) row.shotsOnTarget++;
      const feat = extractShotFeatures(ev, eventById);
      row.xG += feat.isPenalty ? xgConfig.penaltyXg : xgModel(feat, xgConfig.logistic);
    } else if (typeName === 'Own Goal For') {
      // In StatsBomb, `Own Goal For` carries the scoring (benefiting) team's id.
      row.goals++;
    } else if (isOpenPlayPass(ev)) {
      row.passes++;
      if (ev.pass?.outcome === undefined) row.passesCompleted++;
    } else if (typeName === 'Foul Committed') {
      row.foulsCommitted++;
    }
  }

  const h = byTeam[homeTeamId];
  const a = byTeam[awayTeamId];
  const totalPasses = h.passes + a.passes;
  return {
    home: {
      ...h,
      passCompletionPct: h.passes > 0 ? (100 * h.passesCompleted) / h.passes : 0,
      possessionPct: totalPasses > 0 ? (100 * h.passes) / totalPasses : 50,
    },
    away: {
      ...a,
      passCompletionPct: a.passes > 0 ? (100 * a.passesCompleted) / a.passes : 0,
      possessionPct: totalPasses > 0 ? (100 * a.passes) / totalPasses : 50,
    },
  };
}

/**
 * Computes final league standings from a season's match list using 3/1/0 points,
 * then goal difference, then goals for (tie-broken by teamId).
 * @param {any[]} matches
 * @returns {Array<{teamId: number, teamName: string, points: number, gd: number, gf: number}>}
 */
export function computeStandings(matches) {
  /** @type {Map<number, {teamId: number, teamName: string, points: number, gd: number, gf: number}>} */
  const table = new Map();
  const ensure = (/** @type {number} */ id, /** @type {string} */ name) => {
    let row = table.get(id);
    if (!row) {
      row = { teamId: id, teamName: name, points: 0, gd: 0, gf: 0 };
      table.set(id, row);
    }
    return row;
  };
  for (const m of matches) {
    const h = ensure(m.home_team.home_team_id, m.home_team.home_team_name);
    const a = ensure(m.away_team.away_team_id, m.away_team.away_team_name);
    const hs = m.home_score;
    const as = m.away_score;
    h.gf += hs;
    h.gd += hs - as;
    a.gf += as;
    a.gd += as - hs;
    if (hs > as) h.points += 3;
    else if (as > hs) a.points += 3;
    else {
      h.points += 1;
      a.points += 1;
    }
  }
  return [...table.values()].sort(
    (x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf || x.teamId - y.teamId,
  );
}

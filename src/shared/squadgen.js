/**
 * Squad generator (design §18, item 71). Draws attributes from the frozen
 * normal distributions in `scenarios.yaml` with `sfc32` and an Irwin-Hall
 * approximation (z = sum of 12 uniforms - 6, only + and -), clamped to 1-20
 * and rounded, so squads are byte-identical across Node versions. Uses no
 * Node or DOM globals: both the calibration runner and the `#seed` debug
 * route use it.
 */
import { nextFloat } from '../engine/rng/sfc32.js';
import { seedSfc32 } from '../engine/rng/streams.js';
import { ATTRIBUTES, formatShortName } from '../engine/contracts/MatchInput.js';

/** Bench roles, in order: players[11..17]. */
const BENCH_ROLES = ['GK', 'CB', 'FB', 'MF', 'MF', 'W', 'ST'];
/** Attributes outside a role's primary and secondary lists sit this far below the secondary mean. */
const OTHER_OFFSET = 4;

/**
 * Approximately standard normal: the sum of 12 uniforms minus 6.
 * @param {Uint32Array} rng
 * @returns {number}
 */
function normal(rng) {
  let z = 0;
  for (let i = 0; i < 12; i++) z += nextFloat(rng);
  return z - 6;
}

/**
 * @param {'A' | 'B_strong' | 'B_weak'} scenarioSide which distribution to draw from
 * @param {number} seed
 * @param {any} config compiled config
 * @param {{side?: 'home' | 'away', formationId?: string, controlledBy?: 'human' | 'ai'}} [options]
 * @returns {import('../engine/contracts/MatchInput.js').InputTeam} a valid MatchInput team
 */
export function generateSquad(scenarioSide, seed, config, { side = 'home', formationId, controlledBy = 'ai' } = {}) {
  const scenarios = config.calibration.scenarios;
  const dist = scenarios.distributions[scenarioSide];
  const formation = formationId ?? scenarios.formations[scenarioSide === 'A' ? 'A' : 'B'][side];
  return buildSquad(dist, scenarioSide.toLowerCase(), scenarioSide, seed, config, { side, formation, controlledBy });
}

/** Secondary attributes sit this far below primary ones in a rated squad. */
const RATED_SECONDARY_GAP = 1.5;

/**
 * Overall rating (OVR, 0-100) of a team: 5 x the mean role rating of the
 * eleven starters. A 1-20 role rating of 16 is an 80 OVR side.
 * @param {import('../engine/contracts/MatchInput.js').InputTeam} team
 * @param {Record<string, any>} roles `config.roles`
 * @returns {number}
 */
export function teamOverall(team, roles) {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const p = team.players[i];
    const role = roles[p.role];
    let a = 0;
    for (const attr of role.primary) a += p.attributes[attr];
    let b = 0;
    for (const attr of role.secondary) b += p.attributes[attr];
    sum += role.rating.primary * (a / role.primary.length) + role.rating.secondary * (b / role.secondary.length);
  }
  return (5 * sum) / 11;
}

/**
 * A squad whose starters average a target OVR (calibration cohorts: 80 v 80,
 * 88 v 68, 83 v 74). Primary attributes are drawn around
 * `ovr / 5 + 0.3 x gap`, secondary ones `gap` lower, so the role rating
 * (0.7 primary + 0.3 secondary) averages `ovr / 5`. An optional `morale`
 * (0-100) is written on the team.
 * @param {number} ovr target overall rating, 25-95
 * @param {number} seed
 * @param {any} config compiled config
 * @param {{side?: 'home' | 'away', formationId?: string, controlledBy?: 'human' | 'ai', morale?: number}} [options]
 * @returns {import('../engine/contracts/MatchInput.js').InputTeam}
 */
export function generateRatedSquad(ovr, seed, config, { side = 'home', formationId = '4-3-3', controlledBy = 'ai', morale } = {}) {
  const rating = ovr / 5;
  const primaryMean = rating + 0.3 * RATED_SECONDARY_GAP;
  const dist = {
    primary: { mean: primaryMean, sd: 1.2 },
    secondary: { mean: primaryMean - RATED_SECONDARY_GAP, sd: 1.4 },
  };
  const team = buildSquad(dist, `ovr${Math.round(ovr)}`, `OVR ${Math.round(ovr)}`, seed, config, { side, formation: formationId, controlledBy });
  if (morale !== undefined) team.morale = morale;
  return team;
}

/**
 * @param {{primary: {mean: number, sd: number}, secondary: {mean: number, sd: number}}} dist
 * @param {string} tag id prefix
 * @param {string} label team name prefix
 * @param {number} seed
 * @param {any} config
 * @param {{side: 'home' | 'away', formation: string, controlledBy: 'human' | 'ai'}} options
 * @returns {import('../engine/contracts/MatchInput.js').InputTeam}
 */
function buildSquad(dist, tag, label, seed, config, { side, formation, controlledBy }) {
  const slots = config.tactics.formations[formation].slots;
  const rng = seedSfc32(new Uint32Array(4), seed);
  const teamId = `${tag}-${side}-${seed >>> 0}`;
  const roles = [...slots.map((/** @type {any} */ s) => s.role), ...BENCH_ROLES];
  const numbers = [1, 2, 4, 5, 3, 6, 8, 10, 11, 9, 7, 12, 13, 14, 15, 16, 17, 18];
  const players = roles.map((role, i) => {
    const def = config.roles[role];
    /** @type {Record<string, number>} */
    const attributes = {};
    for (const attr of ATTRIBUTES) {
      let mean = dist.secondary.mean - OTHER_OFFSET;
      let sd = dist.secondary.sd;
      if (def.primary.includes(attr)) {
        mean = dist.primary.mean;
        sd = dist.primary.sd;
      } else if (def.secondary.includes(attr)) {
        mean = dist.secondary.mean;
        sd = dist.secondary.sd;
      }
      const v = Math.round(mean + sd * normal(rng));
      attributes[attr] = v < 1 ? 1 : v > 20 ? 20 : v;
    }
    const name = `Player ${i + 1}`;
    return {
      id: `${teamId}-${i + 1}`,
      name,
      shortName: formatShortName(name),
      number: numbers[i],
      gender: /** @type {'masc'} */ ('masc'),
      role,
      attributes,
    };
  });
  return {
    id: teamId,
    name: `${label} ${side} ${seed >>> 0}`,
    gender: 'masc',
    artDef: 'o',
    contractionDe: 'do',
    contractionEm: 'no',
    controlledBy,
    formationId: formation,
    players,
  };
}

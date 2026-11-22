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
  const slots = config.tactics.formations[formation].slots;
  const rng = seedSfc32(new Uint32Array(4), seed);
  const teamId = `${scenarioSide.toLowerCase()}-${side}-${seed >>> 0}`;
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
    name: `${scenarioSide} ${side} ${seed >>> 0}`,
    gender: 'masc',
    artDef: 'o',
    contractionDe: 'do',
    contractionEm: 'no',
    controlledBy,
    formationId: formation,
    players,
  };
}

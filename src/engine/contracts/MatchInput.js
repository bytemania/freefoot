/**
 * MatchInput contract and validation (design item 28).
 */

/** Attribute groups. Goalkeeping counts as physical for fitness and injuries. */
export const ATTRIBUTE_GROUPS = Object.freeze({
  physical: ['pace', 'acceleration', 'stamina', 'strength', 'jumpingReach', 'agility', 'balance'],
  technical: ['passing', 'crossing', 'dribbling', 'finishing', 'firstTouch', 'technique', 'tackling', 'marking', 'kicking', 'throwing'],
  mental: ['decisions', 'positioning', 'composure', 'concentration', 'bravery', 'teamwork', 'workRate', 'vision', 'aggression', 'offTheBall', 'flair', 'determination'],
  goalkeeping: ['reflexes', 'oneOnOnes', 'aerialReach', 'commandOfArea'],
});

/** All 33 attribute names. */
export const ATTRIBUTES = Object.freeze([
  ...ATTRIBUTE_GROUPS.physical,
  ...ATTRIBUTE_GROUPS.technical,
  ...ATTRIBUTE_GROUPS.mental,
  ...ATTRIBUTE_GROUPS.goalkeeping,
]);

export const PLAYERS_PER_TEAM = 18;
export const STARTERS = 11;

/**
 * Deterministic short-name fallback (e.g. "João Silva" -> "J. Silva",
 * "Bruno Miguel Fernandes" -> "B. Fernandes", "Silva" -> "Silva").
 * Uses no locale-dependent string methods (engine determinism rule).
 * @param {string} name
 * @returns {string}
 */
export function formatShortName(name) {
  const trimmed = String(name ?? '').trim();
  if (trimmed === '') return '';
  const parts = trimmed.split(/\s+/);
  if (parts.length <= 1) return trimmed;
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

/**
 * @typedef {Record<string, number>} Attributes every attribute an integer 1-20
 *
 * @typedef {object} InputPlayer
 * @property {string} id
 * @property {string} name
 * @property {string} [shortName]
 * @property {number} number
 * @property {'masc' | 'fem'} gender
 * @property {string} role
 * @property {Attributes} attributes
 *
 * @typedef {object} InputTeam
 * @property {string} id
 * @property {string} name
 * @property {'masc' | 'fem'} gender
 * @property {string} artDef
 * @property {string} contractionDe
 * @property {string} contractionEm
 * @property {'human' | 'ai'} controlledBy
 * @property {string} formationId
 * @property {InputPlayer[]} players players[0..10] start (goalkeeper first), players[11..17] are the bench
 *
 * @typedef {object} MatchInput
 * @property {1} v
 * @property {number} seed uint32
 * @property {string} configHash
 * @property {InputTeam} home
 * @property {InputTeam} away
 */

/**
 * Checks a MatchInput against the config. Returns a list of error messages
 * (empty when valid).
 * @param {any} input
 * @param {any} config compiled config (needs `tactics.formations` and `roles`)
 * @returns {string[]}
 */
export function validateMatchInput(input, config) {
  /** @type {string[]} */
  const errors = [];
  if (input === null || typeof input !== 'object') return ['input must be an object'];
  if (input.v !== 1) errors.push('v must be 1');
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff) errors.push('seed must be an integer in 0..4294967295');
  if (typeof input.configHash !== 'string' || input.configHash === '') errors.push('configHash must be a non-empty string');

  const formations = config?.tactics?.formations ?? {};
  const roles = config?.roles ?? {};
  const allIds = new Set();
  for (const side of ['home', 'away']) {
    const team = input[side];
    if (team === null || typeof team !== 'object') {
      errors.push(`${side} must be an object`);
      continue;
    }
    for (const key of ['id', 'name', 'artDef', 'contractionDe', 'contractionEm']) {
      if (typeof team[key] !== 'string' || team[key] === '') errors.push(`${side}.${key} must be a non-empty string`);
    }
    if (team.gender !== 'masc' && team.gender !== 'fem') errors.push(`${side}.gender must be "masc" or "fem"`);
    if (team.controlledBy !== 'human' && team.controlledBy !== 'ai') errors.push(`${side}.controlledBy must be "human" or "ai"`);
    if (!(team.formationId in formations)) errors.push(`${side}.formationId "${team.formationId}" is unknown`);
    if (!Array.isArray(team.players) || team.players.length !== PLAYERS_PER_TEAM) {
      errors.push(`${side}.players must have ${PLAYERS_PER_TEAM} entries`);
      continue;
    }
    if (team.players[0]?.role !== 'GK') errors.push(`${side}.players[0] must be a goalkeeper (GK)`);
    const numbers = new Set();
    team.players.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
      const at = `${side}.players[${i}]`;
      if (p === null || typeof p !== 'object') {
        errors.push(`${at} must be an object`);
        return;
      }
      if (typeof p.id !== 'string' || p.id === '') errors.push(`${at}.id must be a non-empty string`);
      else if (allIds.has(p.id)) errors.push(`${at}.id "${p.id}" is not unique`);
      else allIds.add(p.id);
      if (typeof p.name !== 'string' || p.name === '') errors.push(`${at}.name must be a non-empty string`);
      if (p.shortName !== undefined && (typeof p.shortName !== 'string' || p.shortName === '')) {
        errors.push(`${at}.shortName must be a non-empty string`);
      }
      if (!Number.isInteger(p.number)) errors.push(`${at}.number must be an integer`);
      else if (numbers.has(p.number)) errors.push(`${at}.number ${p.number} is not unique in the team`);
      else numbers.add(p.number);
      if (p.gender !== 'masc' && p.gender !== 'fem') errors.push(`${at}.gender must be "masc" or "fem"`);
      if (!(p.role in roles)) errors.push(`${at}.role "${p.role}" is unknown`);
      for (const attr of ATTRIBUTES) {
        const v = p.attributes?.[attr];
        if (v === undefined) errors.push(`${at}.attributes.${attr} is missing`);
        else if (!Number.isInteger(v) || v < 1 || v > 20) errors.push(`${at}.attributes.${attr} must be an integer 1-20`);
      }
    });
  }
  return errors;
}

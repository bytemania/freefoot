// Config build (design item 24, §17): validates config/**/*.yaml against
// config/schema/*.schema.json, cross-checks it, and emits generated/*.
//
// Usage: node scripts/build-config.mjs [--config-dir <dir>] [--out-dir <dir>] [--strict-i18n]
import { mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { LineCounter, parseDocument } from 'yaml';
import { canonicalJson, sha256Hex } from '../src/shared/canonicalJson.js';
import { formatShortName } from '../src/engine/contracts/MatchInput.js';
import { Template } from '../src/i18n/Template.js';
import { KNOBS } from '../src/engine/tactics/Instructions.js';
import { TRADEOFF_METRICS, instructionStringKeys } from '../src/calibration/instructions.js';
import { shoutStringKeys } from '../src/engine/tactics/Shouts.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = path.join(repoRoot, 'config', 'schema');

/** Locales every commentary and UI-string file must exist for. */
const LOCALES = ['pt-PT', 'en-GB'];

/**
 * @typedef {import('yaml').Document.Parsed} YamlDocument
 * @typedef {{rel: string, doc: YamlDocument, lineCounter: LineCounter, data: any}} Source
 */

/** @type {{file: string, line: number, col: number, message: string}[]} */
let problems = [];

/**
 * Records a problem at `pathParts` inside `source` (or at the file start).
 * @param {Source | undefined} source
 * @param {string} fileLabel
 * @param {(string | number)[]} pathParts
 * @param {string} message
 * @param {{key?: boolean}} [options] point at the key rather than the value
 */
function report(source, fileLabel, pathParts, message, options = {}) {
  let line = 1;
  let col = 1;
  if (source) {
    let node = /** @type {any} */ (source.doc.getIn(pathParts, true));
    if (options.key && pathParts.length > 0) {
      const parent = /** @type {any} */ (source.doc.getIn(pathParts.slice(0, -1), true));
      const pair = parent?.items?.find?.((/** @type {any} */ p) => String(p.key?.value ?? p.key) === String(pathParts.at(-1)));
      if (pair?.key) node = pair.key;
    }
    const offset = node?.range?.[0];
    if (typeof offset === 'number') {
      ({ line, col } = source.lineCounter.linePos(offset));
    }
  }
  const where = pathParts.length ? ` (at ${pathParts.join('.')})` : '';
  problems.push({ file: fileLabel, line, col, message: `${message}${where}` });
}

/**
 * @param {string} dir
 * @returns {string[]} sorted file names ending in .yaml
 */
function listYaml(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort() : [];
}

/**
 * @param {string} instancePath Ajv JSON-pointer-style path
 * @returns {string[]}
 */
function pointerToPath(instancePath) {
  return instancePath === '' ? [] : instancePath.slice(1).split('/').map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
}

const { values: args } = parseArgs({
  options: {
    'config-dir': { type: 'string', default: path.join(repoRoot, 'config') },
    'out-dir': { type: 'string', default: path.join(repoRoot, 'generated') },
    'strict-i18n': { type: 'boolean', default: false },
  },
});
const configDir = path.resolve(args['config-dir']);
const outDir = path.resolve(args['out-dir']);
const strictI18n = args['strict-i18n'];

// ---------------------------------------------------------------------------
// 1. Parse and validate every YAML file.
// ---------------------------------------------------------------------------

const ajv = new Ajv2020({ allErrors: true, strict: true });
/** @type {Map<string, import('ajv').ValidateFunction>} */
const validators = new Map();

/**
 * @param {string} name schema base name, for example "weights"
 */
function validatorFor(name) {
  let validate = validators.get(name);
  if (!validate) {
    const schema = JSON.parse(readFileSync(path.join(schemaDir, `${name}.schema.json`), 'utf8'));
    validate = ajv.compile(schema);
    validators.set(name, validate);
  }
  return validate;
}

/**
 * Loads one YAML file, reports syntax and schema errors, and returns the source.
 * @param {string} rel path relative to the config dir
 * @param {string} schemaName
 * @returns {Source | undefined}
 */
function load(rel, schemaName) {
  const full = path.join(configDir, rel);
  if (!existsSync(full)) {
    report(undefined, rel, [], 'file is missing');
    return undefined;
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(readFileSync(full, 'utf8'), { lineCounter, prettyErrors: true });
  /** @type {Source} */
  const source = { rel, doc, lineCounter, data: undefined };
  for (const err of doc.errors) {
    const pos = err.linePos?.[0];
    problems.push({ file: rel, line: pos?.line ?? 1, col: pos?.col ?? 1, message: err.message.split('\n')[0] });
  }
  if (doc.errors.length > 0) return undefined;
  source.data = doc.toJS();

  const validate = validatorFor(schemaName);
  if (!validate(source.data)) {
    for (const err of validate.errors ?? []) {
      const parts = pointerToPath(err.instancePath);
      if (err.keyword === 'additionalProperties') {
        parts.push(String(err.params.additionalProperty));
        report(source, rel, parts, `unknown key "${err.params.additionalProperty}"`, { key: true });
      } else if (err.keyword === 'propertyNames') {
        parts.push(String(err.params.propertyName));
        report(source, rel, parts, `invalid key "${err.params.propertyName}" (${err.message})`, { key: true });
      } else if (err.keyword === 'required') {
        report(source, rel, parts, `missing required key "${err.params.missingProperty}"`);
      } else {
        report(source, rel, parts, err.message ?? 'schema error');
      }
    }
    return undefined;
  }
  return source;
}

/** @type {Record<string, Source | undefined>} */
const single = {};
const SINGLE_FILES = {
  weights: 'weights.yaml',
  roles: 'roles.yaml',
  tactics: 'tactics.yaml',
  injuries: 'injuries.yaml',
  officiating: 'officiating.yaml',
  aiCoach: 'ai_coach.yaml',
  events: 'events.yaml',
  xg: 'xg.yaml',
  playback: 'playback.yaml',
  targets: 'calibration/targets.yaml',
  scenarios: 'calibration/scenarios.yaml',
};
const SCHEMA_OF = {
  aiCoach: 'ai_coach',
  targets: 'targets',
  scenarios: 'scenarios',
};
for (const [key, rel] of Object.entries(SINGLE_FILES)) {
  single[key] = load(rel, /** @type {Record<string, string>} */ (SCHEMA_OF)[key] ?? key);
}
// Optional: coach shouts (without the file a match has no shouts).
if (existsSync(path.join(configDir, 'shouts.yaml'))) single.shouts = load('shouts.yaml', 'shouts');

/** @type {Record<string, Source | undefined>} */
const commentary = {};
/** @type {Record<string, Source | undefined>} */
const uiStrings = {};
for (const locale of LOCALES) {
  commentary[locale] = load(`commentary/${locale}.yaml`, 'commentary');
  uiStrings[locale] = load(`ui-strings/${locale}.yaml`, 'ui-strings');
}
/** @type {Record<string, Source | undefined>} */
const squads = {};
for (const file of listYaml(path.join(configDir, 'squads'))) {
  squads[file.replace(/\.yaml$/, '')] = load(`squads/${file}`, 'squad');
}

// ---------------------------------------------------------------------------
// 2. Cross-checks (only on files that passed the schema).
// ---------------------------------------------------------------------------

/**
 * @param {Source | undefined} source
 * @returns {any}
 */
const dataOf = (source) => source?.data;

const events = dataOf(single.events);
const tactics = dataOf(single.tactics);
const roles = dataOf(single.roles);
const targets = dataOf(single.targets);

if (events) {
  const types = events.types;
  const metricNames = new Set([...(events.derived ?? []), ...(events.matchLevel ?? [])]);
  for (const [type, def] of Object.entries(/** @type {Record<string, any>} */ (types))) {
    def.stats.forEach((/** @type {any} */ stat, /** @type {number} */ i) => {
      metricNames.add(stat.metric);
      const at = ['types', type, 'stats', i];
      if (stat.incFrom !== undefined && def.meta[stat.incFrom] !== 'number') {
        report(single.events, 'events.yaml', [...at, 'incFrom'], `incFrom "${stat.incFrom}" is not a number field of meta`);
      }
      for (const [field, wanted] of Object.entries(/** @type {Record<string, any>} */ (stat.when ?? {}))) {
        const meta = def.meta[field];
        if (meta === undefined) {
          report(single.events, 'events.yaml', [...at, 'when', field], `when field "${field}" is not in meta`, { key: true });
        } else if (typeof meta === 'object') {
          for (const value of [wanted].flat()) {
            if (!meta.values.includes(value)) {
              report(single.events, 'events.yaml', [...at, 'when', field], `"${value}" is not one of ${meta.values.join(', ')}`);
            }
          }
        }
      }
    });
  }
  for (const m of targets?.metrics ?? []) {
    if (m.hard && !metricNames.has(m.id)) {
      const idx = targets.metrics.indexOf(m);
      report(single.targets, 'calibration/targets.yaml', ['metrics', idx, 'id'], `hard metric "${m.id}" is not defined in events.yaml (stats, derived or matchLevel)`);
    }
  }
}

if (tactics && roles) {
  for (const [id, formation] of Object.entries(/** @type {Record<string, any>} */ (tactics.formations))) {
    formation.slots.forEach((/** @type {any} */ slot, /** @type {number} */ i) => {
      if (!(slot.role in roles.roles)) {
        report(single.tactics, 'tactics.yaml', ['formations', id, 'slots', i, 'role'], `role "${slot.role}" is not defined in roles.yaml`);
      }
    });
    if (formation.slots[0]?.role !== 'GK') {
      report(single.tactics, 'tactics.yaml', ['formations', id, 'slots', 0, 'role'], 'the first slot must be the goalkeeper (GK)');
    }
    for (const [size, target] of Object.entries(/** @type {Record<string, string>} */ (formation.reducedTo))) {
      const wanted = size === 'ten' ? 10 : 9;
      if (!(target in tactics.formations)) {
        report(single.tactics, 'tactics.yaml', ['formations', id, 'reducedTo', size], `unknown formation "${target}"`);
      } else if (tactics.formations[target].slots.length !== wanted) {
        report(single.tactics, 'tactics.yaml', ['formations', id, 'reducedTo', size], `formation "${target}" has ${tactics.formations[target].slots.length} slots, expected ${wanted}`);
      }
    }
  }
  for (const [size, target] of Object.entries(/** @type {Record<string, string>} */ (tactics.emergencyShape))) {
    if (!(target in tactics.formations)) {
      report(single.tactics, 'tactics.yaml', ['emergencyShape', size], `unknown formation "${target}"`);
    }
  }
}

const injuries = dataOf(single.injuries);
if (injuries) {
  const total = Object.values(/** @type {Record<string, number>} */ (injuries.levelSplit)).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-9) {
    report(single.injuries, 'injuries.yaml', ['levelSplit'], `level probabilities sum to ${total}, expected 1`);
  }
}

// Team instructions: each default option is {} (an exact no-op), every other option sets known knobs and declares
// the trade-off (an upside and a downside metric) the instructions calibration cohort checks.
if (tactics?.instructions) {
  for (const [id, def] of Object.entries(/** @type {Record<string, any>} */ (tactics.instructions))) {
    const at = ['instructions', id];
    if (!(def.default in def.options)) {
      report(single.tactics, 'tactics.yaml', [...at, 'default'], `default "${def.default}" is not one of the options`);
      continue;
    }
    for (const [opt, body] of Object.entries(/** @type {Record<string, any>} */ (def.options))) {
      if (opt === def.default) {
        if (Object.keys(body).length > 0) report(single.tactics, 'tactics.yaml', [...at, 'options', opt], `the default option "${opt}" must be {} (an exact no-op)`);
        continue;
      }
      if (!body.knobs) report(single.tactics, 'tactics.yaml', [...at, 'options', opt], `option "${opt}" sets no knobs`);
      for (const knob of Object.keys(body.knobs ?? {})) {
        if (!(knob in KNOBS)) report(single.tactics, 'tactics.yaml', [...at, 'options', opt, 'knobs', knob], `unknown knob "${knob}" (see KNOBS in src/engine/tactics/Instructions.js)`, { key: true });
      }
      for (const side of ['upside', 'downside']) {
        if (!body[side]) report(single.tactics, 'tactics.yaml', [...at, 'options', opt], `option "${opt}" declares no ${side}`);
        else if (!TRADEOFF_METRICS.includes(body[side].metric)) report(single.tactics, 'tactics.yaml', [...at, 'options', opt, side, 'metric'], `unknown metric "${body[side].metric}" (one of ${TRADEOFF_METRICS.join(', ')})`);
      }
    }
  }
}

const aiCoach = dataOf(single.aiCoach);
if (aiCoach && tactics) {
  for (const [where, id] of [['losingLate', aiCoach.losingLate.formationId], ['redCard', aiCoach.redCard.formationId]]) {
    if (!(id in tactics.formations)) {
      report(single.aiCoach, 'ai_coach.yaml', [where, 'formationId'], `unknown formation "${id}"`);
    }
  }
}

// AI instruction rules name real instructions and options.
if (aiCoach?.instructions && tactics) {
  aiCoach.instructions.rules.forEach((/** @type {any} */ rule, /** @type {number} */ i) => {
    for (const [id, option] of Object.entries(/** @type {Record<string, string>} */ (rule.set))) {
      const def = tactics.instructions?.[id];
      if (!def) report(single.aiCoach, 'ai_coach.yaml', ['instructions', 'rules', i, 'set', id], `unknown instruction "${id}"`, { key: true });
      else if (!(option in def.options)) report(single.aiCoach, 'ai_coach.yaml', ['instructions', 'rules', i, 'set', id], `"${option}" is not an option of ${id}`);
    }
  });
}

const scenarios = dataOf(single.scenarios);
if (scenarios && tactics) {
  for (const [scenario, sides] of Object.entries(/** @type {Record<string, any>} */ (scenarios.formations))) {
    for (const [side, id] of Object.entries(/** @type {Record<string, string>} */ (sides))) {
      if (!(id in tactics.formations)) {
        report(single.scenarios, 'calibration/scenarios.yaml', ['formations', scenario, side], `unknown formation "${id}"`);
      }
    }
  }
}

if (events && tactics && roles) {
  for (const [name, source] of Object.entries(squads)) {
    const squad = dataOf(source);
    if (!squad) continue;
    const rel = `squads/${name}.yaml`;
    const formation = tactics.formations[squad.formationId];
    if (!formation) {
      report(source, rel, ['formationId'], `unknown formation "${squad.formationId}"`);
    }
    if (squad.players[0]?.role !== 'GK') {
      report(source, rel, ['players', 0, 'role'], 'players[0] must be a goalkeeper (GK)');
    }
    const ids = new Set();
    const numbers = new Set();
    squad.players.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
      if (ids.has(p.id)) report(source, rel, ['players', i, 'id'], `duplicate player id "${p.id}"`);
      if (numbers.has(p.number)) report(source, rel, ['players', i, 'number'], `duplicate shirt number ${p.number}`);
      ids.add(p.id);
      numbers.add(p.number);
      if (formation && i < formation.slots.length && formation.slots[i].role !== p.role) {
        report(source, rel, ['players', i, 'role'], `starter ${i} is ${p.role} but slot ${i} of ${squad.formationId} is ${formation.slots[i].role}`);
      }
    });
  }
}

// Commentary: every type has templates in every locale; every token fits its event type.
if (events) {
  const types = /** @type {Record<string, any>} */ (events.types);
  /** @type {Record<string, any>} */
  const counts = {};
  for (const locale of LOCALES) {
    const source = commentary[locale];
    const file = dataOf(source);
    if (!file) continue;
    const rel = `commentary/${locale}.yaml`;
    counts[locale] = {};
    for (const type of Object.keys(types)) {
      if (!(type in file)) {
        report(source, rel, [], `no templates for event type ${type}`);
      }
    }
    for (const [type, list] of Object.entries(/** @type {Record<string, string[]>} */ (file))) {
      const def = types[type];
      if (!def) {
        report(source, rel, [type], `unknown event type ${type}`, { key: true });
        continue;
      }
      counts[locale][type] = list.length;
      if (strictI18n && list.length < def.minVariations) {
        report(source, rel, [type], `${type} has ${list.length} variation(s), needs at least ${def.minVariations}`);
      }
      list.forEach((src, i) => {
        for (const token of Template.compile(src).tokens) {
          const at = [type, i];
          if (token.kind === 'unknown') {
            report(source, rel, at, `unknown token {${token.raw}}`);
          } else if (token.kind === 'meta' && !(token.field in def.meta)) {
            report(source, rel, at, `token {meta.${token.field}} is not a meta field of ${type}`);
          } else if ((token.kind === 'field' || token.kind === 'gender') && token.ns === 'player' && !def.actors.includes('actor')) {
            report(source, rel, at, `token {player.*} needs an actor, but ${type} has none`);
          } else if ((token.kind === 'field' || token.kind === 'gender') && token.ns === 'player2' && !def.actors.includes('secondary')) {
            report(source, rel, at, `token {player2.*} needs a secondary participant, but ${type} has none`);
          }
        }
      });
    }
  }
  if (strictI18n) {
    const [first, ...rest] = LOCALES;
    for (const type of Object.keys(types)) {
      for (const locale of rest) {
        if (counts[first]?.[type] !== undefined && counts[locale]?.[type] !== undefined && counts[first][type] !== counts[locale][type]) {
          report(commentary[locale], `commentary/${locale}.yaml`, [type], `${type} has ${counts[locale][type]} variation(s) in ${locale} but ${counts[first][type]} in ${first}`);
        }
      }
    }
  }
}

// Coach shouts: roles exist; knobs are known and compose by mul or add (a shout's effect is scaled by its share).
const shouts = dataOf(single.shouts);
if (shouts && roles) {
  for (const [id, def] of Object.entries(/** @type {Record<string, any>} */ (shouts.shouts))) {
    const at = ['shouts', id];
    def.roles.forEach((/** @type {string} */ role, /** @type {number} */ i) => {
      if (!(role in roles.roles)) report(single.shouts, 'shouts.yaml', [...at, 'roles', i], `role "${role}" is not defined in roles.yaml`);
    });
    for (const knob of Object.keys(def.knobs)) {
      const k = /** @type {Record<string, {compose: string}>} */ (KNOBS)[knob];
      if (!k) report(single.shouts, 'shouts.yaml', [...at, 'knobs', knob], `unknown knob "${knob}" (see KNOBS in src/engine/tactics/Instructions.js)`, { key: true });
      else if (k.compose === 'min') report(single.shouts, 'shouts.yaml', [...at, 'knobs', knob], `knob "${knob}" composes by min; a shout can only use mul or add knobs`, { key: true });
    }
    if (def.prefer === 'discipline' && def.otherWeight === undefined) report(single.shouts, 'shouts.yaml', at, `shout "${id}" prefers discipline but sets no otherWeight`);
  }
}

// UI strings: every coach shout has a label and a hint, and the panel its strings, in every locale.
if (shouts) {
  for (const locale of LOCALES) {
    const data = dataOf(uiStrings[locale]);
    if (!data) continue;
    for (const key of shoutStringKeys(shouts)) {
      if (typeof data.shouts?.[key] !== 'string') report(uiStrings[locale], `ui-strings/${locale}.yaml`, data.shouts ? ['shouts'] : [], `missing shouts key "${key}"`);
    }
  }
}

// UI strings: every team instruction, option and hint has a label in every locale.
if (tactics?.instructions) {
  for (const locale of LOCALES) {
    const data = dataOf(uiStrings[locale]);
    if (!data) continue;
    for (const key of instructionStringKeys(tactics.instructions)) {
      if (typeof data.tactics?.[key] !== 'string') report(uiStrings[locale], `ui-strings/${locale}.yaml`, data.tactics ? ['tactics'] : [], `missing tactics key "${key}"`);
    }
  }
}

// UI strings: both locales define the same keys.
{
  const [first, ...rest] = LOCALES;
  const base = dataOf(uiStrings[first]);
  if (base) {
    for (const locale of rest) {
      const other = dataOf(uiStrings[locale]);
      if (!other) continue;
      for (const group of Object.keys(base)) {
        for (const key of Object.keys(base[group])) {
          if (!(key in other[group])) {
            report(uiStrings[locale], `ui-strings/${locale}.yaml`, [group], `missing key "${key}" (present in ${first})`);
          }
        }
        for (const key of Object.keys(other[group])) {
          if (!(key in base[group])) {
            report(uiStrings[locale], `ui-strings/${locale}.yaml`, [group, key], `key "${key}" is not in ${first}`, { key: true });
          }
        }
      }
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) {
    console.error(`${p.file}:${p.line}:${p.col}: error: ${p.message}`);
  }
  console.error(`\nbuild-config failed with ${problems.length} error(s).`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Emit generated/*.
// ---------------------------------------------------------------------------

const config = {
  weights: single.weights?.data,
  roles: roles.roles,
  tactics,
  injuries,
  officiating: single.officiating?.data,
  aiCoach,
  ...(shouts ? { shouts } : {}),
  events,
  xg: single.xg?.data,
  playback: single.playback?.data,
  calibration: { targets, scenarios },
  commentary: Object.fromEntries(LOCALES.map((l) => [l, commentary[l]?.data])),
  uiStrings: Object.fromEntries(LOCALES.map((l) => [l, uiStrings[l]?.data])),
};

const configHash = await sha256Hex(canonicalJson(config));
const configHash8 = configHash.slice(0, 8);

const banner = '// Generated by scripts/build-config.mjs. Do not edit by hand.\n';
const freezeHelper = `/** @param {any} value */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, 'squads'), { recursive: true });

writeFileSync(
  path.join(outDir, 'config.js'),
  `${banner}${freezeHelper}
export const config = deepFreeze(${JSON.stringify(config, null, 2)});
export const configHash = ${JSON.stringify(configHash)};
export const configHash8 = ${JSON.stringify(configHash8)};
export default config;
`,
);

const eventTypes = Object.fromEntries(Object.keys(events.types).map((t) => [t, t]));
writeFileSync(
  path.join(outDir, 'events.js'),
  `${banner}${freezeHelper}
export const EventType = deepFreeze(${JSON.stringify(eventTypes, null, 2)});
export const eventMeta = deepFreeze(${JSON.stringify(events.types, null, 2)});
`,
);

for (const [name, source] of Object.entries(squads)) {
  const squadData = source?.data
    ? {
        ...source.data,
        players: source.data.players.map((/** @type {any} */ p) => ({
          ...p,
          shortName: p.shortName || formatShortName(p.name),
        })),
      }
    : source?.data;
  writeFileSync(
    path.join(outDir, 'squads', `${name}.js`),
    `${banner}${freezeHelper}
export default deepFreeze(${JSON.stringify(squadData, null, 2)});
`,
  );
}

// Golden hashes for #bench, copied from the test fixtures so test files stay out of the app bundle.
const goldenPath = path.join(repoRoot, 'tests', 'golden', 'seeds.json');
const goldenFile = existsSync(goldenPath) ? JSON.parse(readFileSync(goldenPath, 'utf8')) : null;
const golden = goldenFile
  ? {
      everyTicks: goldenFile.everyTicks,
      commandLog: goldenFile.commandLog ?? [],
      seeds: goldenFile.seeds.map((/** @type {any} */ s) => ({ seed: s.seed, hashes: s.hashes, final: s.final })),
    }
  : { everyTicks: 0, commandLog: [], seeds: [] };
writeFileSync(
  path.join(outDir, 'golden.js'),
  `${banner}${freezeHelper}
export const golden = deepFreeze(${JSON.stringify(golden, null, 2)});
export default golden;
`,
);

console.log(`build-config: ok (configHash8 ${configHash8}, ${Object.keys(events.types).length} event types, ${Object.keys(squads).length} squads) -> ${path.relative(process.cwd(), outDir) || '.'}`);

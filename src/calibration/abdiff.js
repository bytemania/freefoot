// Same-seed A/B diff (scripts/ab-diff.mjs): play one seed twice, once with the shipped config and
// once with weight overrides, and report where and how the two matches part. Tooling only; it
// never touches the engine's behaviour.
import { MatchEngine } from '../engine/MatchEngine.js';
import { generateRatedSquad } from '../shared/squadgen.js';
import { matchDiagnostics } from './diagnostics.js';

/**
 * Where a dotted path may start, in order: the config itself (`weights.decision.w.shot.boxFree`),
 * the weights file (`decision.w.shot.boxFree`), then its `decision` section (`w.shot.boxFree`).
 */
const ROOTS = Object.freeze([[], ['weights'], ['weights', 'decision']]);

/**
 * @param {string} text `dot.path=value`
 * @returns {{path: string, value: number | string | boolean}}
 */
export function parseOverride(text) {
  const eq = text.indexOf('=');
  if (eq <= 0 || eq === text.length - 1) throw new Error(`override "${text}" must look like dot.path=value`);
  const raw = text.slice(eq + 1);
  /** @type {number | string | boolean} */
  let value = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'number' || typeof parsed === 'boolean') value = parsed;
  } catch {
    // keep the raw string
  }
  return { path: text.slice(0, eq), value };
}

/**
 * A deep clone of `config` (so the frozen original is never touched) with each override applied.
 * A leaf that is a `{value, initial}` weight node has its `value` replaced.
 * @param {any} config compiled config (generated/config.js)
 * @param {Array<{path: string, value: number | string | boolean}>} overrides
 * @returns {{config: any, applied: Array<{path: string, resolved: string, from: any, to: any}>}}
 */
export function applyOverrides(config, overrides) {
  const clone = structuredClone(config);
  /** @type {Array<{path: string, resolved: string, from: any, to: any}>} */
  const applied = [];
  for (const { path, value } of overrides) {
    const parts = path.split('.');
    let done = false;
    for (const root of ROOTS) {
      /** @type {any} */
      let node = clone;
      for (const key of [...root, ...parts.slice(0, -1)]) node = node !== null && typeof node === 'object' ? node[key] : undefined;
      const leafKey = parts[parts.length - 1];
      if (node === null || typeof node !== 'object' || !(leafKey in node)) continue;
      const leaf = node[leafKey];
      const isWeight = leaf !== null && typeof leaf === 'object' && 'value' in leaf;
      const from = isWeight ? leaf.value : leaf;
      if (from !== null && typeof from === 'object') continue; // a section, not a value
      if (typeof from !== typeof value) throw new Error(`override ${path}: expected a ${typeof from}, got ${typeof value}`);
      if (isWeight) leaf.value = value;
      else node[leafKey] = value;
      applied.push({ path, resolved: [...root, ...parts].join('.'), from, to: value });
      done = true;
      break;
    }
    if (!done) throw new Error(`override ${path}: no such config value (tried ${ROOTS.map((r) => [...r, ...parts].join('.')).join(', ')})`);
  }
  return { config: clone, applied };
}

/**
 * A cheap per-tick fingerprint of the moving state (ball and every player position and velocity,
 * plus the score), so the first tick where two runs differ can be found without a full hash.
 * @param {import('../engine/state/MatchState.js').MatchState} s
 * @returns {number}
 */
export function fingerprint(s) {
  let h = 0x811c9dc5;
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  /** @param {number} v */
  const mix = (v) => {
    f64[0] = v;
    h = Math.imul(h ^ u32[0], 0x01000193);
    h = Math.imul(h ^ u32[1], 0x01000193);
  };
  mix(s.ball.x);
  mix(s.ball.y);
  mix(s.ball.vx);
  mix(s.ball.vy);
  for (const p of s.players) {
    mix(p.x);
    mix(p.y);
    mix(p.vx);
    mix(p.vy);
  }
  mix(s.teams[0].score);
  mix(s.teams[1].score);
  return h >>> 0;
}

/**
 * Plays one AI-v-AI match of the even cohort (80 OVR v 80 OVR, as in calibration) to full time or
 * `maxTicks`, recording a fingerprint per tick.
 * @param {any} config
 * @param {number} seed
 * @param {{configHash: string, maxTicks?: number}} opts
 */
export function playTrace(config, seed, { configHash, maxTicks = Infinity }) {
  const home = generateRatedSquad(80, (seed ^ 0xa5a5a5a5) >>> 0, config, { side: 'home', morale: 75 });
  const away = generateRatedSquad(80, (seed ^ 0x5a5a5a5a) >>> 0, config, { side: 'away', morale: 75 });
  const engine = MatchEngine.create({ v: 1, seed, configHash, home, away }, config);
  /** @type {number[]} */
  const prints = [];
  while (engine.tick < maxTicks) {
    const r = engine.step(1);
    if (r.stoppedFor === 'FULL_TIME' || r.stoppedFor === 'FORCED_DECISION') break;
    prints.push(fingerprint(engine.state));
  }
  return { engine, prints };
}

/**
 * @param {{type: string, tick: number, teamIndex: number, actorIndex?: number}} a
 * @param {{type: string, tick: number, teamIndex: number, actorIndex?: number} | undefined} b
 */
function sameEvent(a, b) {
  return b !== undefined && a.type === b.type && a.tick === b.tick && a.teamIndex === b.teamIndex && a.actorIndex === b.actorIndex;
}

/**
 * @param {{engine: MatchEngine}} run
 */
function summarize(run) {
  const d = matchDiagnostics(run.engine.eventLog);
  const both = (/** @type {string} */ k) => d.home[k] + d.away[k];
  /** @type {Record<string, number>} */
  const stats = {
    shots: both('shots'),
    shotsOnTarget: both('shotsOnTarget'),
    passes: both('passes'),
    passCompletionPct: both('passes') > 0 ? (100 * both('passesCompleted')) / both('passes') : 0,
    interceptions: both('interceptions'),
    miscontrols: both('miscontrols'),
    fouls: run.engine.eventLog.filter((e) => e.type === 'FOUL').length,
    throwIns: both('throwIns'),
    xG: both('xG'),
  };
  return { score: [run.engine.state.teams[0].score, run.engine.state.teams[1].score], stats };
}

/**
 * Plays baseline and overridden configs on one seed and compares them.
 * @param {object} opts
 * @param {any} opts.config baseline compiled config
 * @param {string} opts.configHash
 * @param {number} opts.seed
 * @param {Array<{path: string, value: number | string | boolean}>} opts.overrides
 * @param {number} [opts.maxTicks]
 */
export function abDiff({ config, configHash, seed, overrides, maxTicks }) {
  const { config: variant, applied } = applyOverrides(config, overrides);
  const a = playTrace(config, seed, { configHash, maxTicks });
  const b = playTrace(variant, seed, { configHash, maxTicks });
  const n = Math.min(a.prints.length, b.prints.length);
  let firstDivergenceTick = -1;
  for (let i = 0; i < n; i++) {
    if (a.prints[i] !== b.prints[i]) {
      firstDivergenceTick = i + 1;
      break;
    }
  }
  if (firstDivergenceTick === -1 && a.prints.length !== b.prints.length) firstDivergenceTick = n + 1;
  const logA = a.engine.eventLog;
  const logB = b.engine.eventLog;
  let firstEventDiff = -1;
  for (let i = 0; i < Math.max(logA.length, logB.length); i++) {
    if (!sameEvent(logA[i], logB[i])) {
      firstEventDiff = i;
      break;
    }
  }
  const sa = summarize(a);
  const sb = summarize(b);
  const hashA = a.engine.hash();
  const hashB = b.engine.hash();
  return {
    seed,
    applied,
    ticks: [a.engine.tick, b.engine.tick],
    firstDivergenceTick,
    firstEventDiff,
    eventsA: firstEventDiff < 0 ? [] : logA.slice(firstEventDiff, firstEventDiff + 5),
    eventsB: firstEventDiff < 0 ? [] : logB.slice(firstEventDiff, firstEventDiff + 5),
    baseline: sa,
    variant: sb,
    hashes: [hashA, hashB],
    identical: firstDivergenceTick === -1 && hashA === hashB,
  };
}

/**
 * @param {ReturnType<typeof abDiff>} r
 * @returns {string}
 */
export function formatAbDiff(r) {
  const L = [];
  L.push(`# A/B diff, seed ${r.seed}`, '');
  for (const o of r.applied) L.push(`- override \`${o.resolved}\`: ${o.from} -> ${o.to}`);
  if (r.applied.length === 0) L.push('- no overrides (baseline against itself)');
  L.push('');
  L.push(`State hash: ${r.hashes[0].toString(16).padStart(8, '0')} vs ${r.hashes[1].toString(16).padStart(8, '0')} (${r.hashes[0] === r.hashes[1] ? 'equal' : 'different'})`);
  L.push(r.firstDivergenceTick < 0 ? 'First divergence: none, the runs are identical tick for tick' : `First divergence: tick ${r.firstDivergenceTick}`);
  if (r.firstEventDiff >= 0) {
    const show = (/** @type {any[]} */ evs) => (evs.length === 0 ? '(no more events)' : evs.map((e) => `${e.type}@${e.tick}`).join(' '));
    L.push(`First differing event: #${r.firstEventDiff}`, `  baseline: ${show(r.eventsA)}`, `  variant:  ${show(r.eventsB)}`);
  }
  L.push('', `Score: ${r.baseline.score.join('-')} vs ${r.variant.score.join('-')}`, '');
  L.push('| Stat (both sides) | Baseline | Variant | Delta |', '| :--- | ---: | ---: | ---: |');
  for (const k of Object.keys(r.baseline.stats)) {
    const x = r.baseline.stats[k];
    const y = r.variant.stats[k];
    L.push(`| ${k} | ${+x.toFixed(2)} | ${+y.toFixed(2)} | ${y - x >= 0 ? '+' : ''}${(y - x).toFixed(2)} |`);
  }
  return L.join('\n') + '\n';
}

/**
 * Instructions calibration cohort (scripts/calibrate-instructions.mjs, docs/designs/tactics_instructions.md).
 *
 * Even 80 v 80 OVR AI matches. For each non-default option of each team instruction, every seed is played twice:
 * once with the option on the home side and once on the away side, the other side on defaults (swapping sides
 * cancels the squads' differences). Per match the paired difference d = metric(option side) - metric(default side)
 * is taken, and two gates apply:
 *
 *  1. balance: |mean goal difference| <= GD_CAP (no option is a free win);
 *  2. trade-off: the option's declared `upside` and `downside` metrics (config/tactics.yaml) each move in the
 *     declared direction with z = mean(d) / (sd(d) / sqrt(n)) >= Z_MIN.
 *
 * Pure (no Node APIs) so it can be unit tested and imported by build-config.
 */

/** Cap on the mean goal difference per match (option side minus default side). */
export const GD_CAP = 0.15;
/** Minimum paired z of a declared upside or downside, in the declared direction. */
export const Z_MIN = 2;

/** Lateral distance from the centre line (metres) within which a pass is played from the central channel. */
const CENTRAL_CHANNEL = 12;
/** Lateral distance beyond which it is played from a wide channel. */
const WIDE_CHANNEL = 20;
const GOAL_Y = 34;

/**
 * Per-team metrics an option's trade-off may name. `opp*` and `*Won` / `*Suffered` metrics describe what the
 * opponent does against the team.
 */
export const TRADEOFF_METRICS = Object.freeze([
  'goals',
  'xG',
  'shots',
  'oppShots',
  'oppXG',
  'possession',
  'passCompletion',
  'oppPassCompletion',
  'progressivePasses',
  'crosses',
  'centralPassShare',
  'widePassShare',
  'interceptionsSuffered',
  'offsidesWon',
  'oppThroughCompleted',
  'oppDribblesWon',
  'fouls',
  'yellowCards',
  'tacklesWon',
  'highRegains',
  'fitness',
  'deadBallLeading',
]);

/** @param {string} s */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The `tactics` UI-string keys the instructions need: `<id>`, `<id><Option>` and `<id><Option>Hint`.
 * @param {Record<string, any>} cfg `config.tactics.instructions`
 * @returns {string[]}
 */
export function instructionStringKeys(cfg) {
  const keys = [];
  for (const [id, def] of Object.entries(cfg)) {
    keys.push(id);
    for (const opt of Object.keys(def.options)) keys.push(`${id}${cap(opt)}`, `${id}${cap(opt)}Hint`);
  }
  return keys;
}

/**
 * @typedef {{id: string, instruction: string, option: string, upside: {metric: string, dir: 'up' | 'down'}, downside: {metric: string, dir: 'up' | 'down'}}} Variant
 */

/**
 * Every non-default option, in config order.
 * @param {Record<string, any>} cfg
 * @returns {Variant[]}
 */
export function instructionVariants(cfg) {
  /** @type {Variant[]} */
  const out = [];
  for (const [instruction, def] of Object.entries(cfg)) {
    for (const [option, body] of Object.entries(/** @type {Record<string, any>} */ (def.options))) {
      if (option === def.default) continue;
      out.push({ id: `${instruction}.${option}`, instruction, option, upside: body.upside, downside: body.downside });
    }
  }
  return out;
}

/**
 * Per-team trade-off metrics of one match.
 * @param {Array<{type: string, teamIndex: number, x: number, y: number, zone: number, meta?: Record<string, any>}>} events
 * @param {[number, number]} score
 * @param {{fitness: [number, number], deadBallLeading: [number, number], possession?: [number, number]}} extras mean
 *   on-pitch fitness at full time, seconds of the team's own dead balls while it led, and share of the time on the
 *   ball (sampled)
 * @returns {[Record<string, number>, Record<string, number>]}
 */
export function teamTradeoffMetrics(events, score, extras) {
  const raw = [0, 1].map(() => ({
    xG: 0, shots: 0, passes: 0, passesCompleted: 0, progressivePasses: 0, crosses: 0, centralPasses: 0, widePasses: 0,
    interceptions: 0, offsides: 0, throughCompleted: 0, dribblesWon: 0, fouls: 0, yellowCards: 0, tacklesWon: 0, highRegains: 0,
  }));
  for (const ev of events) {
    const t = ev.teamIndex;
    if (t !== 0 && t !== 1) continue;
    const r = raw[t];
    const m = ev.meta ?? {};
    switch (ev.type) {
      case 'SHOT':
        r.shots++;
        r.xG += Number(m.xg ?? 0);
        break;
      case 'PASS': {
        r.passes++;
        if (m.completed === true) r.passesCompleted++;
        if (m.kind === 'THROUGH' || m.kind === 'LONG') r.progressivePasses++;
        if (m.kind === 'THROUGH' && m.completed === true) r.throughCompleted++;
        const lateral = Math.abs(ev.y - GOAL_Y);
        if (lateral < CENTRAL_CHANNEL) r.centralPasses++;
        else if (lateral > WIDE_CHANNEL) r.widePasses++;
        break;
      }
      case 'CROSS':
        r.crosses++;
        break;
      case 'DRIBBLE':
        if (m.won === true) r.dribblesWon++;
        break;
      case 'INTERCEPTION':
        r.interceptions++;
        if (ev.zone >= 10) r.highRegains++;
        break;
      case 'RECOVERY':
        if (ev.zone >= 10) r.highRegains++;
        break;
      case 'TACKLE':
        if (m.won === true) {
          r.tacklesWon++;
          if (ev.zone >= 10) r.highRegains++;
        }
        break;
      case 'OFFSIDE':
        r.offsides++;
        break;
      case 'FOUL':
        r.fouls++;
        break;
      case 'YELLOW_CARD':
        r.yellowCards++;
        break;
      default:
    }
  }
  const ratio = (/** @type {number} */ a, /** @type {number} */ b) => (b > 0 ? a / b : 0);
  return /** @type {[Record<string, number>, Record<string, number>]} */ (
    /** @type {unknown} */ ([0, 1].map((t) => {
      const own = raw[t];
      const opp = raw[1 - t];
      return {
        goals: score[t],
        xG: own.xG,
        oppXG: opp.xG,
        possession: extras.possession?.[t] ?? 0,
        shots: own.shots,
        oppShots: opp.shots,
        passCompletion: ratio(own.passesCompleted, own.passes),
        oppPassCompletion: ratio(opp.passesCompleted, opp.passes),
        progressivePasses: own.progressivePasses,
        crosses: own.crosses,
        centralPassShare: ratio(own.centralPasses, own.passes),
        widePassShare: ratio(own.widePasses, own.passes),
        interceptionsSuffered: opp.interceptions,
        offsidesWon: opp.offsides,
        oppThroughCompleted: opp.throughCompleted,
        oppDribblesWon: opp.dribblesWon,
        fouls: own.fouls,
        yellowCards: own.yellowCards,
        tacklesWon: own.tacklesWon,
        highRegains: own.highRegains,
        fitness: extras.fitness[t],
        deadBallLeading: extras.deadBallLeading[t],
      };
    }))
  );
}

/** @param {number[]} xs */
function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** @param {number[]} xs */
function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

/**
 * Paired summary of one metric: mean difference, its standard error and z.
 * @param {number[]} diffs
 */
export function paired(diffs) {
  const m = mean(diffs);
  const se = diffs.length > 1 ? sd(diffs) / Math.sqrt(diffs.length) : 0;
  return { mean: m, se, z: se > 0 ? m / se : m === 0 ? 0 : Math.sign(m) * Infinity };
}

/**
 * Evaluates one option from its matches. Each row holds both teams' metrics and the side that played the option.
 * @param {Variant} variant
 * @param {Array<{seed: number, optionSide: 0 | 1, metrics: [Record<string, number>, Record<string, number>]}>} rows
 */
export function evaluateVariant(variant, rows) {
  /** @type {Record<string, ReturnType<typeof paired>>} */
  const effects = {};
  for (const id of TRADEOFF_METRICS) {
    effects[id] = paired(rows.map((r) => r.metrics[r.optionSide][id] - r.metrics[1 - r.optionSide][id]));
  }
  const gd = effects.goals;
  const sideCheck = (/** @type {{metric: string, dir: 'up' | 'down'}} */ t) => {
    const e = effects[t.metric];
    const z = t.dir === 'up' ? e.z : -e.z;
    return { metric: t.metric, dir: t.dir, mean: e.mean, z, pass: z >= Z_MIN };
  };
  const upside = sideCheck(variant.upside);
  const downside = sideCheck(variant.downside);
  const balance = { mean: gd.mean, se: gd.se, cap: GD_CAP, pass: Math.abs(gd.mean) <= GD_CAP };
  return { ...variant, matches: rows.length, effects, balance, upsideCheck: upside, downsideCheck: downside, pass: balance.pass && upside.pass && downside.pass };
}

/** @param {number} v @param {number} [d] */
function fmt(v, d = 3) {
  return Number.isFinite(v) ? v.toFixed(d) : v > 0 ? '+inf' : v < 0 ? '-inf' : '-';
}

/** @param {number} v @param {number} [d] */
function signed(v, d = 3) {
  return `${v >= 0 ? '+' : ''}${fmt(v, d)}`;
}

/** Metrics shown in the per-option effect table. */
const REPORT_METRICS = ['xG', 'oppXG', 'shots', 'oppShots', 'possession', 'passCompletion', 'oppPassCompletion', 'progressivePasses', 'crosses', 'widePassShare', 'centralPassShare', 'interceptionsSuffered', 'offsidesWon', 'oppThroughCompleted', 'oppDribblesWon', 'fouls', 'yellowCards', 'tacklesWon', 'highRegains', 'fitness', 'deadBallLeading'];

/**
 * @param {Array<ReturnType<typeof evaluateVariant>>} results
 * @param {Record<string, any>} [meta]
 * @returns {string}
 */
export function formatInstructionsReport(results, meta = {}) {
  const ok = results.every((r) => r.pass);
  const lines = [];
  lines.push(`# freefoot Instructions Calibration (${ok ? 'PASS' : 'FAIL'})`);
  lines.push('');
  lines.push(`- **Engine version:** ${meta.engineVersion ?? 'unknown'}`);
  lines.push(`- **Config hash:** \`${meta.configHash ?? 'unknown'}\``);
  lines.push(`- **Matches per option:** ${meta.matches ?? '?'} (seeds ${meta.seedStart ?? '?'}..${meta.seedEnd ?? '?'}, each with the option at home and away), 80 v 80 OVR`);
  lines.push(`- **Gates:** |goal difference| <= ${GD_CAP} per match; declared upside and downside each with paired z >= ${Z_MIN}`);
  lines.push('');
  lines.push('| Option | GD (± se) | Upside | z | Downside | z | Status |');
  lines.push('| :--- | ---: | :--- | ---: | :--- | ---: | :---: |');
  for (const r of results) {
    const u = r.upsideCheck;
    const d = r.downsideCheck;
    lines.push(
      `| ${r.id} | ${signed(r.balance.mean, 3)} ± ${fmt(r.balance.se, 3)}${r.balance.pass ? '' : ' ✗'} | ${u.metric} ${u.dir} (${signed(u.mean)}) | ${fmt(u.z, 1)}${u.pass ? '' : ' ✗'} | ${d.metric} ${d.dir} (${signed(d.mean)}) | ${fmt(d.z, 1)}${d.pass ? '' : ' ✗'} | ${r.pass ? 'PASS' : 'FAIL'} |`,
    );
  }
  lines.push('');
  lines.push('Effects per match, option side minus default side (z in brackets; reported, not gated):');
  lines.push('');
  lines.push(`| Option | ${REPORT_METRICS.join(' | ')} |`);
  lines.push(`| :--- | ${REPORT_METRICS.map(() => '---:').join(' | ')} |`);
  for (const r of results) {
    lines.push(`| ${r.id} | ${REPORT_METRICS.map((m) => `${signed(r.effects[m].mean, m === 'fitness' || m === 'possession' || m.endsWith('Share') || m.endsWith('Completion') ? 3 : 2)} (${fmt(r.effects[m].z, 1)})`).join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

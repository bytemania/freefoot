/**
 * Calibration evaluation and reporting (design §18, item 17, item 73).
 *
 * Pure evaluation functions (`evaluateScenarioA`, `evaluateScenarioB`,
 * `evaluateCalibration`, `formatMarkdownReport`) plus `writeReports` for the
 * JSON + Markdown output files under `reports/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mean, summarize } from '../shared/stats.js';

/**
 * Allowed deviation for a reference percentile (design §18a):
 * `max(tolerance * |ref|, toleranceAbs)`.
 * @param {number} ref
 * @param {number} tolerance
 * @param {number} toleranceAbs
 * @returns {number}
 */
export function allowedGap(ref, tolerance, toleranceAbs) {
  return Math.max(tolerance * Math.abs(ref), toleranceAbs);
}

/**
 * Picks the 3 worst seeds for a metric by descending distance from `target`.
 * @param {Array<{seed: number, value: number}>} samples
 * @param {number} target
 * @returns {Array<{seed: number, value: number}>}
 */
function worstSeeds(samples, target) {
  return samples
    .slice()
    .sort((a, b) => Math.abs(b.value - target) - Math.abs(a.value - target) || a.seed - b.seed)
    .slice(0, 3);
}

/**
 * Evaluates Scenario A (balanced squads) against `targets.metrics`.
 * @param {Array<{seed: number, home: Record<string, number>, away: Record<string, number>, absurdTicks?: number}>} matches
 * @param {{metrics: any[]}} targets
 */
export function evaluateScenarioA(matches, targets) {
  const results = [];
  let hardPass = true;

  for (const spec of targets.metrics) {
    if (spec.unit !== 'perTeam') continue;
    /** @type {number[]} */
    const values = [];
    /** @type {Array<{seed: number, value: number}>} */
    const samples = [];
    for (const m of matches) {
      const hv = m.home[spec.id] ?? 0;
      const av = m.away[spec.id] ?? 0;
      values.push(hv, av);
      samples.push({ seed: m.seed, value: hv }, { seed: m.seed, value: av });
    }
    const stats = summarize(values);
    const ref = spec.reference ?? {};
    const bandA = spec.bandA;

    let meanOk = true;
    if (Array.isArray(bandA)) {
      meanOk = stats.mean >= bandA[0] && stats.mean <= bandA[1];
    }

    let p10Ok = true;
    let p90Ok = true;
    let p10Gap = null;
    let p90Gap = null;
    if (spec.hard && typeof ref.p10 === 'number' && typeof spec.tolerance === 'number' && typeof spec.toleranceAbs === 'number') {
      p10Gap = allowedGap(ref.p10, spec.tolerance, spec.toleranceAbs);
      p10Ok = Math.abs(stats.p10 - ref.p10) <= p10Gap;
    }
    if (spec.hard && typeof ref.p90 === 'number' && typeof spec.tolerance === 'number' && typeof spec.toleranceAbs === 'number') {
      p90Gap = allowedGap(ref.p90, spec.tolerance, spec.toleranceAbs);
      p90Ok = Math.abs(stats.p90 - ref.p90) <= p90Gap;
    }

    const pass = spec.hard ? meanOk && p10Ok && p90Ok : meanOk;
    if (spec.hard && !pass) hardPass = false;

    const targetMid = Array.isArray(bandA) ? (bandA[0] + bandA[1]) / 2 : (ref.mean ?? stats.mean);
    results.push({
      id: spec.id,
      layer: spec.layer,
      hard: spec.hard,
      bandA,
      mean: stats.mean,
      p10: stats.p10,
      p90: stats.p90,
      refMean: ref.mean ?? null,
      refP10: ref.p10 ?? null,
      refP90: ref.p90 ?? null,
      p10Gap,
      p90Gap,
      meanOk,
      p10Ok,
      p90Ok,
      pass,
      worst: !pass && spec.hard ? worstSeeds(samples, targetMid) : [],
    });
  }

  // Soft match-level checks (design §18).
  const goalsPerMatch = matches.map((m) => (m.home.goals ?? 0) + (m.away.goals ?? 0));
  const draws = matches.filter((m) => (m.home.goals ?? 0) === (m.away.goals ?? 0)).length;
  const zeroZeros = matches.filter((m) => (m.home.goals ?? 0) === 0 && (m.away.goals ?? 0) === 0).length;
  const homeGoals = mean(matches.map((m) => m.home.goals ?? 0));
  const awayGoals = mean(matches.map((m) => m.away.goals ?? 0));
  const absurdMatches = matches.filter((m) => (m.absurdTicks ?? 0) > 0).length;

  return {
    matchCount: matches.length,
    hardPass,
    metrics: results,
    extras: {
      goalsPerMatch: mean(goalsPerMatch),
      drawRate: matches.length > 0 ? draws / matches.length : 0,
      zeroZeroRate: matches.length > 0 ? zeroZeros / matches.length : 0,
      homeGoalsMean: homeGoals,
      awayGoalsMean: awayGoals,
      absurdMatches,
    },
  };
}

/**
 * Evaluates Scenario B (strong vs weak squads) against `targets.metrics`.
 * Hard checks: strong possessionPct 60-70, strong xG share >= 0.75, strongWinRate 0.70-0.80.
 * @param {Array<{seed: number, strong: Record<string, number>, weak: Record<string, number>, absurdTicks?: number}>} matches
 * @param {{metrics: any[]}} targets
 */
export function evaluateScenarioB(matches, targets) {
  const checks = [];
  let hardPass = true;

  const xgShares = matches.map((m) => {
    const s = m.strong.xG ?? 0;
    const w = m.weak.xG ?? 0;
    return s + w > 0 ? s / (s + w) : 0.5;
  });
  const strongWins = matches.map((m) => ((m.strong.goals ?? 0) > (m.weak.goals ?? 0) ? 1 : 0));

  for (const spec of targets.metrics) {
    const sb = spec.scenarioB ?? {};
    for (const [checkName, rule] of Object.entries(sb)) {
      let value = 0;
      let pass = true;
      let label = `${spec.id}.${checkName}`;
      /** @type {Array<{seed: number, value: number}>} */
      let samples = [];

      if (spec.id === 'strongWinRate' && checkName === 'strong') {
        value = mean(strongWins);
        samples = matches.map((m, i) => ({ seed: m.seed, value: strongWins[i] }));
      } else if (spec.id === 'xG' && checkName === 'strongShare') {
        value = mean(xgShares);
        samples = matches.map((m, i) => ({ seed: m.seed, value: xgShares[i] }));
      } else if (rule.rule === 'weakGreaterThanStrong') {
        const wMean = mean(matches.map((m) => m.weak[spec.id] ?? 0));
        const sMean = mean(matches.map((m) => m.strong[spec.id] ?? 0));
        value = wMean - sMean;
        pass = wMean > sMean;
      } else if (checkName === 'strong') {
        value = mean(matches.map((m) => m.strong[spec.id] ?? 0));
        samples = matches.map((m) => ({ seed: m.seed, value: m.strong[spec.id] ?? 0 }));
      } else if (checkName === 'weak') {
        value = mean(matches.map((m) => m.weak[spec.id] ?? 0));
        samples = matches.map((m) => ({ seed: m.seed, value: m.weak[spec.id] ?? 0 }));
      }

      if (Array.isArray(rule.band)) {
        pass = value >= rule.band[0] && value <= rule.band[1];
      }
      if (rule.hard && !pass) hardPass = false;

      const mid = Array.isArray(rule.band) ? (rule.band[0] + rule.band[1]) / 2 : value;
      checks.push({
        id: spec.id,
        check: checkName,
        label,
        layer: spec.layer,
        hard: Boolean(rule.hard),
        band: rule.band ?? null,
        rule: rule.rule ?? null,
        value,
        pass,
        worst: !pass && rule.hard && samples.length > 0 ? worstSeeds(samples, mid) : [],
      });
    }
  }

  // Per-metric strong/weak summaries for diagnostics.
  const summaries = [];
  for (const spec of targets.metrics) {
    if (spec.unit !== 'perTeam') continue;
    summaries.push({
      id: spec.id,
      layer: spec.layer,
      strong: summarize(matches.map((m) => m.strong[spec.id] ?? 0)),
      weak: summarize(matches.map((m) => m.weak[spec.id] ?? 0)),
    });
  }

  return {
    matchCount: matches.length,
    hardPass,
    checks,
    summaries,
  };
}

/**
 * Evaluates full calibration results and computes the exit code (0 = pass, 1 = fail).
 * @param {{scenarioA?: any[] | null, scenarioB?: any[] | null, targets: {metrics: any[]}, meta?: Record<string, any>}} input
 */
export function evaluateCalibration({ scenarioA = null, scenarioB = null, targets, meta = {} }) {
  const a = scenarioA ? evaluateScenarioA(scenarioA, targets) : null;
  const b = scenarioB ? evaluateScenarioB(scenarioB, targets) : null;
  const ok = (a === null || a.hardPass) && (b === null || b.hardPass);
  return {
    ok,
    exitCode: ok ? 0 : 1,
    meta,
    scenarioA: a,
    scenarioB: b,
  };
}

/** @param {number | null} v @param {number} [d] */
function fmt(v, d = 2) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-';
}

/**
 * Formats a Markdown calibration report grouped by layers L1-L4 (design §18, item 73).
 * @param {ReturnType<typeof evaluateCalibration>} report
 * @returns {string}
 */
export function formatMarkdownReport(report) {
  const lines = [];
  const meta = report.meta ?? {};
  lines.push(`# freefoot Calibration Report (${report.ok ? 'PASS' : 'FAIL'})`);
  lines.push('');
  lines.push(`- **Engine version:** ${meta.engineVersion ?? 'unknown'}`);
  lines.push(`- **Config hash:** \`${meta.configHash ?? 'unknown'}\``);
  lines.push(`- **Seeds:** ${meta.seedStart ?? '?'}..${meta.seedEnd ?? '?'} (${meta.matches ?? '?'} matches/scenario)`);
  lines.push(`- **Date:** ${meta.date ?? new Date().toISOString().slice(0, 10)}`);
  lines.push('');

  const LAYERS = [
    ['L1', 'L1: Physical'],
    ['L2', 'L2: Progression'],
    ['L3', 'L3: Defending'],
    ['L4', 'L4: Chances & Discipline'],
  ];

  if (report.scenarioA) {
    lines.push(`## Scenario A (Balanced, ${report.scenarioA.matchCount} matches) — ${report.scenarioA.hardPass ? 'PASS' : 'FAIL'}`);
    lines.push('');
    for (const [layerId, layerTitle] of LAYERS) {
      const rows = report.scenarioA.metrics.filter((m) => m.layer === layerId);
      if (rows.length === 0) continue;
      lines.push(`### ${layerTitle}`);
      lines.push('| Metric | Gate | Mean | Band | p10 (Ref) | p90 (Ref) | Status |');
      lines.push('| :--- | :---: | ---: | :---: | :---: | :---: | :---: |');
      for (const m of rows) {
        const band = Array.isArray(m.bandA) ? `${m.bandA[0]}–${m.bandA[1]}` : '-';
        const p10s = m.refP10 !== null ? `${fmt(m.p10)} (${fmt(m.refP10)})` : fmt(m.p10);
        const p90s = m.refP90 !== null ? `${fmt(m.p90)} (${fmt(m.refP90)})` : fmt(m.p90);
        const status = m.hard ? (m.pass ? 'PASS' : 'FAIL') : (m.pass ? 'ok' : 'soft');
        lines.push(`| ${m.id} | ${m.hard ? 'HARD' : 'soft'} | ${fmt(m.mean)} | ${band} | ${p10s} | ${p90s} | ${status} |`);
      }
      lines.push('');
    }

    const ex = report.scenarioA.extras;
    lines.push('### Scenario A Match-Level Soft Checks');
    lines.push(`- Goals/match: **${fmt(ex.goalsPerMatch)}** (home ${fmt(ex.homeGoalsMean)} vs away ${fmt(ex.awayGoalsMean)})`);
    lines.push(`- Draw rate: **${fmt(ex.drawRate * 100, 1)}%**, 0–0 rate: **${fmt(ex.zeroZeroRate * 100, 1)}%**`);
    lines.push(`- Absurd-state matches (>30 m from anchor for >20 s): **${ex.absurdMatches}**`);
    lines.push('');

    const failingA = report.scenarioA.metrics.filter((m) => m.hard && !m.pass);
    if (failingA.length > 0) {
      lines.push('### Worst Seeds (Scenario A Failures)');
      for (const m of failingA) {
        const w = m.worst.map((x) => `seed ${x.seed} (${fmt(x.value)})`).join(', ');
        lines.push(`- **${m.id}**: ${w}`);
      }
      lines.push('');
    }
  }

  if (report.scenarioB) {
    lines.push(`## Scenario B (Strong vs Weak, ${report.scenarioB.matchCount} matches) — ${report.scenarioB.hardPass ? 'PASS' : 'FAIL'}`);
    lines.push('');
    lines.push('| Check | Gate | Value | Target | Status |');
    lines.push('| :--- | :---: | ---: | :---: | :---: |');
    for (const c of report.scenarioB.checks) {
      const target = Array.isArray(c.band) ? `${c.band[0]}–${c.band[1]}` : (c.rule ?? '-');
      const status = c.hard ? (c.pass ? 'PASS' : 'FAIL') : (c.pass ? 'ok' : 'soft');
      lines.push(`| ${c.label} | ${c.hard ? 'HARD' : 'soft'} | ${fmt(c.value, 3)} | ${target} | ${status} |`);
    }
    lines.push('');

    const failingB = report.scenarioB.checks.filter((c) => c.hard && !c.pass);
    if (failingB.length > 0) {
      lines.push('### Worst Seeds (Scenario B Failures)');
      for (const c of failingB) {
        const w = c.worst.map((x) => `seed ${x.seed} (${fmt(x.value, 3)})`).join(', ');
        lines.push(`- **${c.label}**: ${w}`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('_Reference percentiles derived from StatsBomb Open Data (2015/16 top-five European leagues)._');
  return lines.join('\n') + '\n';
}

/**
 * Writes `reports/calibration-<YYYY-MM-DD>-<configHash8>.json` and `.md`.
 * @param {ReturnType<typeof evaluateCalibration>} report
 * @param {string} reportsDir
 * @returns {{jsonPath: string, mdPath: string}}
 */
export function writeReports(report, reportsDir) {
  mkdirSync(reportsDir, { recursive: true });
  const date = report.meta?.date ?? new Date().toISOString().slice(0, 10);
  const hash8 = report.meta?.configHash8 ?? '00000000';
  const base = `calibration-${date}-${hash8}`;
  const jsonPath = path.join(reportsDir, `${base}.json`);
  const mdPath = path.join(reportsDir, `${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(mdPath, formatMarkdownReport(report));
  return { jsonPath, mdPath };
}

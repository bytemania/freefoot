// Offline xG logistic regression fitter (design item 26, §13).
//
// Usage: node scripts/fit-xg.mjs [<statsbomb-dir>] [--write]
// Reads non-penalty shots from the 2015/16 top-5 league allow-list, fits a
// logistic model by batch gradient descent (lr=0.05, 5000 iters, L2=0.001,
// standardised features), converts coefficients back to raw scale, prints YAML
// for config/xg.yaml, and optionally writes it with --write.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDocument } from 'yaml';
import {
  extractShotFeatures,
  loadAllowListCompetitions,
  loadMatchEvents,
  loadSeasonMatches,
} from './lib/statsbomb.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    write: { type: 'boolean', default: false },
  },
});

const sbDir = path.resolve(positionals[0] ?? path.join(repoRoot, '.cache', 'statsbomb-open-data'));
const { found, missing } = loadAllowListCompetitions(sbDir);
for (const c of found) {
  console.error(`fit-xg: found ${c.competition_name} ${c.season_name} (comp ${c.competition_id}, season ${c.season_id})`);
}
for (const c of missing) {
  console.error(`fit-xg: WARNING missing ${c.label} (comp ${c.competition_id}, season ${c.season_id})`);
}
if (found.length === 0) {
  console.error(`fit-xg: no allow-list competitions found in ${sbDir}`);
  process.exit(1);
}

// Collect raw shot features (excluding period 5 and penalties).
/** @type {number[][]} */
const rawX = [];
/** @type {number[]} */
const rawY = [];
let matchCount = 0;

for (const comp of found) {
  const matches = loadSeasonMatches(sbDir, comp.competition_id, comp.season_id);
  for (const m of matches) {
    const events = loadMatchEvents(sbDir, m.match_id);
    if (!events) continue;
    matchCount++;
    /** @type {Map<string, any>} */
    const eventById = new Map();
    for (let i = 0; i < events.length; i++) {
      if (events[i].id) eventById.set(events[i].id, events[i]);
    }
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.period === 5 || ev.type?.name !== 'Shot') continue;
      const feat = extractShotFeatures(ev, eventById);
      if (feat.isPenalty) continue;
      rawX.push([
        feat.distance,
        feat.angle,
        feat.isHeader ? 1 : 0,
        feat.defendersInCone,
        feat.assistType === 'cross' ? 1 : 0,
        feat.assistType === 'through' ? 1 : 0,
        feat.assistType === 'cutback' ? 1 : 0,
        feat.assistType === 'setPiece' ? 1 : 0,
      ]);
      rawY.push(feat.isGoal ? 1 : 0);
    }
  }
}

const N = rawX.length;
const D = 8;
if (N === 0) {
  console.error('fit-xg: no shots found');
  process.exit(1);
}

// Standardise features into flat typed arrays for fast gradient descent.
const mu = new Float64Array(D);
const sd = new Float64Array(D);
for (let i = 0; i < N; i++) {
  const row = rawX[i];
  for (let j = 0; j < D; j++) mu[j] += row[j];
}
for (let j = 0; j < D; j++) mu[j] /= N;
for (let i = 0; i < N; i++) {
  const row = rawX[i];
  for (let j = 0; j < D; j++) {
    const diff = row[j] - mu[j];
    sd[j] += diff * diff;
  }
}
for (let j = 0; j < D; j++) {
  sd[j] = Math.sqrt(sd[j] / N);
  if (sd[j] === 0) sd[j] = 1;
}

const X = new Float64Array(N * D);
const Y = new Uint8Array(N);
let totalGoals = 0;
for (let i = 0; i < N; i++) {
  const row = rawX[i];
  const off = i * D;
  for (let j = 0; j < D; j++) X[off + j] = (row[j] - mu[j]) / sd[j];
  Y[i] = rawY[i];
  totalGoals += rawY[i];
}

// Batch gradient descent: lr = 0.05, 5000 iterations, L2 = 0.001 (design item 26).
const LR = 0.05;
const ITERS = 5000;
const L2 = 0.001;
const w = new Float64Array(D);
const grad = new Float64Array(D);
let b = Math.log((totalGoals + 0.5) / (N - totalGoals + 0.5));

for (let iter = 0; iter < ITERS; iter++) {
  grad.fill(0);
  let gradB = 0;
  for (let i = 0; i < N; i++) {
    const off = i * D;
    let z = b;
    for (let j = 0; j < D; j++) z += w[j] * X[off + j];
    const p = 1 / (1 + Math.exp(-z));
    const err = p - Y[i];
    gradB += err;
    for (let j = 0; j < D; j++) grad[j] += err * X[off + j];
  }
  b -= (LR * gradB) / N;
  for (let j = 0; j < D; j++) {
    w[j] -= LR * (grad[j] / N + L2 * w[j]);
  }
}

// Convert back to raw feature scale.
const wRaw = new Float64Array(D);
let bRaw = b;
for (let j = 0; j < D; j++) {
  wRaw[j] = w[j] / sd[j];
  bRaw -= (w[j] * mu[j]) / sd[j];
}

// Diagnostics: mean predicted xG, log-loss, Brier score.
let sumP = 0;
let logLoss = 0;
let brier = 0;
for (let i = 0; i < N; i++) {
  const row = rawX[i];
  let z = bRaw;
  for (let j = 0; j < D; j++) z += wRaw[j] * row[j];
  const p = 1 / (1 + Math.exp(-z));
  const y = Y[i];
  sumP += p;
  logLoss -= y ? Math.log(Math.max(p, 1e-12)) : Math.log(Math.max(1 - p, 1e-12));
  brier += (p - y) * (p - y);
}

/** @param {number} v */
const r = (v) => Number(v.toFixed(6));
const fitDate = new Date().toISOString().slice(0, 10);
const source = 'statsbomb-2015-16-top5';
const logistic = {
  intercept: r(bRaw),
  distance: r(wRaw[0]),
  angle: r(wRaw[1]),
  header: r(wRaw[2]),
  defendersInCone: r(wRaw[3]),
  assistType: {
    none: 0,
    cross: r(wRaw[4]),
    through: r(wRaw[5]),
    cutback: r(wRaw[6]),
    setPiece: r(wRaw[7]),
  },
};

console.error(
  `fit-xg: ${matchCount} matches, ${N} non-penalty shots, ${totalGoals} goals ` +
    `(actual rate ${(totalGoals / N).toFixed(4)}, mean xG ${(sumP / N).toFixed(4)}, ` +
    `logLoss ${(logLoss / N).toFixed(4)}, brier ${(brier / N).toFixed(4)})`,
);

if (flags.write) {
  const xgPath = path.join(repoRoot, 'config', 'xg.yaml');
  const doc = parseDocument(readFileSync(xgPath, 'utf8'));
  doc.setIn(['source'], source);
  doc.setIn(['fitDate'], fitDate);
  doc.setIn(['logistic', 'intercept'], logistic.intercept);
  doc.setIn(['logistic', 'distance'], logistic.distance);
  doc.setIn(['logistic', 'angle'], logistic.angle);
  doc.setIn(['logistic', 'header'], logistic.header);
  doc.setIn(['logistic', 'defendersInCone'], logistic.defendersInCone);
  doc.setIn(['logistic', 'assistType', 'none'], 0);
  doc.setIn(['logistic', 'assistType', 'cross'], logistic.assistType.cross);
  doc.setIn(['logistic', 'assistType', 'through'], logistic.assistType.through);
  doc.setIn(['logistic', 'assistType', 'cutback'], logistic.assistType.cutback);
  doc.setIn(['logistic', 'assistType', 'setPiece'], logistic.assistType.setPiece);
  writeFileSync(xgPath, String(doc));
  console.error(`fit-xg: updated ${path.relative(repoRoot, xgPath)}`);
}

console.log(`source: ${source}
fitDate: "${fitDate}"
logistic:
  intercept: ${logistic.intercept}
  distance: ${logistic.distance}
  angle: ${logistic.angle}
  header: ${logistic.header}
  defendersInCone: ${logistic.defendersInCone}
  assistType: {none: 0, cross: ${logistic.assistType.cross}, through: ${logistic.assistType.through}, cutback: ${logistic.assistType.cutback}, setPiece: ${logistic.assistType.setPiece}}`);

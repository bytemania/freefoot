#!/usr/bin/env node
// Big-5 league benchmarks for calibration.
//
// Usage: node scripts/fetch-league-benchmarks.mjs [--seasons 10] [--refresh]
//          [--statsbomb <dir>] [--statsbomb-limit N] [--out config/benchmarks/top5-10yr.json]
//          [--timing-only]
//
// 1. Downloads match-level CSVs from football-data.co.uk for the last N
//    completed seasons of the Premier League (E0), La Liga (SP1), Bundesliga
//    (D1), Serie A (I1) and Ligue 1 (F1). Files are cached under
//    `.cache/football-data/` (use --refresh to download again).
// 2. Reads StatsBomb Open Data events for the 2015/16 top-five seasons (the
//    only full Big-5 seasons in the open set) for the event types the CSVs do
//    not carry: offsides, penalties awarded and injuries. A local clone in
//    `.cache/statsbomb-open-data` is used when present; otherwise a sample of
//    matches is downloaded from GitHub.
// 3. Computes:
//    - per-match event frequencies (both teams combined): goals, shots, shots
//      on target, corners, fouls, offsides, yellow cards, red cards,
//      penalties awarded and injuries;
//    - favourite win / draw / underdog win, goal difference and shot share by
//      closing-odds strength tier, plus a binned probability curve;
//    - the form ("morale") effect: win rate and conversion of teams on a hot
//      run vs a slump, raw and at matched closing-odds strength;
//    - the 15-minute timing buckets (1–15, 16–30, 31–45, 45+, 46–60, 61–75,
//      76–90, 90+) of goals, shots, yellow and red cards (StatsBomb 2015/16) and
//      of substitutions (StatsBomb five-substitution-era seasons).
//    `--timing-only` recomputes just the `timing` section from a local StatsBomb
//      clone and writes it into the existing benchmark file, leaving every other
//      figure untouched (no football-data download).
// 4. Writes everything, with source URLs, seasons and sample sizes, plus the
//    calibration bands derived from it, to config/benchmarks/top5-10yr.json.
//    `src/calibration/cohorts.js` reads that file and falls back to built-in
//    bounds when it is missing (CI without network).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildTimingBenchmark } from './lib/timing-benchmarks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    seasons: { type: 'string', default: '10' },
    'last-season': { type: 'string' },
    refresh: { type: 'boolean', default: false },
    statsbomb: { type: 'string' },
    'statsbomb-limit': { type: 'string' },
    out: { type: 'string', default: path.join('config', 'benchmarks', 'top5-10yr.json') },
    'timing-only': { type: 'boolean', default: false },
  },
});

export const LEAGUES = [
  { code: 'E0', name: 'Premier League' },
  { code: 'SP1', name: 'La Liga' },
  { code: 'D1', name: 'Bundesliga' },
  { code: 'I1', name: 'Serie A' },
  { code: 'F1', name: 'Ligue 1' },
];

const FD_BASE = 'https://football-data.co.uk/mmz4281';
const SB_RAW = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data';
const SB_SEASONS = [
  { competition_id: 2, season_id: 27, label: 'Premier League 2015/16' },
  { competition_id: 11, season_id: 27, label: 'La Liga 2015/16' },
  { competition_id: 12, season_id: 27, label: 'Serie A 2015/16' },
  { competition_id: 9, season_id: 27, label: 'Bundesliga 2015/16' },
  { competition_id: 7, season_id: 27, label: 'Ligue 1 2015/16' },
];

if (args['timing-only']) {
  const dir = path.resolve(args.statsbomb ?? path.join(repoRoot, '.cache', 'statsbomb-open-data'));
  const outFile = path.resolve(repoRoot, args.out);
  if (!existsSync(path.join(dir, 'data', 'competitions.json'))) {
    console.error(`benchmarks: --timing-only needs a local StatsBomb clone (${dir}); pass --statsbomb <dir>`);
    process.exit(2);
  }
  if (!existsSync(outFile)) {
    console.error(`benchmarks: --timing-only updates an existing ${path.relative(repoRoot, outFile)}; run without it first`);
    process.exit(2);
  }
  const readLocal = async (/** @type {string[]} */ ...parts) => {
    const file = path.join(dir, 'data', ...parts);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const existing = JSON.parse(readFileSync(outFile, 'utf8'));
  existing.timing = await buildTimingBenchmark({ readJson: readLocal, leagueSeasons: SB_SEASONS, limit: Infinity });
  writeFileSync(outFile, JSON.stringify(existing, null, 2) + '\n');
  console.log(`benchmarks: wrote timing section to ${path.relative(repoRoot, outFile)}`);
  process.exit(0);
}

/**
 * Closing-odds strength tiers: the favourite's margin-free win probability.
 * Engine cohorts map onto them by OVR gap (0, ~9 and ~20 OVR).
 */
export const TIERS = {
  even: { favProb: [0.3, 0.45], ovrGap: 0 },
  moderate: { favProb: [0.5, 0.6], ovrGap: 9 },
  heavy: { favProb: [0.65, 0.78], ovrGap: 20 },
};

/** Calibration band half-widths, relative to the benchmark mean (see bandFor). */
const EVENT_TOLERANCE = {
  goals: 0.12,
  shots: 0.15,
  shotsOnTarget: 0.15,
  corners: 0.2,
  fouls: 0.15,
  offsides: 0.3,
  yellowCards: 0.25,
  redCards: 0.5,
  penalties: 0.45,
  injuries: 0.45,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {number} startYear e.g. 2016 -> "1617" */
function seasonCode(startYear) {
  const a = String(startYear % 100).padStart(2, '0');
  const b = String((startYear + 1) % 100).padStart(2, '0');
  return `${a}${b}`;
}

/**
 * The last completed season's start year: a season ends in May, so before
 * July the season that started two years ago is the last complete one.
 */
function lastCompletedStartYear() {
  const now = new Date();
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() - 1 : now.getUTCFullYear() - 2;
}

/**
 * Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM).
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  /** @type {string[][]} */
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** @param {string | undefined} v */
function num(v) {
  if (v === undefined || v === '') return NaN;
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
}

/** @param {number[]} xs */
export function describe(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { n: 0, mean: null, sd: null, p10: null, p50: null, p90: null };
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, n - 1));
  const q = (/** @type {number} */ p) => {
    const pos = (n - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  };
  return { n, mean: r4(mean), sd: r4(sd), p10: r4(q(0.1)), p50: r4(q(0.5)), p90: r4(q(0.9)) };
}

/** @param {number} x */
function r4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Calibration band for a per-match mean: +-tol x mean, widened to at least
 * 2.5 standard errors of a 200-match simulated mean.
 * @param {{mean: number | null, sd: number | null}} d
 * @param {number} tol
 */
function bandFor(d, tol) {
  if (d.mean === null || d.sd === null) return null;
  const half = Math.max(tol * d.mean, (2.5 * d.sd) / Math.sqrt(200));
  return [r4(Math.max(0, d.mean - half)), r4(d.mean + half)];
}

/**
 * @param {string} url
 * @param {string} file cache path
 * @returns {Promise<string | null>}
 */
async function fetchCached(url, file) {
  if (!args.refresh && existsSync(file)) return readFileSync(file, 'utf8');
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'freefoot-benchmarks/1.0' } });
    if (!res.ok) {
      console.warn(`benchmarks: ${url} -> HTTP ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // football-data.co.uk serves Latin-1 for some older files.
    const text = buf.includes(0xef) && buf[0] === 0xef ? buf.toString('utf8') : buf.toString('latin1');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return text;
  } catch (err) {
    console.warn(`benchmarks: ${url} -> ${/** @type {Error} */ (err).message}`);
    return null;
  }
}

/**
 * Margin-free closing probabilities (Pinnacle closing, then market average
 * closing, then Pinnacle and Bet365 pre-match).
 * @param {Record<string, string>} r
 * @returns {{pH: number, pD: number, pA: number, book: string} | null}
 */
function impliedProbs(r) {
  for (const [h, d, a] of [
    ['PSCH', 'PSCD', 'PSCA'],
    ['AvgCH', 'AvgCD', 'AvgCA'],
    ['PSH', 'PSD', 'PSA'],
    ['B365H', 'B365D', 'B365A'],
  ]) {
    const oh = num(r[h]);
    const od = num(r[d]);
    const oa = num(r[a]);
    if (oh > 1 && od > 1 && oa > 1) {
      const s = 1 / oh + 1 / od + 1 / oa;
      return { pH: 1 / oh / s, pD: 1 / od / s, pA: 1 / oa / s, book: h.replace(/H$/, '') };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. football-data.co.uk
// ---------------------------------------------------------------------------

const seasonsWanted = Number(args.seasons);
const lastStart = args['last-season'] ? Number(args['last-season']) : lastCompletedStartYear();
const seasonStarts = Array.from({ length: seasonsWanted }, (_, i) => lastStart - seasonsWanted + 1 + i);
const fdCache = path.join(repoRoot, '.cache', 'football-data');

/** @type {Array<any>} */
const matches = [];
/** @type {Array<{league: string, season: string, url: string, rows: number}>} */
const fdFiles = [];

for (const start of seasonStarts) {
  const code = seasonCode(start);
  for (const lg of LEAGUES) {
    const url = `${FD_BASE}/${code}/${lg.code}.csv`;
    const text = await fetchCached(url, path.join(fdCache, code, `${lg.code}.csv`));
    if (text === null) continue;
    const rows = parseCsv(text).filter((r) => r.HomeTeam && r.FTHG !== '' && r.FTAG !== '');
    fdFiles.push({ league: lg.code, season: `${start}/${String((start + 1) % 100).padStart(2, '0')}`, url, rows: rows.length });
    for (const r of rows) {
      const date = r.Date ?? '';
      const [dd, mm, yy] = date.split('/');
      const year = yy?.length === 2 ? 2000 + Number(yy) : Number(yy);
      matches.push({
        league: lg.code,
        season: code,
        order: Date.UTC(year, Number(mm) - 1, Number(dd)) + (r.Time ? Number(r.Time.replace(':', '')) : 0),
        home: r.HomeTeam,
        away: r.AwayTeam,
        hg: num(r.FTHG),
        ag: num(r.FTAG),
        hs: num(r.HS),
        as: num(r.AS),
        hst: num(r.HST),
        ast: num(r.AST),
        hf: num(r.HF),
        af: num(r.AF),
        hc: num(r.HC),
        ac: num(r.AC),
        hy: num(r.HY),
        ay: num(r.AY),
        hr: num(r.HR),
        ar: num(r.AR),
        odds: impliedProbs(r),
      });
    }
  }
}

if (matches.length === 0) {
  console.error('benchmarks: no football-data.co.uk files could be read (offline?). Nothing written.');
  process.exit(1);
}
console.log(`benchmarks: ${matches.length} matches from ${fdFiles.length} football-data.co.uk files`);

/** @param {(m: any) => number} f */
const col = (f) => matches.map(f).filter((x) => Number.isFinite(x));

const fdEvents = {
  goals: describe(col((m) => m.hg + m.ag)),
  shots: describe(col((m) => m.hs + m.as)),
  shotsOnTarget: describe(col((m) => m.hst + m.ast)),
  corners: describe(col((m) => m.hc + m.ac)),
  fouls: describe(col((m) => m.hf + m.af)),
  yellowCards: describe(col((m) => m.hy + m.ay)),
  redCards: describe(col((m) => m.hr + m.ar)),
};

/** @type {Record<string, any>} */
const byLeague = {};
for (const lg of LEAGUES) {
  const ms = matches.filter((m) => m.league === lg.code);
  const c = (/** @type {(m: any) => number} */ f) => ms.map(f).filter((x) => Number.isFinite(x));
  byLeague[lg.code] = {
    matches: ms.length,
    goals: describe(c((m) => m.hg + m.ag)).mean,
    shots: describe(c((m) => m.hs + m.as)).mean,
    shotsOnTarget: describe(c((m) => m.hst + m.ast)).mean,
    corners: describe(c((m) => m.hc + m.ac)).mean,
    fouls: describe(c((m) => m.hf + m.af)).mean,
    yellowCards: describe(c((m) => m.hy + m.ay)).mean,
    redCards: describe(c((m) => m.hr + m.ar)).mean,
  };
}

// Overall result split.
const homeWin = matches.filter((m) => m.hg > m.ag).length / matches.length;
const drawAll = matches.filter((m) => m.hg === m.ag).length / matches.length;

// ---------------------------------------------------------------------------
// 2. Strength tiers and probability curve (favourite's perspective, venue pooled)
// ---------------------------------------------------------------------------

/**
 * @param {any} m
 * @returns {{favProb: number, drawProb: number, favWin: number, draw: number, dogWin: number, gd: number, shotShare: number, favHome: boolean, favGoals: number, dogGoals: number}}
 */
function favView(m) {
  const favHome = m.odds.pH >= m.odds.pA;
  const fg = favHome ? m.hg : m.ag;
  const dg = favHome ? m.ag : m.hg;
  const fs = favHome ? m.hs : m.as;
  const ds = favHome ? m.as : m.hs;
  return {
    favProb: favHome ? m.odds.pH : m.odds.pA,
    drawProb: m.odds.pD,
    favWin: fg > dg ? 1 : 0,
    draw: fg === dg ? 1 : 0,
    dogWin: fg < dg ? 1 : 0,
    gd: fg - dg,
    shotShare: fs + ds > 0 ? fs / (fs + ds) : NaN,
    favHome,
    favGoals: fg,
    dogGoals: dg,
  };
}

const withOdds = matches.filter((m) => m.odds !== null).map((m) => ({ m, f: favView(m) }));

/** @param {Array<{m: any, f: ReturnType<typeof favView>}>} rows */
function summarizeTier(rows) {
  const n = rows.length;
  const avg = (/** @type {(x: ReturnType<typeof favView>) => number} */ g) => {
    const v = rows.map((r) => g(r.f)).filter((x) => Number.isFinite(x));
    return v.length ? r4(v.reduce((s, x) => s + x, 0) / v.length) : null;
  };
  return {
    matches: n,
    favHomeShare: avg((f) => (f.favHome ? 1 : 0)),
    impliedFavWin: avg((f) => f.favProb),
    impliedDraw: avg((f) => f.drawProb),
    favWin: avg((f) => f.favWin),
    draw: avg((f) => f.draw),
    dogWin: avg((f) => f.dogWin),
    goalDiff: avg((f) => f.gd),
    favGoals: avg((f) => f.favGoals),
    dogGoals: avg((f) => f.dogGoals),
    favShotShare: avg((f) => f.shotShare),
  };
}

/** @type {Record<string, any>} */
const tiers = {};
for (const [name, def] of Object.entries(TIERS)) {
  const rows = withOdds.filter((r) => r.f.favProb >= def.favProb[0] && r.f.favProb < def.favProb[1]);
  tiers[name] = { ...def, ...summarizeTier(rows) };
}

const curve = [];
for (let lo = 0.3; lo < 0.9; lo += 0.05) {
  const hi = lo + 0.05;
  const rows = withOdds.filter((r) => r.f.favProb >= lo && r.f.favProb < hi);
  if (rows.length < 50) continue;
  curve.push({ favProb: [r4(lo), r4(hi)], ...summarizeTier(rows) });
}

// ---------------------------------------------------------------------------
// 3. Form ("morale") effect
// ---------------------------------------------------------------------------
// Form = league points from the team's previous 5 matches in the same season.
// Hot run: >= 12 of 15 points; slump: <= 3 of 15.

/** @type {Map<string, number[]>} */
const recent = new Map();
/** @type {Array<{form: number, win: number, draw: number, gf: number, sot: number, shots: number, pWin: number}>} */
const formRows = [];
const sorted = matches.slice().sort((a, b) => (a.league + a.season).localeCompare(b.league + b.season) || a.order - b.order);
for (const m of sorted) {
  const kh = `${m.league}|${m.season}|${m.home}`;
  const ka = `${m.league}|${m.season}|${m.away}`;
  const rh = recent.get(kh) ?? [];
  const ra = recent.get(ka) ?? [];
  const ph = m.hg > m.ag ? 3 : m.hg === m.ag ? 1 : 0;
  const pa = m.ag > m.hg ? 3 : m.hg === m.ag ? 1 : 0;
  for (const side of /** @type {const} */ (['home', 'away'])) {
    const r = side === 'home' ? rh : ra;
    if (r.length < 5) continue;
    const form = r.slice(-5).reduce((s, x) => s + x, 0);
    const isHome = side === 'home';
    const gf = isHome ? m.hg : m.ag;
    const ga = isHome ? m.ag : m.hg;
    formRows.push({
      form,
      win: gf > ga ? 1 : 0,
      draw: gf === ga ? 1 : 0,
      gf,
      sot: isHome ? m.hst : m.ast,
      shots: isHome ? m.hs : m.as,
      pWin: m.odds ? (isHome ? m.odds.pH : m.odds.pA) : NaN,
    });
  }
  rh.push(ph);
  ra.push(pa);
  recent.set(kh, rh);
  recent.set(ka, ra);
}

/** @param {typeof formRows} rows */
function formSummary(rows) {
  const n = rows.length;
  const sum = (/** @type {(r: (typeof formRows)[number]) => number} */ g) => rows.reduce((s, r) => s + (Number.isFinite(g(r)) ? g(r) : 0), 0);
  const goals = sum((r) => r.gf);
  const sot = sum((r) => r.sot);
  const shots = sum((r) => r.shots);
  const withP = rows.filter((r) => Number.isFinite(r.pWin));
  return {
    teamMatches: n,
    winRate: r4(sum((r) => r.win) / n),
    drawRate: r4(sum((r) => r.draw) / n),
    goalsPerMatch: r4(goals / n),
    goalsPerShot: r4(goals / shots),
    goalsPerShotOnTarget: r4(goals / sot),
    impliedWin: r4(withP.reduce((s, r) => s + r.pWin, 0) / withP.length),
    winOverImplied: r4(withP.reduce((s, r) => s + r.win - r.pWin, 0) / withP.length),
  };
}

const hot = formRows.filter((r) => r.form >= 12);
const slump = formRows.filter((r) => r.form <= 3);
const hotS = formSummary(hot);
const slumpS = formSummary(slump);

// Matched strength: within closing-odds win-probability bins, compare hot and
// slumping teams, weighting each bin by the smaller group.
let wSum = 0;
let dWin = 0;
let dConv = 0;
let dGoals = 0;
const strata = [];
for (let lo = 0.1; lo < 0.9; lo += 0.1) {
  const hi = lo + 0.1;
  const h = hot.filter((r) => r.pWin >= lo && r.pWin < hi);
  const s = slump.filter((r) => r.pWin >= lo && r.pWin < hi);
  if (h.length < 30 || s.length < 30) continue;
  const hs = formSummary(h);
  const ss = formSummary(s);
  const w = Math.min(h.length, s.length);
  wSum += w;
  dWin += w * (hs.winRate - ss.winRate);
  dConv += w * (hs.goalsPerShotOnTarget - ss.goalsPerShotOnTarget);
  dGoals += w * (hs.goalsPerMatch - ss.goalsPerMatch);
  strata.push({ pWin: [r4(lo), r4(hi)], hot: h.length, slump: s.length, hotWin: hs.winRate, slumpWin: ss.winRate });
}

const formEffect = {
  definition: 'Points from the previous 5 league matches of the same season. Hot run >= 12/15, slump <= 3/15.',
  hot: hotS,
  slump: slumpS,
  rawWinRateDelta: r4(hotS.winRate - slumpS.winRate),
  rawConversionDelta: r4(hotS.goalsPerShotOnTarget - slumpS.goalsPerShotOnTarget),
  matchedStrength: {
    method: 'Closing-odds win-probability bins of 0.1; bin deltas weighted by the smaller group size.',
    winRateDelta: wSum > 0 ? r4(dWin / wSum) : null,
    conversionDelta: wSum > 0 ? r4(dConv / wSum) : null,
    goalsPerMatchDelta: wSum > 0 ? r4(dGoals / wSum) : null,
    strata,
  },
};

// ---------------------------------------------------------------------------
// 4. StatsBomb: offsides, penalties, injuries
// ---------------------------------------------------------------------------

const sbDir = path.resolve(args.statsbomb ?? path.join(repoRoot, '.cache', 'statsbomb-open-data'));
const sbLocal = existsSync(path.join(sbDir, 'data', 'competitions.json'));
const sbLimit = args['statsbomb-limit'] ? Number(args['statsbomb-limit']) : sbLocal ? Infinity : 60;
/** @type {Record<'offsides' | 'penalties' | 'injuries' | 'injurySubs' | 'corners' | 'fouls' | 'shots', number[]>} */
const sbPerMatch = { offsides: [], penalties: [], injuries: [], injurySubs: [], corners: [], fouls: [], shots: [] };
const sbSources = [];

/**
 * @param {string[]} parts
 * @returns {Promise<any | null>}
 */
async function sbJson(...parts) {
  if (sbLocal) {
    const file = path.join(sbDir, 'data', ...parts);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }
  const file = path.join(repoRoot, '.cache', 'statsbomb-sample', ...parts);
  const text = await fetchCached(`${SB_RAW}/${parts.join('/')}`, file);
  return text === null ? null : JSON.parse(text);
}

for (const s of SB_SEASONS) {
  /** @type {any[] | null} */
  const list = await sbJson('matches', String(s.competition_id), `${s.season_id}.json`);
  if (!list) {
    console.warn(`benchmarks: StatsBomb ${s.label} unavailable`);
    continue;
  }
  const perSeason = Number.isFinite(sbLimit) ? Math.ceil(sbLimit / SB_SEASONS.length) : list.length;
  const chosen = list
    .slice()
    .sort((a, b) => a.match_id - b.match_id)
    .filter((_, i, arr) => perSeason >= arr.length || i % Math.ceil(arr.length / perSeason) === 0)
    .slice(0, perSeason);
  let used = 0;
  for (const mt of chosen) {
    /** @type {any[] | null} */
    const events = await sbJson('events', `${mt.match_id}.json`);
    if (!events) continue;
    used++;
    let offsides = 0;
    let penalties = 0;
    let corners = 0;
    let fouls = 0;
    let shots = 0;
    let injurySubs = 0;
    // Consecutive Injury Stoppage events within 60 s are one incident.
    let injuries = 0;
    let lastInjury = -1e9;
    for (const ev of events) {
      if (ev.period > 4) continue; // never a shoot-out in league play, but be safe
      const type = ev.type?.name;
      const t = (ev.minute ?? 0) * 60 + (ev.second ?? 0);
      if (type === 'Offside' || (type === 'Pass' && ev.pass?.outcome?.name === 'Pass Offside')) offsides++;
      else if (type === 'Shot') {
        shots++;
        if (ev.shot?.type?.name === 'Penalty') penalties++;
      } else if (type === 'Pass' && ev.pass?.type?.name === 'Corner') corners++;
      else if (type === 'Foul Committed') fouls++;
      else if (type === 'Injury Stoppage') {
        if (t - lastInjury > 60) injuries++;
        lastInjury = t;
      } else if (type === 'Substitution' && ev.substitution?.outcome?.name === 'Injury') injurySubs++;
    }
    sbPerMatch.offsides.push(offsides);
    sbPerMatch.penalties.push(penalties);
    sbPerMatch.injuries.push(injuries);
    sbPerMatch.injurySubs.push(injurySubs);
    sbPerMatch.corners.push(corners);
    sbPerMatch.fouls.push(fouls);
    sbPerMatch.shots.push(shots);
  }
  sbSources.push({ season: s.label, competition_id: s.competition_id, season_id: s.season_id, matches: used });
  console.log(`benchmarks: StatsBomb ${s.label}: ${used} matches`);
}

const sbEvents = {
  offsides: describe(sbPerMatch.offsides),
  penalties: describe(sbPerMatch.penalties),
  injuries: describe(sbPerMatch.injuries),
  injurySubstitutions: describe(sbPerMatch.injurySubs),
  cornersCheck: describe(sbPerMatch.corners),
  foulsCheck: describe(sbPerMatch.fouls),
  shotsCheck: describe(sbPerMatch.shots),
};

// ---------------------------------------------------------------------------
// 5. Assemble and write
// ---------------------------------------------------------------------------

const fdSource = `football-data.co.uk ${seasonStarts[0]}/${String((seasonStarts[0] + 1) % 100).padStart(2, '0')}-${lastStart}/${String((lastStart + 1) % 100).padStart(2, '0')}`;
const sbSource = sbLocal ? 'StatsBomb Open Data 2015/16 Big-5 (local clone)' : 'StatsBomb Open Data 2015/16 Big-5 (GitHub sample)';

/** @type {Record<string, any>} */
const eventFrequencies = {};
for (const [id, d] of Object.entries(fdEvents)) eventFrequencies[id] = { ...d, source: fdSource };
eventFrequencies.offsides = { ...sbEvents.offsides, source: sbSource };
eventFrequencies.penalties = { ...sbEvents.penalties, source: sbSource };
eventFrequencies.injuries = { ...sbEvents.injuries, source: sbSource, definition: 'Injury Stoppage incidents (events within 60 s merged)' };
for (const [id, tol] of Object.entries(EVENT_TOLERANCE)) {
  eventFrequencies[id].tolerance = tol;
  eventFrequencies[id].band = bandFor(eventFrequencies[id], tol);
}

const timing = await buildTimingBenchmark({ readJson: sbJson, leagueSeasons: SB_SEASONS, limit: sbLimit });

const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generator: 'scripts/fetch-league-benchmarks.mjs',
  unit: 'per match, both teams combined',
  sources: {
    footballData: {
      description: 'football-data.co.uk match results, statistics and closing odds',
      licence: 'Free for non-commercial use; see https://www.football-data.co.uk/notes.txt',
      seasons: fdFiles.map((f) => f.season).filter((v, i, a) => a.indexOf(v) === i),
      leagues: LEAGUES,
      matches: matches.length,
      matchesWithOdds: withOdds.length,
      files: fdFiles,
    },
    statsbomb: {
      description: 'StatsBomb Open Data event files (offsides, penalties, injury stoppages)',
      licence: 'StatsBomb Open Data licence; credit StatsBomb',
      url: 'https://github.com/statsbomb/open-data',
      local: sbLocal,
      seasons: sbSources,
      matches: sbPerMatch.offsides.length,
    },
  },
  eventFrequencies,
  crossChecks: {
    statsbomb2015: {
      corners: sbEvents.cornersCheck,
      fouls: sbEvents.foulsCheck,
      shots: sbEvents.shotsCheck,
      injurySubstitutions: sbEvents.injurySubstitutions,
    },
    byLeague,
  },
  results: {
    homeWin: r4(homeWin),
    draw: r4(drawAll),
    awayWin: r4(1 - homeWin - drawAll),
  },
  strengthTiers: tiers,
  probabilityCurve: curve,
  formEffect,
  timing,
};

const outPath = path.resolve(repoRoot, args.out);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`benchmarks: wrote ${path.relative(repoRoot, outPath)}`);
for (const [id, d] of Object.entries(eventFrequencies)) {
  console.log(`  ${id.padEnd(14)} mean ${String(d.mean).padStart(7)}  band ${JSON.stringify(d.band)}  (n=${d.n})`);
}
for (const [id, t] of Object.entries(tiers)) {
  console.log(`  tier ${id.padEnd(9)} fav ${t.favWin} draw ${t.draw} dog ${t.dogWin} gd ${t.goalDiff} shotShare ${t.favShotShare} (n=${t.matches})`);
}
console.log(`  form: raw win delta ${formEffect.rawWinRateDelta}, matched-strength win delta ${formEffect.matchedStrength.winRateDelta}, conv delta ${formEffect.matchedStrength.conversionDelta}`);

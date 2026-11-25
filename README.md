# freefoot

A Football Manager-style career and league game for Android phones. This repository holds the deterministic 2D match engine and the v1 single-match viewer. The design is in [`docs/designs/freefoot_match_engine.md`](docs/designs/freefoot_match_engine.md).

## Setup

```sh
nvm use                              # Node 22 (see .nvmrc)
npm ci
npx playwright install chromium      # for test:e2e
```

Android builds also need JDK 21 and Android Studio. StatsBomb Open Data (for `fit-xg`, `reference` and calibration) is downloaded from <https://github.com/statsbomb/open-data>; `<statsbomb-dir>` is the repository root, the folder that contains `data/`.

## Folder map

| Path | Contents |
| :-- | :-- |
| `config/` | YAML sources: weights, roles, tactics, injuries, officiating, AI coach, events, xG, playback, calibration targets and scenarios, commentary, UI strings, sample squads |
| `config/schema/` | JSON Schemas (draft 2020-12) that every YAML file is validated against |
| `config/benchmarks/` | `top5-10yr.json`: Big-5 league benchmarks (event rates, closing-odds strength tiers, form effect) written by `fetch-league-benchmarks.mjs` |
| `scripts/` | Node tools: `build-config.mjs`, `calibrate.mjs`, `fetch-league-benchmarks.mjs`, `repro.mjs`, `fit-xg.mjs`, `build-reference.mjs` |
| `src/engine/` | The match engine (plain ES modules, no DOM or Node dependencies) |
| `src/runtime/` | Browser playback controller and persistence |
| `src/ui/` | Canvas viewer and views |
| `src/i18n/` | Commentary templates and the commentator |
| `src/shared/` | Helpers shared by Node and the browser (`canonicalJson`, `stats`, `squadgen`) |
| `src/calibration/` | Headless runner and benchmarks |
| `tests/` | `node --test` unit tests (`*.test.js`) and Playwright specs (`*.spec.js`) |
| `generated/` | Build output of `build-config` (not edited, not committed) |
| `reports/` | Calibration reports (not committed) |
| `android/` | Capacitor Android project |

## npm scripts

| Script | What it does |
| :-- | :-- |
| `build:config` | Validates `config/` and writes `generated/` |
| `dev` | `build:config`, then the Vite dev server |
| `build` | `build:config`, then the production bundle in `dist/` |
| `test` | `build:config`, then all unit tests |
| `test:coverage` | Unit tests with the 85% line-coverage gate on `src/engine/` and `src/runtime/` |
| `test:e2e` | Playwright cross-engine determinism test |
| `lint` | ESLint, including the engine determinism and boundary rules |
| `typecheck` | `build:config`, then `tsc --noEmit` over the JSDoc types |
| `bench` | Engine benchmark in Node |
| `calibrate` | Cohort calibration gate (`scripts/calibrate.mjs`): `--matches N` (default 400), `--seed-start N`, `--cohort all\|even\|moderate\|heavy\|morale`. Checks the 10 event rates, the closing-odds win/draw/upset curves and the morale edge against `config/benchmarks/top5-10yr.json` (built-in fallback bounds when missing). A check fails when its value is outside its band by more than 3 standard errors of the run's own sampling error (`PASS*` in the report: outside the band but within that allowance) |
| `calibrate:instructions` | Instructions calibration cohort (`scripts/calibrate-instructions.mjs`): every non-default team-instruction option against defaults, 80 v 80 OVR, each seed with the option at home and away (`--seeds N`, default 300, i.e. 600 matches per option; `--only <instruction[.option]>`). Gates: mean goal difference within ±0.15 per match, and the declared upside and downside (`config/tactics.yaml`) each with paired z ≥ 2. See [`docs/designs/tactics_instructions.md`](docs/designs/tactics_instructions.md) |
| `calibrate:legacy` | The older Scenario A/B runner against the StatsBomb reference percentiles in `targets.yaml` (diagnostic) |
| `benchmarks` | `node scripts/fetch-league-benchmarks.mjs`: downloads 10 seasons of football-data.co.uk Big-5 CSVs (cached in `.cache/football-data/`), reads StatsBomb events from `.cache/statsbomb-open-data` (or a GitHub sample) and rewrites `config/benchmarks/top5-10yr.json` |
| `repro` | Replay a repro record: `npm run repro -- <record.json> [--tick N]` |
| `fit-xg` | Fit xG coefficients: `npm run fit-xg -- <statsbomb-dir>` |
| `reference` | Write reference percentiles into `targets.yaml`: `npm run reference -- <statsbomb-dir>` |
| `android` | `build`, then `cap sync android` (then build the APK in Android Studio) |

Golden hashes are regenerated with `UPDATE_GOLDEN=1 npm test`.

## How to tune

1. Edit the coefficients in `config/*.yaml`. The benchmarks in `config/benchmarks/top5-10yr.json` (and the legacy targets in `config/calibration/targets.yaml`) are never changed during tuning.
2. Run `npm run calibrate` (400 matches per cohort).
3. Read the report in `reports/cohorts-*.md` and repeat.

Strength sensitivity is mainly `weights.attributes.contrast` (every attribute is read as `pivot + contrast x (raw - pivot)`); morale effects are the `weights.morale` coefficients. Teams and players accept an optional `morale` (0-100, 75 neutral) in the match input and squad files.

`build:config` reports a misspelled key, a wrong type or a missing template as `file:line:column`, so a typo fails the build instead of silently changing the engine.

## Determinism rules for `src/engine/`

The same seed and the same commands must give the same match in every JavaScript engine. ESLint enforces these rules (`npm run lint`):

- Only `Math.floor`, `ceil`, `round`, `trunc`, `abs`, `sign`, `sqrt`, `min`, `max`, `imul`, `fround` and `clz32` are allowed. No `Math.sin`, `exp`, `pow`, `random`, and so on; no aliasing `Math` and no `Math[...]`.
- Use `engine/math/detmath.js` (`PI`, `fastAtan2`, `fastExp`, `sigmoid`) instead.
- No `**` or `**=`.
- No `Date`, `performance`, `Intl`, `globalThis`, `window`, `document`, `process`, `require`, `localeCompare` or `toLocale*`.
- The engine imports only relative engine modules: no packages, no `node:*`, no `#generated/*`.
- Every sort breaks ties by player index. Never iterate a `Map` or `Set` whose insertion order depends on timing.
- All randomness comes from the engine's single `sfc32` stream. Commentary, highlights and the UI never touch it.

## Running `#bench` on a phone

Build and install the app, open it, and navigate to the `#bench` route (append `#bench` to the URL in a browser, or use the bench entry in debug builds). It runs the golden seeds, prints the hash line to compare with the golden file, and reports ticks per second and dropped playback budget.

## Replaying a repro record

The save record is also the repro record; the app can copy it to the clipboard. Save it to a file and run:

```sh
npm run repro -- record.json            # checks the final state hash
npm run repro -- record.json --tick 900 # writes serialize() at tick 900 as JSON
```

If `engineVersion` differs, the script exits with the recorded version; check out the matching engine commit and run it again. Config differences need no checkout, because the config is embedded in the record.

## Attribution

Reference statistics and the xG model are derived from [StatsBomb Open Data](https://github.com/statsbomb/open-data), used under its licence. League benchmarks also use match data and closing odds from [football-data.co.uk](https://www.football-data.co.uk/). StatsBomb must be credited, and any published work using the data should carry the StatsBomb logo.

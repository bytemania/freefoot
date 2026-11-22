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
| `scripts/` | Node tools: `build-config.mjs`, `repro.mjs`, `fit-xg.mjs`, `build-reference.mjs` |
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
| `calibrate` | Calibration runner; `--scenario A\|B\|all`, `--matches N` (default 500) |
| `repro` | Replay a repro record: `npm run repro -- <record.json> [--tick N]` |
| `fit-xg` | Fit xG coefficients: `npm run fit-xg -- <statsbomb-dir>` |
| `reference` | Write reference percentiles into `targets.yaml`: `npm run reference -- <statsbomb-dir>` |
| `android` | `build`, then `cap sync android` (then build the APK in Android Studio) |

Golden hashes are regenerated with `UPDATE_GOLDEN=1 npm test`.

## How to tune

1. Edit the coefficients in `config/*.yaml`. Calibration targets live in `config/calibration/targets.yaml` and are never changed during tuning.
2. Run `npm run calibrate`.
3. Read the report in `reports/` and repeat.

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

Reference statistics and the xG model are derived from [StatsBomb Open Data](https://github.com/statsbomb/open-data), used under its licence. StatsBomb must be credited, and any published work using the data should carry the StatsBomb logo.

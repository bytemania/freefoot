# Football Manager Matchday Loop (Phase 1)

* **Author:** bytemania
* **Date:** 2026-11-25

## Overview

Phase 1 turns `freefoot` from a single live-match screen into a repeatable matchday loop:
**Pre-Match -> Live Match -> Post-Match Report -> Next Match**.

Today, opening the app starts a live match straight away. It uses fixed sample squads and a manager drawer that offers only two formations (`4-3-3`, `4-4-2`). Phase 1 adds:

* A library of 10 default tactics. Each tactic has its own ID and pairs one formation with one instruction profile built from the existing options in `config/tactics.yaml`.
* Tactical familiarity (0–100). It is 60% formation and 40% instruction style, and it is saved between matches in `capacitorStorage`.
* A Pre-Match screen on the root route (`""`). Here the player picks Plan A, Plan B, the Starting XI and a 7-man bench.
* Live switching between Plan A and Plan B. The engine recalculates familiarity when the player changes individual instructions by hand.
* A Post-Match Report, built outside `src/engine/`, that produces a `MatchReport` data contract. Career Mode can store this contract later.

The 10-tactic library, Plan A/B and familiarity all stay in Phase 1. The reason is that they define the exact data contract Career Mode will need. The scope is kept in check by dropping the speculative parts instead: extra time and penalties, a new phase-lag mechanic, period relabelling, and a second rating formula.

## Analysis

Seven independent Goldfish reviews checked the concept against the codebase: `egm-design`, `egm-codebase-details`, `egm-zoom-out`, `egm-comprehension`, `egm-implementation-readiness`, `egm-structural` and `egm-inventive-catalyst`. The author has now resolved every Blocker. This section records how each one was resolved, plus three corrections made while checking the resolutions against the code.

### Corrections applied while checking the resolutions against the code

> [!WARNING]
> Three of the resolutions as first written would not have worked against the current code. The brief uses the corrected versions below.

1. **E2E URL must be `/?seed=22#match`, not `/#match?seed=22`.** `matchSeedFrom(window.location.search, …)` (`src/runtime/matchSeed.js`, called at `src/ui/main.js:~250`) reads the seed from the query string only. In `/#match?seed=22`, the `?seed=22` part sits inside the hash, so `location.search` is empty. The match would get a random seed, and all 6 existing E2E tests would become nondeterministic. The query string has to come before the hash. (The other option is to make `matchSeedFrom` also read parameters from the hash. That means more code for no gain.)
2. **The stamina knob is `drainMul`. `staminaDrainMul` does not exist.** `KNOBS.drainMul` (`Instructions.js:24`) is the fitness-drain multiplier that `Fitness.js:61` reads. Familiarity uses the existing `noiseMul` and `drainMul` knobs. No new knob is added.
3. **The override penalty counts changed *instructions*, not changed *knobs*.** `config/tactics.yaml` has **9** instructions: `tempo`, `directness`, `attackFocus`, `attackTransition`, `timeWasting`, `defensiveLine`, `marking`, `defensiveTransition` and `tackling`. (The header comment in `Instructions.js` still says "Eight" and should be corrected.) A single option can set up to 7 knobs: `marking: manToMan` sets 7, and `tempo: fast` sets 6. Counting knobs would make one tap cost up to 84 points of `instrFam`. The rule is therefore: **−12 for each instruction whose selected option differs from the active plan's trained profile.** The largest possible penalty is 9 × 12 = 108, and the floor at 0 caps it.

### 1. Engine boundary, knob composition and zero regression (resolved)

* **One place composes the knobs.** Today, `setInstructions()` (`Instructions.js:172-176`) and `refreshShoutKnobs()` (`Shouts.js:97-101`, also called when a shout expires at `Shouts.js:274`) each overwrite `team.knobs`. Both will call a new `refreshTeamKnobs(team)`, which composes `instrKnobs`, then `familiarityKnobs`, then `shoutKnobs`. `familiarityKnobs` is `null` whenever effective familiarity is 80 or more. In that case the composition skips it completely: no multiplication and no RNG draw. `MatchState.restore()` calls the same helper.
* **No change to `Phase.js`.** The familiarity penalty uses only `noiseMul` and `drainMul`. Reusing `transitionAttMul` was rejected because a higher value lengthens the counter-attack window, so it would reward unfamiliar teams instead of penalising them.
* **`baseFormationId` is stored separately from `formationId`.** After a red card, `reduce()` (`Formation.js:179-190`) sets `formationId` to an `emergencyShape` (`4-4-1` / `4-3-1`). Formation familiarity always looks up `baseFormationId`, which stays the active plan's formation. With fewer than 9 players, `reduce()` does nothing, and slot assignment works on whatever slots are filled.
* **Familiarity is calculated from inputs, not stored as a running value.** `effectiveFamiliarity` is computed from `(baseFormationFamiliarity, activeInstructions, trainedProfile)` and cached in a value that is never serialized. The cache is cleared on `SWITCH_TACTIC_PLAN` and `SET_INSTRUCTIONS`. If the player reverts a tweak, the penalty and the `Modified` badge go away without any extra code.
* **Serialization.** `MatchState.serialize()` adds plan and familiarity fields only when there is a plan snapshot. It follows the existing conditional-spread pattern used for `instructions`, `shout`, `focus` and `var`. Matches with no snapshot (golden seeds, calibration, `#bench`) serialize exactly as they do today.
* **Golden-seed safety, checked.** `tests/golden/seeds.json` stores squads plus periodic state hashes. It does not store `configHash` or `MatchResult.players`. Adding formations, presets, i18n keys or a `rating` field on `MatchResult.players` cannot change it, provided that (a) the existing `4-3-3` and `4-4-2` slot coordinates are left untouched, and (b) a match with no snapshot never reaches the familiarity code.
* **Kick-off slot order.** `MatchState.#placeStarters()` sets `p.slot = i` directly. Pre-Match must therefore order `players[0..10]` with `computeOptimalSlotAssignments` against Plan A's slots, with the goalkeeper fixed at index `0` (`MatchInput.js:129` throws otherwise). It does this whenever the formation changes or Auto-Pick runs.

### 2. Config, schema and position labels (resolved)

* **Schema regex.** The formation-ID pattern in `config/schema/tactics.schema.json` becomes `^[0-9](-[0-9]){2,4}(-[a-z]+)?$`.
* **Tactic IDs are separate from formation IDs.** `balanced` and `tiki-taka` both use formation `4-3-3`, with different instruction profiles. That leaves **7 new formations**, not 8: `4-2-3-1`, the diamond, `4-1-4-1`, `3-5-2`, `3-4-3`, `4-2-4` and `5-4-1`. `4-3-3` and `4-4-2` already exist. All 7 rely on `emergencyShape` (an empty `reducedTo: {}`).
* **Presets live in a separate config file.** The 10 tactics go in `config/tactical-presets.yaml`, which has its own Ajv schema. `build-config.mjs` checks every `formationId` and instruction option it references. `config/tactics.yaml` stays limited to settings the engine reads.
* **Coordinates must fit the `positions.js` thresholds.** `positionCode()` labels an `MF` as `DM` (`MDC`) only when `x < 0.33` and `0.36 ≤ y ≤ 0.64`. The `4-2-3-1` double pivot must use `y` values inside that band (for example 0.38 / 0.62), otherwise its players are labelled `MCE/MCD`. The same check applies to wing-backs (`x ≥ 0.32` gives `AE/AD`) and to attacking midfielders (`x ≥ 0.45` gives `MO`).

### 3. Routing and E2E (resolved)

* `""` opens Pre-Match. `#match` goes straight to the live match. `#seed=…` and `#bench` are unchanged.
* The 6 tests in `tests/e2e/ui-flows.spec.js` change `const MATCH = '/?seed=22'` to **`'/?seed=22#match'`** (see Correction 1). New E2E tests cover Pre-Match -> Match -> Post-Match -> Next Match.
* The Debug Viewer link `href="#"` (`main.js:96`) becomes `href="#match"`.
* `teardownRoute` must close the shared `dialogView` and destroy the `MatchController` before it mounts the Post-Match or Pre-Match screen.
* **`H1/H2` stay as they are.** The `stats.header` text and the E2E regex at `ui-flows.spec.js:387` are not touched. Period keys `P1/P2/EX1/EX2/PEN` are removed from Phase 1.

### 4. Commands, remapping with fewer than 11 players, and replay (resolved)

* `SWITCH_TACTIC_PLAN` goes through `applyCommand()` / `accept()`, so it is written to `commandLog` and replays correctly. Like `SET_INSTRUCTIONS`, it waits for `isStoppage(state)`, and a newer one replaces any queued one for the same team.
* When it runs, it does the following in order: set `baseFormationId`, call `setFormation`, call `reduce` if fewer than 11 players remain, call `setInstructions` with the plan's trained profile, then call `refreshTeamKnobs`.
* It emits `FORMATION_CHANGE` with `meta.plan`. This avoids adding a new event type and new commentary entries. The report uses these events to work out how many minutes each plan was used.
* Remapping reuses the exported `computeOptimalSlotAssignments` (an exact Hungarian solver). Slot `0` stays with whoever is currently in goal, including an outfield player who took over after the goalkeeper was sent off.
* The AI opponent's tactic is chosen from `matchSeed` outside the engine and written into `MatchInput.away` before `MatchEngine.create()`. `validateMatchInput()` rejects invalid snapshots up front: familiarity must be a finite number from 0 to 100, and formation and instruction IDs must exist.

### 5. Post-Match Report and persistence (resolved)

* **Ratings come from the engine's existing calculation.** `buildMatchResult()` gets one new line, `rating: p.rating`. `p.rating` already comes from `src/engine/stats/Rating.js`. MOTM is the player with the highest `rating` among players with `minutes > 0`. Ties are broken in this order: goals, assists, minutes, then `index`.
* **The report builder lives in `src/runtime/matchday/`**, so the 85% coverage gate covers it. It does three things:
  * It matches `VAR_DECISION` events (`goalDisallowed`, `redCardUpgraded`) against `GOAL`, `ASSIST` and card events.
  * It converts event ticks into match minutes. For this it uses the tick of the `HALF_TIME` event and `matchMinuteLabel`.
  * It reads plan minutes from the `FORMATION_CHANGE` events that carry `meta.plan`.
* **Familiarity is saved once, when the match reaches `FULL_TIME`.** A per-match `persisted` flag guards the save. Saving on the Next Match tap was rejected because a double tap could add the gain twice, and closing the app first would lose it.
* **Storage format.** A versioned record `{ schemaVersion: 1, scopeId, … }` is wrapped around `capacitorStorage()`. Tests inject `memoryStorage()` instead. Loaded values are clamped to 0–100. If the JSON is corrupt or the version is unknown, the store falls back to the defaults.

### 6. Mobile UX (resolved)

* **Pre-Match:** two tabs (`Tactics` | `Squad`) and a sticky `Kick Off` bar.
* **Post-Match:** three tabs (`Summary` | `Events & Stats` | `Ratings`) and a sticky `Next Match` bar. A short note tells the player that the squad will be fresh next match and that tactics and familiarity carry over.
* **In-Match:** when the player changes instructions by hand, a live preview shows the change in familiarity, for example `86% → 79%`, with a warning when the value drops below 80 or 50. A one-tap "Reset to plan" button restores the trained profile. While `SWITCH_TACTIC_PLAN` is queued, the HUD shows a pill that can be cancelled.

### 7. Locked familiarity math

| Item | Rule |
| :--- | :--- |
| Effective familiarity | `raw = clamp(0, 100, Math.round(0.6 * formFam + 0.4 * instrFam_live))` |
| Fluid gate (minimum-part cap) | `eff = Math.min(formFam, instrFam_live) < 65 ? Math.min(raw, 79) : raw` |
| Override penalty | `instrFam_live = max(0, instrFam - 12 * changedInstructions)`, where `changedInstructions` is the number of the 9 instructions whose option differs from the active plan's trained profile. If it is above 0, the plan shows as `Modified`. |
| 80–100 | `familiarityKnobs = null` (no effect at all) |
| 50–79 | `noiseMul` ramps linearly from 1.00 at 80 to 1.06 at 50; `drainMul` stays at 1.00 |
| 0–49 | `noiseMul` ramps linearly from 1.06 at 50 to 1.12 at 0; `drainMul` ramps from 1.00 at 50 to 1.05 at 0 |
| Gain for each plan used (`minutes > 0`) | `gain = max(1, round(4 * minutes / 90))`. If the plan was `Modified`: `max(1, round(gain / 2))` |
| Unused trained Plan B | `+1` if its value is below 80 |
| Cap | Every stored value is clamped to 0–100 |

**Stress-test notes on these numbers:**

* **Tweaks drop below Fluid faster than first described.** Earlier in the brainstorm, the expectation was that "tweaking 1–2 knobs stays Fluid from 85%+". With the Fluid gate, the formula gives this instead:
  * From `formFam = instrFam = 85`: one changed instruction gives `instrFam_live` 73 and `eff` 80 (still Fluid, just). Two give `instrFam_live` 61, which is below 65, so the tactic is capped at Competent.
  * From `instrFam` 90: two tweaks leave 66, which is still Fluid. Three leave 54, which is capped.
  * Two tweaks therefore stay Fluid only if `instrFam` starts at 90 or more. The live preview must show this.
* **In practice, the Fluid gate only ever applies to instruction familiarity.** It cannot be triggered by formation familiarity: with `formFam` 64 and `instrFam` 100, `raw` = round(38.4 + 40) = 78, which is already below 80. So the gate in effect means "Fluid needs `instrFam_live ≥ 65`". `Math.min(…)` is kept anyway so the rule still holds if the 60/40 weights change later.
* **The cap mainly changes the label, not the play.** At 79, `noiseMul` = 1.002 compared with 1.000 at 80. What the gate really controls is the Fluid label and the guarantee that the penalty code does nothing at Fluid. Its effect on the match itself is close to zero.
* **The bar can jump at the gate.** With `formFam` 100, raising `instrFam` from 64 to 65 moves `eff` from 79 to 86 in one step. The Post-Match Report should show this as "Fluid unlocked" rather than a plain +7, so it doesn't look like a bug.
* **The penalties may be too small to notice.** `tempo: fast` already applies `noiseMul 1.05`, and `marking: man` applies `drainMul 1.08`. The worst familiarity penalty (`noiseMul 1.12`, `drainMul 1.05`) is about the same size as one existing instruction. That keeps calibration bands safe, but players may not feel the difference. Phase 1 should run an Unfamiliar team (eff 30) through `scripts/calibrate-instructions.mjs` to measure the effect before changing the constants.
* **The penalty has no visible signal yet.** The penalty only adds noise to decisions. Without some cue (for example, a count of misplaced passes in the report), "Unfamiliar" will look like bad luck to the player. This is deferred, not dropped.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * 10 default tactics in `config/tactical-presets.yaml`: 7 new formations plus the existing `4-3-3` and `4-4-2`. They use the existing 6 engine roles and the `emergencyShape` fallback.
  * Familiarity stored in a versioned `TacticalFamiliarityStore`. Formation familiarity is keyed by formation ID, and instruction familiarity is keyed by tactic ID.
  * A Pre-Match screen on `""` with two tabs: Plan A and B, Starting XI and 7-man bench, a mini-pitch with a Plan B preview, role-fit indicators, Auto-Pick for Plan A, and Kick Off. `#match` stays as a direct way into the live match.
  * Live Plan A/B switching through `SWITCH_TACTIC_PLAN`, queued until the next stoppage, with remapping by the Hungarian solver. Manual instruction tweaks keep working, with the penalty, the `Modified` badge, a live preview and a reset button.
  * A Post-Match Report in `src/runtime/matchday/` with three tabs: score and scorers, MOTM, key events with VAR reversals applied, team stats (reusing `StatsView`), player ratings (from engine `p.rating`) and familiarity changes. It is followed by a Next Match loop.
  * `tests/golden/seeds.json` stays unchanged. `en-GB` and `pt-PT` have matching keys, and every quality gate passes: `build:config --strict-i18n`, `test`, `test:coverage` (85%), `lint`, `typecheck`, `build` and `test:e2e`.

* **Out-of-Scope Non-Goals:**
  * Extra time, penalty shootouts, and the `P1/P2/EX1/EX2/PEN` labels. The engine has no support for them, and `H1/H2` stay as they are.
  * New `Phase.js` mechanics or new knobs.
  * New instructions, such as an always-on pressing setting or a width setting for when the team does not have the ball. Presets map onto the existing 9 instructions (see Draft Specifications §1).
  * Expanding `config/roles.yaml`, or writing `reducedTo` shapes for each new formation.
  * Career/Season features: calendar, training, carrying over injuries, suspensions or fatigue, and transfers.
  * An AI that switches plans or plays unfamiliar tactics. The AI stays at 100%.
  * A second rating formula outside the engine.
  * Changing the sample squads (each already has 3 CBs).

## Alternatives Weighed

1. **Smaller Phase 1 (`egm-zoom-out`): 3–4 presets, one starting tactic, familiarity and Plan B deferred.** *Rejected by author:* the 10-tactic library, Plan A/B and familiarity define the data contract Career Mode needs. Scope is kept down by dropping extra time and penalties, phase-lag and a duplicate rating formula instead.
2. **Runtime computes familiarity and sends it with each command.** *Rejected by author:* headless runs, `MatchEngine.replay()` and command logs would then depend on the runtime.
3. **A new phase-transition-lag knob in `Phase.js`.** *Rejected by author:* it adds a new mechanic that needs its own calibration. `noiseMul` and `drainMul` are enough. (Reusing `transitionAttMul` was also rejected, because it would reward unfamiliar teams.)
4. **A `reducedTo` shape for each new formation (up to 14 extra shapes).** *Rejected by author:* too much to maintain and calibrate. `emergencyShape` is enough for Phase 1.
5. **A separate rating formula in the report layer.** *Rejected by author:* `Rating.js` already calculates `p.rating`, so it is exposed through `MatchResult.players` instead.
6. **A new remapping algorithm for plan switches.** *Rejected by author:* `computeOptimalSlotAssignments` already finds the best player-to-slot assignment.
7. **Rendering extra time and penalties in the report as a placeholder.** *Rejected by author:* `MatchClock.js` has only two halves, so that code could never run in a real match.
8. **E2E URL `/#match?seed=22`.** *Rejected on code check:* `matchSeedFrom` reads only `location.search`, so the test seed would be ignored. The tests use `/?seed=22#match` instead.
9. **Penalising each changed knob.** *Rejected on code check:* a single option can change up to 7 knobs, so the penalty counts changed instructions instead.
10. **Saving familiarity on the Next Match tap.** *Rejected (Goldfish `egm-design`, accepted by author):* a double tap would add the gain twice, and closing the app first would lose it. The save happens once at `FULL_TIME`.
11. **Changing the 60/40 split so instruction familiarity matters more.** *Rejected by author:* the 60/40 split stays. A minimum-part cap is used instead: if either part is below 65, `eff` is capped at 79. This stops a tactic that has never been used from becoming Fluid just because its formation is mastered.
12. **Accepting that a mastered formation makes every tactic on it Fluid.** *Rejected by author:* under that rule, `tiki-taka` would become Fluid without ever being played, and 3 tweaks on a mastered formation would still count as Fluid.

## Key Decisions & Staging for Next Steps

**Locked:** everything in Analysis §1–§7 and in Goals above.

**Defaults chosen in this brief.** `/egm-draft` should confirm these or override them:

1. **Formation gain when both plans use the same shape.** For example, Plan A `balanced` and Plan B `tiki-taka` both use `4-3-3`. Formation familiarity gets a single gain based on the *combined* minutes in that formation, so it is not credited twice. Instruction familiarity gets a gain for each tactic separately.
2. **The gain goes to both parts.** A plan's `gain` is added to `formFam[formationId]` and to `instrFam[tacticId]`. The `Modified` halving applies to both.
3. **Familiarity values on first launch.** *Locked by author.* See Draft Specifications §3.
4. **Tactics drawer under `#match` (no snapshot).** With no Plan A/B snapshot, the live drawer keeps the existing formation buttons. That keeps `ui-flows.spec.js:103-104` (`[data-formation="4-4-2"]`) passing. The Plan A/B pills replace those buttons only when a snapshot exists.
5. **Diamond formation ID.** *Locked by author:* `4-1-2-1-2`, displayed as "4-4-2 Diamond" / "4-4-2 Losango".
6. **What a queued switch does to the Manager panel.** A queued `SWITCH_TACTIC_PLAN` behaves like `INSTRUCTIONS` in `managerPending.js`: it does not lock the panel and can be replaced. A `SET_INSTRUCTIONS` queued after it applies on top of the new plan's profile, and counts toward `Modified`.

**Now specified:** instruction profiles, formation coordinates, starting familiarity and i18n keys. See Draft Specifications below.

**Still for `/egm-draft` to specify:** new error codes in `ui-strings.schema.json`, plus the debug fields for active plan and familiarity split in `inspectPitch` and `devHooks`.

## Draft Specifications

### §1. Instruction profiles (`config/tactical-presets.yaml`)

Only options that differ from the default are listed. Every key is a valid option in `config/tactics.yaml`.

| # | Tactic ID | Formation | Profile |
| :- | :--- | :--- | :--- |
| 1 | `balanced` | `4-3-3` | `{}` |
| 2 | `gegenpress` | `4-2-3-1` | `{tempo: fast, directness: direct, defensiveLine: high, defensiveTransition: counterPress, tackling: getStuckIn}` |
| 3 | `tiki-taka` | `4-3-3` | `{tempo: slow, directness: short, defensiveLine: high, defensiveTransition: counterPress}` |
| 4 | `vertical-tiki-taka` | `4-1-2-1-2` | `{tempo: fast, directness: short, attackFocus: center, defensiveLine: high}` |
| 5 | `control-possession` | `4-1-4-1` | `{tempo: slow, directness: short}` |
| 6 | `wing-play` | `4-4-2` | `{attackFocus: wings}` |
| 7 | `fluid-counter` | `3-5-2` | `{tempo: fast, attackTransition: counter}` |
| 8 | `direct-counter` | `3-4-3` | `{tempo: fast, directness: direct, attackTransition: counter, defensiveLine: low, defensiveTransition: regroup}` |
| 9 | `route-one` | `4-2-4` | `{tempo: fast, directness: direct, attackFocus: center}` |
| 10 | `low-block` | `5-4-1` | `{tempo: slow, attackFocus: center, defensiveLine: low, defensiveTransition: regroup}` |

`attackTransition: counter` in `fluid-counter` and `direct-counter` was not in the original request. *The author confirmed it.*

The 10 profiles are all different from one another. `build-config.mjs` should reject two presets that have the same formation *and* the same profile.

**How the request was mapped, and where it does not fit the engine:**

* **There is no pressing instruction.** The closest options are these:
  * "High pressing" maps to `defensiveTransition: counterPress`, which presses straight after losing the ball, plus `defensiveLine: high`, which moves the back and midfield lines up the pitch.
  * "Low pressing" maps to `defensiveTransition: regroup`.
  * "Balanced pressing" is the default.
  * The engine has no option for pressing harder all the time, only right after losing the ball.
* **There is no separate width instruction.** Width belongs to `attackFocus`: `wings` widens the team (`widthMul 1.08`) and `center` narrows it (`0.96`). "Narrow width" and "central focus" are therefore the **same option**. `widthMul` also only applies *with the ball*. So low-block's "narrow" makes the team narrower when it has possession, not when it is defending. The engine has no setting for compactness without the ball. Low-block's hint text avoids the word "narrow" for this reason.
* **There are no "very" levels.** "Very direct" maps to `direct`, and "very low" maps to `low`. Route-one's passing is therefore the same as gegenpress's, and direct-counter's line is the same as low-block's.
* **Where the request gave two choices (a/b), one was picked:**

  | Tactic | Request | Picked | Why |
  | :--- | :--- | :--- | :--- |
  | `tiki-taka` | narrow/standard width | standard (default) | `vertical-tiki-taka` already uses `center` |
  | `tiki-taka` | high/balanced press | `counterPress` | |
  | `control-possession` | standard/high line | standard (default) | so it differs from `tiki-taka` |
  | `wing-play` | standard/fast tempo | standard (default) | |
  | `fluid-counter` | mid/low line | standard (default) | so it differs from `direct-counter` |
  | `fluid-counter` | balanced/low press | balanced (default) | |
  | `route-one` | high/balanced line | standard (default) | a high line behind long balls leaves a large gap in midfield |
  | `low-block` | direct/mixed passing | mixed (default) | `slow` tempo plus `direct` passing pull in opposite directions |
* **Counter tactics use `attackTransition: counter`.** This is the option built for counter-attacks: a longer `TRANSITION_ATT` window (`×1.5`) and forwards and midfielders pushing up by 4 m. Without it, `fluid-counter` would only be `{tempo: fast}`, which plays like Balanced with a faster tempo. *The author confirmed it.*
* **Gegenpress uses `tackling: getStuckIn`, not `marking: manToMan`.** The reason is that stamina drain stacks:
  * `fast` (1.04) × `high` (1.03) × `counterPress` (1.02) already gives `drainMul` = 1.093.
  * Adding `manToMan` (1.08) would raise it to 1.180, and to 1.239 if the team were also Unfamiliar.
  * `manToMan` also sets `screenMul: 0`, which turns off back-line screening behind a high line.
* **Calibration gap.** `calibrate-instructions.mjs` tests one option at a time against a default side. The presets combine several options. The draft must add a check that plays each preset against `balanced` across the existing metric bands. The tactics most likely to drift are `gegenpress` (stamina) and `route-one` / `direct-counter` (interceptions).

### §2. Formation coordinates (`config/tactics.yaml`)

**Interpretation.** Each given point is the slot's `defend` anchor, which is the value `positionCode()` reads.

**Adjustments made to match the scale of the existing formations.** The existing formations use GK 0.04, CB 0.20, FB 0.24, wide midfield W 0.40, forward W 0.50 and ST 0.55. The adjustments:

* GK 0.06 → **0.04**.
* Four-man back lines: CB 0.18 → **0.20** and FB 0.22 → **0.24**.
* Back three: wide CBs → **0.20**, central CB → **0.19**.
* 5-4-1 CBs → **0.19 / 0.18 / 0.19**.
* Forward W 0.56 → **0.50**.
* ST 0.62/0.63 → **0.55**, and 5-4-1 ST 0.58 → **0.52**.

Midfield values and every value that a label threshold depends on are unchanged. Slots are listed goalkeeper first, then back to front, left to right within each line.

| Formation | Slots `role (x, y) → label` |
| :--- | :--- |
| `4-2-3-1` | GK (.04,.50) · FB (.24,.14) LB · CB (.20,.38) · CB (.20,.62) · FB (.24,.86) RB · MF (.31,.38) DM · MF (.31,.62) DM · W (.48,.16) LW · MF (.48,.50) AM · W (.48,.84) RW · ST (.55,.50) |
| `4-1-2-1-2` | GK (.04,.50) · FB (.24,.14) LB · CB (.20,.38) · CB (.20,.62) · FB (.24,.86) RB · MF (.30,.50) DM · MF (.40,.32) LCM · MF (.40,.68) RCM · MF (.49,.50) AM · ST (.55,.38) · ST (.55,.62) |
| `4-1-4-1` | GK (.04,.50) · FB (.24,.14) LB · CB (.20,.38) · CB (.20,.62) · FB (.24,.86) RB · MF (.30,.50) DM · W (.44,.14) LM · MF (.41,.36) CM · MF (.41,.64) CM · W (.44,.86) RM · ST (.55,.50) |
| `3-5-2` | GK (.04,.50) · CB (.20,.28) · CB (.19,.50) · CB (.20,.72) · FB (.34,.12) LWB · MF (.31,.50) DM · MF (.42,.34) LCM · MF (.42,.66) RCM · FB (.34,.88) RWB · ST (.55,.38) · ST (.55,.62) |
| `3-4-3` | GK (.04,.50) · CB (.20,.28) · CB (.19,.50) · CB (.20,.72) · FB (.35,.12) LWB · MF (.38,.38) CM · MF (.38,.62) CM · FB (.35,.88) RWB · W (.50,.18) LW · ST (.55,.50) · W (.50,.82) RW |
| `4-2-4` | GK (.04,.50) · FB (.24,.14) LB · CB (.20,.38) · CB (.20,.62) · FB (.24,.86) RB · MF (.38,.38) CM · MF (.38,.62) CM · W (.50,.16) LW · ST (.55,.38) · ST (.55,.62) · W (.50,.84) RW |
| `5-4-1` | GK (.04,.50) · FB (.24,.12) LB · CB (.19,.30) · CB (.18,.50) · CB (.19,.70) · FB (.24,.88) RB · W (.38,.16) LM · MF (.34,.38) CM · MF (.34,.62) CM · W (.38,.84) RM · ST (.52,.50) |

**Label check against `positionCode()`.** Every label in the table above is what the current code produces. The ones worth noting:

* The diamond's side midfielders at y 0.32 / 0.68 are labelled **LCM/RCM** (`MCE/MCD`), not `MC`.
* The 4-1-4-1 central midfielders sit exactly on the band edges (y 0.36 / 0.64) and are labelled `CM`. Moving either by 0.001 changes the label to LCM/RCM.
* The 5-4-1 full-backs (x 0.24) are labelled LB/RB, not wing-backs.
* The draft should add one unit test per formation that asserts these labels.

**Deriving the other slot fields.** The request gave only one point per slot, but every slot also needs `attack`, `follow`, `pressZone` and `markZone`. These are copied from the matching role in `4-3-3` / `4-4-2`:

| Role | `attack.x` = `defend.x` + | `follow` | `pressZone` / `markZone` |
| :--- | :--- | :--- | :--- |
| GK | 0 | [0.08, 0.10] | 0 / 0 |
| CB | 0.14 | [0.25, 0.20] | 10 / 10 |
| FB (x < 0.32) | 0.18 | [0.30, 0.25] | 12 / 10 |
| FB as wing-back (x ≥ 0.32) | 0.20 | [0.30, 0.25] | 12 / 10 |
| MF as DM (x < 0.33) | 0.12 | [0.40, 0.25] | 14 / 12 |
| MF, other | 0.15 | [0.40, 0.30] (central y = 0.5: [0.40, 0.25]) | 14 / 12 |
| MF as AM (x ≥ 0.45) | 0.18 | [0.40, 0.25] | 14 / 12 |
| W, wide midfield (x < 0.45) | 0.22 | [0.40, 0.30] | 12 / 10 |
| W, forward (x ≥ 0.45) | 0.28 | [0.35, 0.30] | 10 / 8 |
| ST | 0.30 | [0.35, 0.20] | 10 / 8 |

`attack.y` equals `defend.y`, except that FB, wing-back and W slots move 0.02 further towards the touchline, as the existing formations do. All 7 formations use `reducedTo: {}`. `4-3-3` and `4-4-2` are not touched, because changing them would break the golden seeds.

### §3. Starting familiarity (first launch)

| Formation | `formFam` | | Tactic | `instrFam` | Effective | Tier |
| :--- | :-: | - | :--- | :-: | :-: | :--- |
| `4-3-3` | 90 | | `balanced` | 90 | **90** | Fluid |
| `4-3-3` | 90 | | `tiki-taka` | 50 | **74** | Competent |
| `4-4-2` | 85 | | `wing-play` | 60 | **75** | Competent |
| `4-2-3-1` | 60 | | `gegenpress` | 50 | **56** | Competent |
| `4-1-4-1` | 55 | | `control-possession` | 55 | **55** | Competent |
| `5-4-1` | 50 | | `low-block` | 50 | **50** | Competent |
| `4-1-2-1-2` | 50 | | `vertical-tiki-taka` | 45 | **48** | Unfamiliar |
| `3-5-2` | 45 | | `fluid-counter` | 50 | **47** | Unfamiliar |
| `3-4-3` | 45 | | `direct-counter` | 45 | **45** | Unfamiliar |
| `4-2-4` | 45 | | `route-one` | 40 | **43** | Unfamiliar |

On first launch, Plan A is `balanced` (90) and Plan B is `wing-play` (75). Switching to Plan B during a match gives `noiseMul` ≈ 1.01.

**How long improvement takes.** Played as Plan A for the full 90 minutes, a tactic gains +4 on both parts each match.

* `fluid-counter` reaches Fluid after **9 matches**. After 9, `formFam` is 81, `instrFam` is 86 and `eff` is 83. After 8, `eff` is 79.
* `tiki-taka` reaches Fluid after **4 matches** (`instrFam` 50 → 54 → 58 → 62 → 66). That is more than "a couple".
* Used only as a 30-minute Plan B, a tactic gains `round(4 × 30/90)` = +1 per match. At that rate, `tiki-taka` would take about **15 matches** to unlock.

**Shared-formation Fluid gate.** *Locked by author.* The 60/40 split stays, plus a minimum-part cap: if `Math.min(formFam, instrFam_live) < 65`, `eff` is capped at 79. Playing `balanced` until `4-3-3` reaches 100 no longer makes `tiki-taka` Fluid: its raw value of 80 is capped to 79. On a mastered formation, the most instruction tweaks that still count as Fluid falls from 3 to 2 (from `instrFam` 90). The unit tests must cover both sides of the threshold: (`formFam` 100, `instrFam_live` 64) → 79, (100, 65) → 86, and (64, 100) → 78, where the gate changes nothing.

### §4. i18n keys (`en-GB` / `pt-PT`)

All keys from the request are accepted: `tactics.formations.*`, `tactics.presets.*.name`, `tactics.plan.*`, `preMatch.*` and `matchReport.*`. These additions are needed for the keys to be complete:

* **`tactics.formations.4-3-3` and `tactics.formations.4-4-2`.** Without them, the UI would show translated labels for new formations next to raw IDs for the old ones.
* **The `.hint` text for each preset was missing.** Proposed text:

  | Preset | en-GB | pt-PT |
  | :--- | :--- | :--- |
  | `balanced` | Default shape and instructions | Forma e instruções padrão |
  | `gegenpress` | Wins the ball back high · tires players fast | Recupera a bola alto · cansa os jogadores depressa |
  | `tiki-taka` | Patient short passing · fewer shots | Passe curto e paciente · menos remates |
  | `vertical-tiki-taka` | Quick short passes through the middle · more interceptions | Passe curto e rápido pelo meio · mais interceções |
  | `control-possession` | Keeps the ball safely · slow to create chances | Guarda a bola com segurança · cria ocasiões devagar |
  | `wing-play` | Attacks down the flanks · fewer central entries | Ataca pelas alas · menos entradas pelo meio |
  | `fluid-counter` | Breaks quickly after winning the ball · fewer passes completed | Sai rápido após recuperar · menos passes certos |
  | `direct-counter` | Sits deep and goes long on the break · concedes territory | Defende recuado e sai em profundidade · cede terreno |
  | `route-one` | Long balls to the strikers · more passes intercepted | Bolas longas para os avançados · mais passes intercetados |
  | `low-block` | Defends deep · few chances created | Defende recuado · cria poucas ocasiões |
* **Keys needed by UX decisions already accepted:**

  | Key | en-GB | pt-PT |
  | :--- | :--- | :--- |
  | `tactics.plan.formation` | Formation | Formação |
  | `tactics.plan.instructions` | Instructions | Instruções |
  | `tactics.plan.dropsTo` | Drops to {tier} | Desce para {tier} |
| `tactics.plan.partBelowMin` | {part} below {min}% · capped at Competent | {part} abaixo de {min}% · limitado a Competente |
| `matchReport.fluidUnlocked` | Fluid unlocked | Fluido desbloqueado |
  | `preMatch.planMustDiffer` | Plan B must be a different tactic | O Plano B tem de ser uma tática diferente |
  | `preMatch.inMatchNote` | Only Plan A and Plan B are available during the match | Durante o jogo só estão disponíveis o Plano A e o Plano B |
  | `matchReport.gainMinutes` | +{n}% ({minutes} min) | +{n}% ({minutes} min) |
  | `matchReport.notUsed` | Not used | Não utilizado |
  | `matchReport.colRating` | Rating | Nota |
  | `matchReport.colMinutes` | Min | Min |
  | `matchReport.colFitness` | Fitness | Forma física |
  | `matchReport.colCards` | Cards | Cartões |
  | `matchReport.colInjury` | Injury | Lesão |
* **Schema work.**
  * `ui-strings.schema.json` sets `additionalProperties: false` at the top level and inside each group. It therefore needs new `preMatch` and `matchReport` groups, plus nested `formations`, `presets` and `plan` objects inside `tactics`.
  * The existing `tactics` keys are flat camelCase (for example `tempoSlow`), and `build-config.mjs` checks them by the rule `<id><Option>`. Nested objects inside `tactics` are new, so the draft must make sure that checker handles them or skips them.
  * Preset hints must use the same ` · ` separator as the existing hints.
* **Style.** Existing en-GB labels use sentence case ("In possession", "Attacking corridor"). The new en-GB labels should follow it: "Kick off", "Next match", "Key events", "Full-time report", "Matchday setup", "Tactical familiarity", "Auto-pick best XI". Proper terms keep their capitals: "Plan A", "Starting XI", "Man of the Match". pt-PT already mixes the two styles ("Com Bola", "Corredor de ataque"), so the pt-PT text is used as given.

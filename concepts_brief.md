# freefoot Match Engine and v1 Single-Match UI

* **Author:** bytemania
* **Date:** 2026-11-22

## Overview

freefoot will be a Football Manager-style career and league game. This brief
covers its core part: the match engine, plus a v1 screen that shows one match
on an Android phone held upright.

The engine is a set of plain ES6 classes with no DOM access. Given the same
seed and the same commands, it always produces the same match. Each tick it
moves 22 players and the ball across a 2D pitch. Every few tenths of a second
each player picks an action: pass, dribble, tackle, shoot or cross. An action
succeeds or fails based on real distances, how many defenders are close, and
the player's attributes (1–20 scale, weighted by role). Fitness, cards and
injuries change how players perform during the match. Morale and coach
authority are deferred to v2 behind a single `getEffectiveAttribute` hook.
The simulation runs at 20 Hz and the Canvas draws at 60 FPS by
interpolating positions. All weights live in YAML files. A build step compiles them to
JS modules, so the Android app (Capacitor) runs fully offline.

The career game will call the engine through a small API: create it from
serialisable input (rosters, coaches, formations, seed), then `step`,
`applyCommand` (subs, formation changes), and read snapshots, stats and events.

The v1 UI has a scoreboard, a vertical Canvas pitch, a speed slider from 0x to
60x, a Full Match / Best Moments toggle, live commentary in pt-PT and English,
a stats panel and a manager panel. The opponent is run by a simple rule-based
AI coach.

A headless Node runner simulates 500–1,000 matches in each of two scenarios
(balanced and mismatch). It checks that the engine's statistics fall inside
real-football ranges.

## Analysis

The review ran seven independent reviewers, each starting with no memory of
this conversation: design, codebase and reuse, scope, comprehension,
implementation readiness, document structure, and inventive problem-solving.
After deduplication they raised 9 blockers, 23 major issues and 10 minor ones.
They are grouped by theme below.

### 1. The time model is the central unresolved problem

Six of seven reviewers found the same mistake in the facilitator's
assumption, which the author accepted: that determinism removes the need to
re-simulate from a saved state. It is the other way round. Determinism is what
makes re-simulation cheap and correct, but it does not remove the need for
it.

If the worker has simulated ahead to tick H and the user issues a command at
the tick on screen, D (where D is before H), the engine needs the complete
state at D. It can only get that state by storing a full copy of every tick,
or by loading an earlier saved state and re-simulating forward to D. The
450-tick ring buffer can't do either, because it holds drawing data
(positions), not the full engine state. The "1–2 s lookahead" also had no
unit. 1–2 seconds of match time is about 120 ticks. 1–2 seconds of real time
at 60x is about 7,200 ticks.

There are three ways out:

* **Pull model, no lookahead.** Each animation frame, the UI asks the engine
  for exactly the ticks it is about to draw. At 60x that is about 60 ticks
  per frame at 60 Hz, or 10 at 10 Hz, which is cheap. Nothing is ever
  simulated ahead, so nothing is ever thrown away. Most reviewers prefer
  this.
* **Command delay rule.** A command takes effect at the displayed tick plus a
  "touchline reaction delay". The delay is never shorter than the lookahead,
  so the engine never needs to go back. This fits the idea that coach
  authority slows the team's response.
* **Keyframes plus re-simulation.** Save the full state every K ticks. To
  reach any tick T, load the last keyframe before T and re-simulate at most K
  ticks.

Whichever is chosen, the same mechanism should handle commands, Best Moments
replays, saving and resuming, and reproducing bugs.

The full engine state also has to be written down before any code. It
includes:

* every random-number generator's internal state
* each player's decision timer and pending action
* where the ball is flying and who it is meant for
* the restart state machine
* the clock and added time
* injury and stoppage timers
* the sub count, and the AI coach's thresholds that have already fired
* fitness and morale accumulators
* stats totals and the event counter

All of this must sit in one tree, with entities referring to each other by
index or ID and never by object reference. Structured clone (used by
`postMessage`) drops class prototypes and `#private` fields, and object
references break when state is restored. The test that guards this: run to
tick T1, save, restore, run to T2, and check that the state hash matches an
uninterrupted run.

There should be two separate snapshot types:

* **Drawing snapshot:** positions, ball, clock and score, in a flat typed
  array. Cheap and lossy.
* **Full engine state:** complete and restorable.

Events and stat changes need a tick stamp. The UI releases them only when the
pitch has reached that tick, so commentary never shows a goal before the
pitch does.

### 2. Determinism and random numbers

* **mulberry32 is not good enough for calibration.** Every seed lands on the
  same 2^32-step cycle. At 3–4 million draws per match, 1,000 seeds overlap
  about 800 times, so the matches are not independent samples. Use sfc32 or
  xoshiro128** seeded through splitmix32, or the `pure-rand` package.
* **One random stream is fragile.** Adding a single random draw anywhere
  changes every later outcome. That breaks saved bug reproductions and golden
  tests. Give each subsystem its own stream (decisions, physics noise,
  officiating, injuries, AI coach), each derived from the seed.
* **The UI must never touch the simulation's random numbers.** If picking a
  commentary line used the engine's random generator, switching between
  pt-PT and English would change the match. Commentary should use its own
  generator, seeded from the match seed and the event number. A test checks
  that the event stream is identical in every speed and mode.
* **"Deterministic within V8" is weaker than it sounds.** Android System
  WebView updates itself, and its V8 version differs from Node's. Functions
  such as `Math.sin`, `atan2`, `exp` and `pow` have changed results between
  V8 versions. Basic arithmetic, `sqrt`, `imul` and `fround` are exact
  everywhere. The fix:
  * A lint rule bans those functions, `Math.random`, `Date` and
    `performance.now` from the engine folder.
  * Replace them with polynomial versions or lookup tables, and loop over
    players in a fixed order.
  * With that in place, the same match comes out bit-for-bit in Node,
    WebView, desktop browsers and any future iOS build.

### 3. Tick rate and speed

Every reviewer questioned running everything at 60 Hz:

* Decisions already happen only 4–5 times per second.
* At 10x–60x the screen shows only 1 tick in 10–60.
* Estimates are 1.7–7 s per match in Node, and 10–30 s on a mid-range Android
  WebView. A 1,000-match scenario on one core would take 30–120 minutes.

The suggested alternative:

* Run a fixed simulation step of 10–20 Hz and smooth player movement on
  screen at 60 FPS.
* At 20 Hz the ball moves about 1.5 m per step, so check ball interception
  along its path (or sub-step the ball) to avoid missing contacts.
* Express every rate in seconds, not ticks, so the tick rate is one constant
  you can change.
* Before building content, measure how many ticks per second a low-end
  target phone can run, and treat that number as a hard gate.

### 4. Best Moments

* **The buffer only holds the lead-up.** The resolution of a highlight
  (the ball hitting the net, the keeper's save, the rebound) happens after
  the trigger. Some triggers, such as "major save", "woodwork" and "big
  chance", are only known once the play resolves. Counter-attacks often take
  10–30 s, longer than the 7.5 s buffer.
* **Suggested flow:**
  1. Keep simulating until the next dead ball (kick-off, corner, goal kick,
     foul), capped at a few seconds.
  2. Pause there.
  3. Replay from a keyframe before the lead-up, at 1–2x.
  4. Let the manager act.

  Football only allows changes at dead balls anyway.
* **Commands during a replay.** The pitch on screen is in the past at that
  point. A command applied "at the displayed tick" would rewrite the goal the
  user just watched. In Best Moments, commands must apply at the pause tick.
* **Two kinds of pause.** The fast simulation must also stop for events the
  manager has to act on: a serious injury, a red card, a forced sub.
  Otherwise the forced-sub prompt arrives minutes late. Full Match at 60x
  needs the same rule, with a timeout and a default choice.
* **Missing rules:** how close events are merged into one replay, and a
  limit on replays per match. 15–25 moments at 10–15 s each comes to about
  4–6 real minutes.

### 5. Calibration

* **The hard pass, as written, would pass a badly wrong engine.** The bands
  describe how much one match varies from the next. The average of 500
  matches varies very little (standard error for shots ≈ 0.18), so almost
  any average lands inside a wide band. Several other things are undefined:
  * whether each metric is per team or per match
  * which metrics are "core flow"
  * what "near target" means for soft passes
  * what the 20–30% cross completion is measured against
  * Scenario B ranges for anything beyond possession and xG
* **Fix: one calibration table.** Each row has:
  * metric
  * unit (per team or per match)
  * formula from events
  * Scenario A range and Scenario B range
  * hard or soft, with a tolerance
  * reference data source (Opta, StatsBomb or Wyscout)

  Check that the 10th–90th percentile spread across matches falls inside the
  band, not just the average. Check that goals have a realistic spread
  (roughly Poisson). Exit with a failure code when a hard band is missed.
  Write the config hash, engine version and seeds into every report.
* **Layered tuning will go round in circles.** Changing tackling changes
  possession, which changes passes, which changes shots. The fix:
  * Re-check every band after every change.
  * Measure how much each weight moves each metric.
  * Let an optimiser (CMA-ES, or Optuna reading CSV output) search the
    weights, using the same seed set on every run.
  * Keep the layers as a way to read the report, not as a tuning order.
* **The xG check is circular.** If xG is the engine's own goal chance for a
  shot, matching the xG range only proves the engine agrees with itself. Use
  a fixed outside model: a logistic fit on public StatsBomb Open Data using
  distance, angle, body part and defenders in the way. Then tune the engine
  so actual goals match that model's xG for each shot type.
* **Missing headline targets:**
  * goals per match (~2.6–2.9)
  * draw rate (~22–27%) and 0–0 rate
  * when goals are scored
  * home advantage, or a statement that venues are neutral
  * Scenario B favourite win rate (~70–80%)
  * mirrored squads producing mirrored results
  * checks for absurd states, such as a player far from his position for
    a long time
* **Feedback loops.** Losing lowers morale. Low morale raises errors and
  fouls, which leads to red cards and more losing. Every multiplier needs a
  cap and morale needs a recovery rate. Test it with scenarios such as an
  early red card, comeback frequency, and low versus high coach authority.

### 6. Scope

v1 as written is several products at once. Every status system stacks on a
core that hasn't been calibrated yet, so nothing is playable or measurable
for a long time. The reviewers suggest a smaller v1: **one watchable,
believable match you can manage**. It includes:

* movement and ball physics
* the five actions: pass, dribble, tackle, shot, cross
* fouls and cards
* fitness and Aggression
* subs and the 4-3-3 / 4-4-2 switch
* one injury level that forces a sub
* the AI opponent coach
* about 15 event types, with English commentary first
* about 8 hard bands (goals, shots, shots on target, possession,
  pass completion, fouls, yellows, corners), plus xG

Morale and coach authority are the strongest candidates to defer. Without a
career layer they are fixed roster numbers that add about five interacting
knobs with no gameplay payoff yet. Leave a single
`effectiveAttribute(base, modifiers)` function so they can be added later.

Suggested build order:

1. Contracts, config build and determinism harness
2. Headless engine skeleton with a golden test
3. Movement, then physical stats
4. Actions, restarts and events
5. Stats and calibration runner, passing the hard bands before any UI work
6. Full Match canvas
7. Manager commands and AI coach
8. Best Moments
9. Commentary and translations
10. Capacitor packaging

### 7. Platform and runtime

* **A Worker may not be needed in v1.** With the pull model the engine does
  under 1 ms of work per frame. A worker adds message passing and
  out-of-order commands, and those are what caused the lookahead problem. The
  engine has no DOM access, so moving it into a worker later is mechanical.
  If a worker is kept:
  * one message format with a version number
  * drawing snapshots batched as transferable buffers
  * no SharedArrayBuffer, which needs special headers that are awkward in
    Capacitor
* **The "no file:// fetches" reason is partly wrong.** Capacitor Android
  serves the app from `https://localhost`, so fetching bundled JSON works
  offline. Compiling YAML into JS modules is still worth doing: the data is
  available at once, without async loading. The real file:// problem is
  opening the page straight from disk in desktop Chrome, so a dev server
  (Vite) is needed either way.
* **Android lifecycle.** When the app goes to the background, Android
  throttles or kills the WebView. Decide whether v1 accepts losing the match,
  or auto-pauses and saves the seed plus the command log. Also decide what
  the Android back button does during a match.
* **Canvas:**
  * scale by device pixel ratio
  * draw the static pitch once to an offscreen layer and redraw only the
    23 moving sprites
  * stop the animation loop when paused
  * no WebGL needed, and no spatial grid needed for 22 players

### 8. Config, YAML and translations

* **Validation:** whether YAML or JS modules, validate every config file
  against a schema (ajv or zod) and reject unknown keys. A typo like
  "agression" would otherwise wreck calibration silently.
* **Parser and tooling:** use a YAML parser that reports line numbers
  (`yaml` or js-yaml v4) and a Vite or Rollup YAML plugin.
* **Bookkeeping:**
  * Put a hash of the compiled config into every match input, save and
    report.
  * Keep target bands in a separate file from weights.
  * Squads are match input, not build data.
* **Portuguese grammar.** Plain `{player}` substitution can't produce correct
  European Portuguese, because articles and endings change with gender and
  number ("o guarda-redes" vs "a equipa", "do"/"da"). Use ICU MessageFormat
  (`intl-messageformat`), or store gender per entity and key template
  variants on it.
* **Build-time translation checks:**
  * every event type has a template in every language
  * every `{variable}` exists in that event's data
* **"en-EN" is not a valid language tag.** Use `en` or `en-GB`.
* **One event registry** should define each event type: its actors, its data
  fields, whether it is a key moment, and which stats it adds to. Types
  should only ever be added, never renamed.

### 9. Contracts and terms that must be defined before code

* **Terms:**
  * tick
  * the two snapshot types
  * what 0x and 1x mean
  * anchor (its coordinates and how it shifts with the ball)
  * coach authority
  * pressing trigger
  * the zone grid
  * possession and phase
  * progressive pass, key pass, big chance, recovery
  * PPDA and field tilt formulas
* **Contracts:**
  * the full attribute list and role weight tables
  * the fitness scaling formula
  * which formation slot maps to which role. Flat 4-4-2 wide midfielders
    have no role yet, so roles should be a config table, not a fixed list.
  * what a "13–15" squad means
  * the injury table (level, effect, required action, fallback)
  * the success formula for each action
  * the restart and clock state machine
  * sub and formation rules: IFAB allows 3 sub windows plus half-time, which
    clashes with frequent changes
  * second yellow means red
  * advantage
  * 10- and 9-man shapes (neither 4-3-3 nor 4-4-2 fits 10 players)
  * an injured goalkeeper with no keeper on the bench
  * error codes for invalid commands
* **Officiating:** put it behind an interface (contact situation in,
  decision out) so VAR can wrap it in v2. Offside should be a geometric check
  at the moment of the pass. Otherwise a player who is visibly onside gets
  flagged.
* **Debugging:** a "repro bundle" (engine version, config hash, seed,
  command log, final hash). Debug-build invariant checks: at most 11 players
  a side, at most one ball owner, positions on the pitch, event ticks always
  increasing.

### Inventive contradictions

| Contradiction | Way out |
| --- | --- |
| The engine should run ahead for smooth playback, but must not run ahead so commands apply exactly | UI pulls ticks; tiny cushion in Full Match; unlimited lookahead only in Best Moments, where the user has handed over control |
| A replay must show the resolution, but the buffer only holds the past | Simulate on to the next dead ball, then jump back with keyframes |
| The tick rate must be high for the ball, but low for battery and calibration speed | Ball sub-steps or path checks, players at a low rate, rates in seconds, smoothing on screen |
| Realism across ~40 linked numbers, but still tunable | Make shot, pass and tackle success pure formulas calibrated against reference tables directly. Route every status effect through about 5 capped scalars: effective attribute, decision noise, position discipline, reaction delay, foul tendency. Let an optimiser search the weights. |
| Readable classes, but flat memory for snapshots and hashes | Hot per-tick data in typed arrays behind class facades; rosters and config as plain objects |
| One simple random stream, but stable replays | A separate stream per subsystem, and no transcendental functions in the engine |

**Ideal final result.** A match is a pure function of (config hash, seed,
command log). The system stores only the seed, a tick-stamped command log and
a few full-state keyframes. Everything uses one operation, `seek(tick)`:
restore the nearest keyframe and re-simulate. That covers live playback, Best
Moments, applying commands, save and resume, bug reports (about 1 KB of JSON)
and calibration. There is no separate replay recorder or rollback system.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Deterministic, DOM-free, seeded match engine with a versioned,
    serialisable input and result contract for the future career mode
  * Spatial 2D simulation: movement toward tactical anchors, five core
    actions, attribute-based resolution, fitness, Aggression, fouls, cards,
    injuries that force subs
  * Manager commands (5 subs from a 7-player bench, 4-3-3 / flat 4-4-2) and a
    rule-based AI opponent coach, both sent through the same command path
  * Full Match playback with a 0x–60x speed slider on a portrait Canvas
  * Best Moments mode with pause, replay and manager action
  * pt-PT and en-GB commentary from YAML templates
  * Headless Node calibration runner with two scenarios, hard and soft bands
  * YAML config compiled to JS modules at build time; fully offline Android
    build via Capacitor
* **Out-of-Scope Non-Goals:**
  * Career mode, leagues, transfers, multi-match persistence
  * Referee error and VAR overturns (v2)
  * Local two-player mode
  * Tactical options beyond the two formations
  * A fast low-detail sim for other matches in a round (needed later by
    career mode)
  * iOS build (not targeted, though a transcendental-free engine keeps it
    possible)
  * Morale and coach authority calculations (v2; `getEffectiveAttribute`
    hook ready in v1)
  * Web Worker for the browser/Android engine (v2, only if profiling on a
    real phone demands it)
  * Hard-pass gating on derived metrics (PPDA, field tilt, PSxG, woodwork,
    claims, aerial split); they are logged and reported only
  * **Still proposed for deferral, pending author decision:** graded
    injuries beyond one forcing level, fine-grained goalkeeper and restart
    subtypes

## Alternatives Weighed

* **Checkpoint re-simulation every 5 match minutes (author's first
  proposal).** Rejected by author: replaying unchanged inputs from a
  checkpoint reproduces the same state, so it only matters for ticks
  simulated ahead of the screen.
* **Worker running 1–2 s ahead, commands applied at the displayed tick
  (facilitator's assumption).** Rejected by author after review: it needs
  the full state of a past tick, which the render buffer does not hold, and
  the lookahead unit was undefined. Replaced by the pull model.
* **Command delay rule (touchline delay ≥ lookahead).** Rejected by author:
  unnecessary once nothing runs ahead of the screen.
* **Web Worker in v1.** Rejected by author for v1: the pull model keeps
  per-frame engine work small, and a worker adds async message ordering.
  Revisit in v2 if profiling on a real phone shows jank.
* **Fixed 60 Hz simulation step.** Rejected by author: decisions run at
  4–5 Hz, the screen skips most ticks at high speed, and calibration cost
  grows with tick rate. Replaced by a 20 Hz step with 60 FPS interpolation.
* **Single mulberry32 stream.** Rejected by author: 2^32 shared cycle
  causes overlapping samples across 1,000 seeds; one stream makes replays
  fragile. Replaced by sfc32 (or xoshiro128**) with per-subsystem streams.
* **Morale and coach authority in v1.** Deferred by author to v2: without
  a career layer they have no source of values and add coupled tuning
  knobs with no payoff.
* **"Mean inside band" as the only hard check.** Rejected by author: a
  500-match mean has a tiny standard error, so wrong engines pass.
  Spread is now checked too (see open question on how).
* **Determinism only within V8.** Weaker than needed: WebView and Node V8
  versions differ and transcendental results have changed between versions.
  A transcendental-free engine gives cross-engine determinism instead.
* **Object graph of domain classes for per-tick state.** Under review:
  conflicts with allocation-free stepping, cheap snapshots and hashing.
  Alternative: typed arrays for hot state behind class facades.
* **450-tick render ring buffer as the Best Moments source.** Rejected as
  sufficient on its own: holds only the lead-up and not restorable state.
* **Layer-by-layer manual calibration.** Rejected as a tuning method: the
  layers are coupled. Kept as a reporting view. Optimiser plus shared seed
  set instead.
* **Engine-internal xG as the xG benchmark.** Rejected: circular. Use an
  outside fixed model.
* **Plain `{var}` substitution for pt-PT.** Rejected: can't handle gender
  and plural agreement.
* **Physics library (planck.js, matter.js).** Rejected: determinism risk;
  simple movement is a few dozen lines.
* **SharedArrayBuffer between worker and UI.** Deferred: needs special
  headers that are awkward in Capacitor; copying is cheap.
* **Event-driven "phase" simulation without positions.** Rejected for this
  engine (the pitch needs continuous positions). Kept as a candidate for the
  future career quick-sim.
* **YAML vs plain JS config modules.** Author chose YAML as the editing
  format, compiled at build time. Reviewers split: scope reviewer prefers
  JS modules if only developers edit. Schema validation is required either
  way.
* **Web Worker vs main thread in v1.** Open: scope reviewer argues the
  pull model makes a worker unnecessary in v1; others keep it to avoid jank
  on Android. Decide by profiling.

## Key Decisions & Staging for Next Steps

**Decided:**

* The engine is the core of a larger career game. Its API boundary and
  determinism matter more than UI shortcuts.
* Fully deterministic from a seed.
* YAML is the source of truth for tuning and commentary, compiled to JS/JSON
  at build time.
* v1 is single-player against a rule-based AI coach.
* All listed metrics are tracked, and they are reported in four layers:
  physical, progression, defending, chances and discipline. The 500-match
  averages for core metrics must fall inside hard bands in both scenarios;
  derived metrics get soft bands.
* v1 officiating is pure probability and geometry, with no referee error and
  no VAR.
* Best Moments pauses the background simulation, replays the highlight at
  1–2x, and allows manager changes before resuming.

**Decided in round 2 (after the Goldfish review):**

* **Time model: pull model, no Web Worker in v1.** Each
  `requestAnimationFrame`, the UI calls `engine.step(n)` for the ticks
  the speed slider asks for. The engine never runs ahead of the screen, so
  subs and formation changes apply at the current tick with no rewind.
* **Keyframes plus `seek(tick)`.** A full serialisable engine state is saved
  every 150 ticks (7.5 match seconds at 20 Hz). The same mechanism serves
  Best Moments replays, save/resume and bug reproduction.
* **Tick rate: 20 Hz simulation** (`dt = 0.05 s`, 108,000 ticks per 90
  minutes). The Canvas draws at 60 FPS by interpolating between the previous
  and current positions.
* **Morale and coach authority deferred to v2.** Every attribute read goes
  through `PlayerMatchState.getEffectiveAttribute(player, attrName)`. In v1
  it applies fitness and injury penalties; in v2 it gains morale and
  authority.
* **pt-PT and English stay in v1.** `Player` gets a `gender` field (`M`/`F`,
  default `M`) so pt-PT templates can choose o/a, do/da,
  substituído/substituída.
* **Calibration spec table.** One table states for each metric whether it
  is per team or per match, with ranges for Scenario A and Scenario B. The
  runner checks the 500-match mean and the 10th–90th percentile spread.
* **Outside xG model.** xG comes from a separate geometric logistic formula
  (distance, angle to the posts, header flag, defender proximity), fitted to
  public StatsBomb xG curves. It is independent of the engine's own
  shot-success roll.
* **Hard-pass metrics (per team, exactly 8):** goals, xG (outside model),
  total shots, shots on target, possession %, total passes, pass
  completion %, fouls committed. Cards, distance covered and everything else
  are tracked and soft-passed. The full table is logged every run.
* **Random numbers:** sfc32 (or xoshiro128**) with separate seeded streams
  (`decisionRng`, `executionRng`, `refereeRng`, `injuryRng`). Commentary and
  cosmetic rolls use their own generator outside the engine.


**Decided in round 3 (final):**

* **Spread check.** Each hard metric passes only if all three hold:
  * the 500-match mean is inside the target band
  * p90 − p10 ≥ a minimum spread
  * p10 and p90 are each within ±15–20% of real-world reference
    percentiles

  Example for per-team shots: p10 about 6–8, p90 about 17–21, and
  p90 − p10 ≥ 8. This catches both a flat engine and a chaotic one.
* **Command log.** A tick-stamped log `[{ tick, type, teamId, payload }]` is
  kept alongside the keyframes (every 150 ticks).
* **Best Moments replay.** Find the last keyframe at or before
  `triggerTick − 150`, which gives a 7.5–15 s lead-up. Restore it into a
  separate replay engine instance, apply logged commands as their ticks come
  up, and play through about 2 s after the event at 1–2x. The live engine
  is never touched by the replay.
* **Main-thread pull loop.**
  * Each frame adds `frameSeconds × 20 × speed` to a tick budget.
  * The loop steps whole ticks and draws with the leftover fraction (0–1) as
    the interpolation factor.
  * Best Moments fast-forward steps inside an 8 ms time slice per frame.
* **Swept ball checks.** Interceptions and blocks test the closest point on
  the segment from `ball.prevPos` to `ball.currPos` against each defender,
  so fast passes can't skip through a defender between steps.
* **Languages: `pt-PT` and `en-GB`** (British terms: pitch, kit, woodwork).
  Both `Team` and `Player` carry `gender` (`M`/`F`) plus prebuilt Portuguese
  article tokens (`artDef`: o/a, `contractionDe`: do/da, `contractionEm`:
  no/na) in the squad YAML.
* **Best Moments triggers:** goals, big chances (xG ≥ 0.32), woodwork,
  penalties, red cards, major saves (PSxG ≥ 0.35). After a highlight the
  match pauses with a "Continue" button, or auto-resumes after a short
  countdown unless the user opens the Tactics/Subs drawer.
* **Forced pauses:** a HIGH injury or a goalkeeper red card pauses the
  match at any speed, including 60x and Best Moments, and opens the Subs
  drawer with a prompt.
* **Clock:** 45:00 plus added time per half. Added time is computed
  deterministically from goals, subs, cards and injury stoppages (typically
  +1 to +4 in the first half, +2 to +6 in the second). There is a half-time
  tactical window before the second half.
* **Determinism and target device:** sfc32 with integer state;
  `Math.fround` where float rounding matters. The target is mid-to-low-end
  Android (Snapdragon 6-series, 3–4 GB RAM), fully offline in Capacitor.

**Residual risks to carry into `/egm-draft`:**

1. **Where the live engine pauses after a highlight.** The replay shows
   about 2 s after the trigger, but the live engine is still at the trigger
   tick. A sub made during the pause would then apply 2 s before what the
   user just saw. Fix: before pausing, advance the live engine to the
   replay's end tick. The result is identical because the engine is
   deterministic.
2. **`Math.fround` does not make `Math.sin`, `atan2`, `exp` or `pow`
   deterministic across V8 versions.** Android WebView updates itself and
   differs from Node's V8. Either ban these functions in `engine/` with a
   lint rule (use lookup tables or polynomials and unit vectors), or accept
   that Node and phone runs of the same seed may diverge. Node-side
   reproduction of a phone bug report depends on this choice.
3. **PSxG is now required in v1.** "Major save (PSxG ≥ 0.35)" is a Best
   Moments trigger, so PSxG is no longer v2-only. Shot events need
   placement (y/z at the goal line) and speed, and the draft needs a PSxG
   formula.
4. **Forced-sub edge cases:**
   * no subs left (play a man down, no prompt)
   * goalkeeper sent off or injured with no keeper on the bench (an
     outfield player goes in goal; which one?)
   * what the opponent AI does in the same situations
5. **Phone performance gate.** Measure ticks per second on a Snapdragon
   6-series phone in the Capacitor WebView before content work. That
   number decides whether the 8 ms fast-forward slice makes Best Moments
   feel responsive, and whether v2 needs the Worker.
6. **Squads.** The squad generator and the "13–15" / "16–18" / "9–11"
   ratings still need a definition (mean of role-weighted attributes?).
7. **Smaller open items:**
   * keyframe memory budget: all ~720 per match, or a ring plus the latest
   * replay merging and a per-match replay limit
   * home advantage or neutral venue
   * 10- and 9-man shapes, and which way the AI switches formation
   * geometric offside at the moment of the pass
   * Android backgrounding and the back button
   * TypeScript or JSDoc type checking
   * whether the AI coach sees perfect information
   * the `MatchResult` contract for career mode

**Decided in round 4 (resolves residual risks 1–7 above):**

* **Live pause tick.** Before pausing after a highlight, the live engine
  advances to `replayEndTick`, about 2 s after the trigger. If a second
  trigger fires inside that window, the replay is extended to cover both.
  Commands made during the pause apply from `replayEndTick`.
* **Cross-engine determinism.** `engine/` bans `Math.sin`, `cos`, `tan`,
  `atan2`, `exp`, `log` and `pow` through ESLint `no-restricted-properties`.
  It uses deterministic polynomial or lookup versions instead (`fastSin`,
  `fastCos`, `fastAtan2`, `fastExp`), plus IEEE-754 `+ − × ÷`, `Math.sqrt`
  and `Math.fround`. Goal: a phone seed reproduces bit-for-bit in Node.
* **PSxG v1.**
  * An on-target shot records a goal-mouth point `(goalY, goalZ)`, with
    `goalY ∈ [−3.66, 3.66]` m and `goalZ ∈ [0, 2.44]` m.
  * It also records a shot speed `v_shot` (m/s), taken from distance and the
    shooter's Finishing/Technique roll.
  * PSxG = base xG × a placement-and-speed multiplier. Corner placement and
    high speed push it toward 0.75–0.95; central or slow shots push it
    toward 0.05–0.15.
  * Off-target and blocked shots have PSxG = 0.
  * A saved shot with PSxG ≥ 0.35 is a Major Save trigger.
* **Forced-sub edge cases.**
  * HIGH injury with 0 subs left: the player leaves and the team switches to
    a compact emergency shape from `tactics.yaml`.
  * Goalkeeper HIGH injury or red card with no keeper on the bench (or 0
    subs left): the outfield player with the highest Reflexes + Positioning
    goes in goal and wears a keeper-shirt badge.
* **Squad generation.** Attributes are drawn from a normal distribution,
  clamped to 1–20:

  | Squad | Primary attributes | Secondary attributes |
  | --- | --- | --- |
  | Scenario A (balanced) | mean 14, sd 1.5 | mean 12.5, sd 1.5 |
  | Scenario B strong | mean 17, sd 1.2 | mean 15, sd 1.5 |
  | Scenario B weak | mean 10, sd 1.5 | mean 9, sd 1.5 |
* **Performance gate.**
  * 60x at 20 Hz is 20 ticks per frame. Those 20 ticks must run in under
    2.0 ms on the phone, which leaves about 14.6 ms of the 16.67 ms frame
    for drawing and UI.
  * Measured two ways: an in-app `#bench` view inside the Capacitor bundle,
    run on a real Android phone; and `npm run bench` in Node for CI.
  * The Node gate assumes a 6× Node-to-phone slowdown until a real phone is
    measured: 20 ticks in under 0.33 ms, so a 108,000-tick match in under
    1.8 s.

**Decided in round 5 (during drafting):**

* **Substitutions take effect at the next dead ball.** This replaces the
  round-2 wording "subs and formation changes apply immediately at the exact
  current tick".
  * Substitutions are queued, with no window limit in v1.
  * They take effect at the next throw-in, goal kick, corner, free kick,
    goal or kick-off.
  * Forced substitutions apply at once, because play is already stopped.
  * Formation switches still take effect from the tick on screen.
* **App lifecycle.** On background or the back button, the app
  auto-pauses and saves the latest keyframe, command log and input, with
  `schemaVersion` and `configHash`, using `@capacitor/preferences`. It
  offers resume on next launch.

### Decided in round 6 (after drafting)

*   **Possession = pass share.** Attempted open-play passes over both teams'
    attempted open-play passes, computed the same way in the engine and in
    the reference extractor. Ticks in control become the soft metric
    `timeOnBall%`.
*   **Reference percentiles = StatsBomb Open Data**, 2015/16 top-five league
    seasons, per team per match, computed by `scripts/build-reference.mjs`.
    Single-club collections are excluded; reference xG uses our own model.
    FBref/Opta match logs are a manual cross-check, not a data source.
*   ~~Still open: Scenario B subset~~ (closed in round 7).
*   **Scenario B reference (round 7):** top-4 vs bottom-4 fixtures of the
    same 2015/16 league table, 160 matches (160 strong + 160 weak rows).
    Added an absolute tolerance floor for near-zero percentiles, bootstrap
    intervals on reference p10/p90, and a band-vs-reference consistency
    warning.

### Decided in round 8 (review resolution, 2026-11-22)

*   **F1:** Best Moments replays from a 500-frame `RenderSnapshot` ring
    (300 lead-up, 40 post-roll, 160 extension cap). No replay engine and
    no keyframes.
*   **F2:** the save record is `{schemaVersion, engineVersion, configHash,
    config, input, commandLog, tick, stateHash, playbackState}`; resume
    re-simulates and checks the hash. The same record is the repro record,
    copied to the clipboard on Android.
*   **F3:** one `sfc32` engine stream plus a separate commentary generator,
    seeded through a `splitmix32` chain.
*   **F4:** plain objects created once; typed arrays only if `#bench`
    fails.
*   **F5:** Scenario A hard: mean in band plus p10/p90 within
    `max(tolerance × |ref|, toleranceAbs)`; `minSpread` dropped. Scenario
    B hard: strong-side possession 60–70%, xG share ≥ 0.75, **win rate
    70–80%** (added by the author). Scenario B percentiles soft; attribute
    gap frozen.
*   **F6:** `seek` removed; `repro --tick N`.
*   Player indices are permanent; a substitution flips on-pitch flags.

### Decided in round 9 (review round 2 resolution, 2026-11-22)

*   Replay re-applies only human commands; the AI coach re-derives its own
    (`MatchEngine.replay`). Fixes the double-apply bug introduced by F2.
*   E1 (a): behaviour rules are fixed as forms plus YAML keys with starting
    values (§9b), tuned in build steps 3–4.
*   Every open-play cross and keeper distribution also emits a `PASS`, to
    match StatsBomb's pass definition.
*   Repro copy uses `@capacitor/clipboard` with a `<textarea>` fallback.
*   `squadgen` moves to `src/shared/` (Irwin–Hall, no transcendentals).
*   "Release gate" = 8 Scenario A hard metrics + 3 Scenario B checks.

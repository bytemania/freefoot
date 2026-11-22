# freefoot Match Engine and v1 Single-Match Viewer

*   **Author:** bytemania
*   **Status:** Approved
*   **Date:** 2026-11-22

--------------------------------------------------------------------------------

## Overview

freefoot is a planned Football Manager-style career and league game for
Android phones. This design covers the part every later feature depends on:
the **match engine**, and a **v1 single-match viewer** that lets one person
watch and manage one match against a computer-controlled opponent.

The engine is plain ES6 JavaScript with no DOM or Node dependencies. It moves
22 players and a ball on a 2D pitch 20 times per match second. Players pick
actions (pass, dribble, tackle, shoot, cross) using real distances, nearby
opponents and their 1–20 attributes. Fitness and injuries wear players down
during the match, and fouls and cards follow from tackles. Given the same
config, seed and list of manager commands, the engine produces the same
match, bit for bit, in Node and in the Android WebView.

The viewer runs offline inside a Capacitor app held upright. It draws the
pitch at 60 frames per second and offers:
*   a speed slider from 0x to 60x
*   two modes: Full Match, and Best Moments (fast-forward with highlight
    replays)
*   commentary in European Portuguese and British English
*   live stats
*   a manager panel for substitutions and switching between 4-3-3 and 4-4-2

A headless Node runner plays hundreds of matches with generated squads. It
checks that the engine's statistics match real football in a balanced
matchup and in a strong-versus-weak matchup.

## The Problem

**What freefoot needs.** A career game is only believable if its matches are.
Over a season, players notice when scorelines are too high, when the strong
team never loses, when every match looks alike, or when substitutions change
nothing. The match engine sets all of that. Every later system depends on it:
league tables, player form, transfers, the coach's reputation.

**Why existing approaches don't fit:**

*   **Text-only result generators** (a dice roll per minute, as in older
    management games) are cheap. But they can't be watched, and their
    statistics don't come from anything that happens on the pitch. The
    manager can't see why a substitution helped.
*   **Full physics engines** (a rigid-body library with 3D ball flight) cost
    too much on a mid-range phone at 60x speed. Their floating-point results
    also differ between JavaScript engines, so a match can't be reproduced
    from a seed.
*   **Hand-tuned spatial sims without a measurement harness** drift. Tuning
    one number (tackle success) moves several others (possession, passes,
    shots). Without an automated check across hundreds of matches, nobody
    knows whether the engine still looks like football.

**What this design proposes.** A middle path:
*   A 2D spatial simulation at a low fixed rate (20 Hz), smoothed on screen
    to 60 FPS.
*   Determinism enforced by the code itself: one seeded random stream for
    the engine, and no platform-dependent math.
*   A small, serialisable API (G2) for the career game to call later.
*   A calibration runner that checks 8 per-team statistics against
    real-match reference bands, in a balanced matchup and a
    strong-versus-weak matchup, checking both the average and the
    match-to-match spread.

The v1 viewer exists to prove the engine can be watched and managed on a
phone. It is not the final game UI.

**Who it is for.**
*   **The author**, as the designer tuning the engine through YAML files.
*   **The future career layer**, as the engine's only caller.
*   **Players**, who watch and manage matches on Android phones without a
    network connection.

## Goals

*   **G1: Deterministic matches.** The same compiled config, seed and
    tick-stamped command log produce identical per-tick state hashes. This
    holds between the Node and Chromium versions pinned in CI, and is
    re-checked whenever either is upgraded. On the phone, every resume
    re-simulates the match and compares its state hash (§20), so a WebView
    that diverges is detected.
    *Measure:* golden seeds produce matching hash streams in Node and in
    headless Chromium in CI.
*   **G2: A stable engine boundary for the career game.**
    *   The engine starts from serialisable, versioned input (rosters,
        formations, seed, config hash) and returns a versioned result.
    *   Managers act on a match only through one command entry point.
    *   It emits language-neutral `MatchEvent` objects.
    *   The method list lives in one place: item 27 of the implementation
        plan.

    *Measure:* the engine package imports nothing from DOM, Node or YAML,
    enforced by lint.
*   **G3: Realistic statistics.** Across 500 generated matches per scenario,
    the engine passes these hard checks (values in item 17):
    *   **Scenario A (balanced squads):** for each of 8 per-team metrics
        (goals, xG from an outside geometric model, total shots, shots on
        target, possession %, total passes, pass completion %, fouls
        committed), the mean is inside its band, and p10 and p90 are each
        within `max(tolerance × |ref|, toleranceAbs)` of the real-world
        reference percentiles.
    *   **Scenario B (strong versus weak squads):** the strong side has
        60–70% mean possession, at least a 0.75 share of the match xG, and
        wins 70–80% of matches.

    Everything else, including the Scenario B percentiles, is logged and
    soft-checked (reported, not gating; see §18).

    *Measure:* `npm run calibrate` exits non-zero on any hard failure.
*   **G4: Smooth on a mid-range phone.** At 60x speed (20 ticks per frame) the
    p95 engine work per frame is under 2.0 ms on the reference device (a
    Snapdragon 680 phone), and p95 frame time stays at or under 16.7 ms.
    *Measure:* the in-app `#bench` view on the reference device is the
    release gate. In CI, `npm run bench` reports the mean engine ms per 20
    ticks and fails only above a loose ceiling of 1.0 ms (3× the 0.33 ms
    estimate from the assumed 6× slowdown).
*   **G5: Manageable matches.**
    *   The user can make up to 5 substitutions from a 7-player bench at any
        time, with no limit on substitution windows in v1. A substitution is
        queued and takes effect at the next dead ball (throw-in, goal kick,
        corner, free kick, goal, kick-off).
    *   Switching between 4-3-3 and flat 4-4-2 takes effect on the next
        tick.
    *   A serious injury (level `HIGH`; levels are `LIGHT`, `MEDIUM` and
        `HIGH`, see §11), or a goalkeeper sent off, pauses the match at any
        speed and opens the substitutions panel.
    *   The opponent's rule-based AI coach issues commands through the same
        path.

    *Measure:* rules tests (item 81) check that queued substitutions apply
    on the first dead-ball tick, that a forced decision stops `step()`,
    and that every command error code is returned.
*   **G6: Best Moments.**
    *   The match fast-forwards and stops for goals, big chances (xG ≥ 0.32),
        woodwork, penalties, red cards and major saves (PSxG ≥ 0.35).
    *   Each highlight replays from 15 s (300 ticks) before the trigger to
        2 s (40 ticks) after it, at 1–2x, from recorded frames. Later
        triggers extend the post-roll, up to 8 s (160 ticks) past the first
        trigger.
    *   The match then pauses for the manager. A replay only draws, so it
        cannot change the live match.

    *Measure:* runtime tests (item 82) check the lead-up and post-roll
    lengths, the extension cap, and the cut-short rule for forced
    decisions.
*   **G7: Two languages.** Every event type has commentary in `pt-PT` and
    `en-GB`, with several variations. Portuguese articles and endings follow
    the gender of the team and the player. Switching language never changes
    the match.
    *Measure:* a build-time check fails on any missing template, unknown
    variable, or event type with fewer than its `minVariations`.
*   **G8: Tunable without code changes.** All tuning coefficients, tactical
    shapes, squads and commentary live in YAML files, checked against a
    schema at build time and compiled to JS modules. Structural rule limits
    (11 players, 5 substitutions, pitch size) are code constants. The app
    needs no network access.
    *Measure:* `build-config` rejects unknown keys, and the build tests
    (item 84) pass.

## Non-Goals

*   **Career mode** in this design: leagues, seasons, transfers, finances,
    or carrying player state between matches. Only the input and result
    contracts are defined, so career mode can plug in later.
*   **Morale and coach authority** calculations. They have no source of values
    until career mode exists. v1 leaves a single
    `getEffectiveAttribute(player, attr)` function, applying only fitness and
    injury, which v2 extends.
*   **Referee mistakes and VAR overturns.** In v1, offside, fouls, cards and
    penalties are decided by geometry and probability checks behind an
    officiating interface, so v2 can add referee error.
*   **Web Worker.** The engine runs on the main thread in v1. It moves to a
    worker only if the phone benchmark shows dropped frames.
*   **Local two-player mode** and any online play.
*   **Tactical options beyond two formations:** no pressing, width, tempo or
    marking instructions in v1.
*   **Hard checks on derived metrics:** PPDA, field tilt, PSxG totals,
    woodwork, claims and aerial-duel split are logged and reported, not used
    to gate the build.
*   **A fast low-detail simulator** for the other matches in a league round.
    Career mode needs one, but it is designed separately.
*   **iOS and desktop browser releases.** Nothing in the engine prevents them,
    but they are not tested or shipped.
*   **3D ball flight or a physics library.** The ball has a 2D position plus a
    simple height value for crosses, headers and shot placement.

## Open Questions

*   **Phone slowdown factor:** replace the assumed 6× Node-to-phone factor
    with a measured one after the first real-device `#bench` run.

## Decisions Log

Decisions settled during design and review. Each one points to the
section that holds the detail.

*   **Calibration reference data:** possession definition, StatsBomb
    reference set, Scenario B subset and attribute gap, and the tolerance
    floor. See §18a.
*   **Replay source:** a ring of 500 `RenderSnapshot` frames (300 lead-up,
    40 post-roll, 160 extension), about 200 KB. No replay engine and no
    keyframes.
*   **Replay limits:** at most 25 replays per match (config). Triggers
    within 40 ticks of a replay's end extend it, up to 160 ticks past the
    first trigger; a later trigger starts a new replay.
*   **Save and resume:** the save record holds input, config and command
    log; resume re-simulates (§20).
*   **RNG:** one engine stream plus a separate commentary generator (§5).
*   **Engine state:** plain objects created once (§4); typed arrays only
    if `#bench` fails.
*   **Venue:** neutral. `homeAdvantage` is a config value set to 0.
*   **Reduced-team shapes:** defaults in `tactics.yaml`, tunable. Ten men:
    4-4-1 from 4-4-2, 4-3-2 from 4-3-3. Nine men: 4-3-1. A losing AI team
    after 70' switches from 4-4-2 to 4-3-3.
*   **Offside:** geometric, at the moment of the pass. No offside from a
    throw-in, goal kick or corner. Level with the second-last defender is
    onside.
*   **Android lifecycle:** auto-pause and persist; offer resume on next
    launch.
*   **Type checking:** `.js` files with JSDoc and `checkJs`.
*   **AI coach information:** exact state in v1.
*   **`MatchResult`:** defined in §12 of the Technical Plan and in
    `src/engine/contracts/MatchResult.js`.

## Critical User Journeys (CUJs)

### CUJ 1: Watch and manage a full match

*   **Given**: The app is open offline on an Android phone, two squads are
    loaded, language is `pt-PT`, mode is Full Match.
*   **When**: The user starts the match, moves the speed slider to 10x, and
    at 62' queues a substitution for a tired midfielder.
*   **Then**:
    *   The pitch draws at 60 FPS.
    *   The substitution shows as "pending" and happens at the next dead
        ball.
    *   Commentary announces it in Portuguese with correct gender agreement.
    *   The stats panel updates live.

### CUJ 2: Best Moments with a forced decision

*   **Given**: Mode is Best Moments.
*   **When**: The opponent scores at 23'; at 51' the user's goalkeeper gets a
    HIGH injury.
*   **Then**:
    *   During fast-forward the speed slider has no effect.
    *   At 23', the match replays the goal from 15 s before it to 2 s
        after, then pauses with "Continue".
    *   At 51', the match pauses at once and opens the substitutions panel,
        whatever the speed.
    *   After the user chooses, the match resumes from the same tick.

### CUJ 3: Reproduce a bug report

*   **Given**: A player reports a strange goal; the app copied its repro
    record (engine version, config, input with seed, command log, tick and
    state hash) to the clipboard.
*   **When**: The author runs the record through the Node replay script.
*   **Then**: The Node run reaches the same state hash, and the author can
    replay to the tick of the goal (`--tick N`) and inspect the full
    state.

### CUJ 4: Tune the engine

*   **Given**: The author edits a pass-risk weight in `config/weights.yaml`.
*   **When**: The author runs `npm run calibrate`.
*   **Then**:
    *   The build rejects unknown or misspelled keys.
    *   500 matches per scenario run across worker threads.
    *   A report lists every metric's mean, p10 and p90 against its target.
    *   The command exits non-zero if the release gate (8 Scenario A hard
        metrics plus 3 Scenario B checks, item 17) fails.

## Technical Plan (Architecture)

### 1. Components and data flow

```text
 config/*.yaml ──► scripts/build-config.mjs ──► generated/config.js (+ configHash)
 (weights, tactics,    (parse, validate with JSON        │
  events, xg, ai,       Schema, reject unknown keys,     │
  commentary, targets)  hash canonical JSON)             │
                                                         ▼
 MatchInput (rosters, formations, seed) ──► engine/MatchEngine
                                                     │  step(n), applyCommand(cmd)
                                                     │  getSnapshot(), getStats()
                                                     │  getResult(), serialize(), hash()
                                                     ▼
                      MatchEvent stream + RenderSnapshot + MatchStats
                     ┌───────────────────┴──────────────────────┐
                     ▼                                          ▼
   runtime/MatchController (browser, main thread)     calibration/ (Node only)
   rAF loop, tick budget, Best Moments,               squadgen, runner on
   RenderSnapshot ring, save record                   worker_threads, report
                     │
                     ▼
   ui/ views: Scoreboard, PitchCanvas, Controls,
   Commentary (i18n/Commentator), Stats, Manager, Bench
```

The engine depends on nothing but the config object and the match input
it is given; it never imports `generated/` itself (the event registry
arrives as `config.events`). A lint rule enforces this: files under
`engine/` may not import from `runtime/`, `ui/`, `i18n/`, `calibration/`,
`generated/`, Node built-ins or the DOM. The browser app and the Node calibration runner both use the same
compiled config module, so there is exactly one source of weights.

### 2. Pitch coordinates

*   The engine uses metres on a 105 × 68 m pitch.
    *   `x` runs along the length, from 0 to 105.
    *   `y` runs across the width, from 0 to 68.
    *   The goals are centred at `(0, 34)` and `(105, 34)`, each 7.32 m
        wide and 2.44 m high.
*   Home attacks toward `x = 105` in the first half; sides swap at half-time.
*   The portrait canvas draws `x` vertically (goals at top and bottom) and
    `y` horizontally. That rotation lives only in `PitchCanvasView`.
*   Zones for events and stats are a 6 × 3 grid relative to the attacking
    team: 6 bands along the length (each 17.5 m) and 3 across the width
    (each about 22.7 m). Zones are numbered across, then forward: zone 1
    is the band nearest the attacker's own goal, left channel; zone 3 the
    same band, right; zone 18 the band at the opponent's goal, right.

### 3. Time and the tick

*   One tick is 0.05 s of match time (20 Hz). Every rate in config is per
    second. `MatchEngine.create` builds a frozen per-tick view of the
    config once (rates × `dt = 0.05`); `configHash` is computed over the raw
    compiled config, so the tick rate is a single constant.
*   A half lasts 54,000 ticks plus added time.
*   **Order of work inside `step()`** for each tick (fixed, so results do
    not depend on how ticks are batched across `step(n)` calls):
    1.  Apply commands issued on the previous tick. Formation changes apply
        now. Queued substitutions apply only if the match is at a dead
        ball.
    2.  Run decisions for players whose turn it is. Each player decides every
        5 ticks (0.25 s, 4 Hz), staggered by `(tick + playerIndex) mod 5`. A
        player who just received the ball, or whose ball target changed,
        decides immediately.
    3.  Move players toward their targets.
    4.  Move the ball, and run swept interception and contact checks along
        its path for this tick.
    5.  Resolve contacts: tackles, duels, fouls (through the officiating
        interface).
    6.  Advance the restart and clock state machine.
    7.  Update fitness and injuries.
    8.  Run the AI coach every `evalIntervalTicks` ticks (20, from
        `ai_coach.yaml`; once per second).
    9.  Append events and update stats.
*   **Player indices are permanent for the whole match.** Each team's 18
    players get indices 0–17 (home) and 18–35 (away), in `MatchInput`
    order: starters are `players[0..10]` with the goalkeeper at
    `players[0]`, and the bench is `players[11..17]`. A substitution flips
    two `onPitch` flags and gives the incoming player the outgoing
    player's formation slot. Events always name players by these indices,
    so a stored event names the same person forever.
*   Every tick walks an on-pitch index list kept in ascending order (at
    most 22 entries).

### 4. Engine state

All state that changes during a match lives in one `MatchState` object
that `serialize()` writes out and `fromState()` restores. Entities refer to
each other by integer index, never by object reference. This rule keeps
restore safe, because structured clone and JSON both drop class prototypes
and object references.

*   **Per-player state** is a plain object per player, created once at
    engine creation and mutated in place: current and previous position,
    velocity, target position, fitness, distance covered, sprint count and
    flag, decision timer, pending action, injury level, card state, on-pitch
    flag and formation slot. `PlayerMatchState` is the class of these
    objects. If `#bench` shows the engine over budget, these fields can move
    to typed arrays behind the same getters; that is a contingency, not v1
    work.
*   **Cold data** (names, attributes, roles, gender, article tokens, config)
    is plain frozen objects, loaded once and not part of the saved state.
*   **Other state**, serialised as plain numbers and small arrays:
    *   ball: position, velocity, owner index or −1, flight descriptor
    *   the restart state machine
    *   clock and added-time accumulator
    *   substitution counts and the pending-substitution queue
    *   AI coach rules already fired
    *   the engine RNG's four 32-bit words
    *   stats accumulators
    *   the event sequence counter
*   **State hash:** FNV-1a over a canonical byte encoding of the
    `serialize()` output. The walk is depth-first, in the fixed field order
    `serialize()` writes (listed in item 30). Each value is written as a
    tag byte plus a payload:
    *   0: null
    *   1: false
    *   2: true
    *   3: number, as float64 little-endian
    *   4: string, as a uint32 length then UTF-8 bytes
    *   5: array, as a uint32 length then its items
    *   6: object, as a uint32 key count then key–value pairs, with each
        key written as a string

    `-0` is written as `+0`. `NaN` and `Infinity` are invalid state and
    throw in debug builds. Debug builds and
    tests compute it every tick; normal builds compute it on demand.
*   **Two snapshot types:**
    *   `RenderSnapshot` is a single preallocated `Float64Array` that
        `getSnapshot(out)` fills: a header, the ball, then fixed fields per
        player (layout in item 27). It is what the canvas draws from, and it
        cannot restore a match.
    *   `serialize()` output is the full restorable state. It is used by
        tests, the repro script and the save fallback (§20).
*   **Allocation rule (code review):** inside `step()`, the only new objects
    are `MatchEvent`s and the array `step()` returns. Events number about
    3,000–5,000 per match, against 108,000 ticks. Hot temporaries go into
    preallocated scratch buffers.

### 5. Random numbers and determinism

*   Generator: `sfc32` (four 32-bit words, `Math.imul` and integer shifts).
*   **One engine stream**, `engineRng`, used for decision noise and all
    outcome rolls (passes, shots, tackles, fouls, cards, injuries). Separate
    streams per subsystem would not isolate anything: in a coupled spatial
    simulation one extra draw shifts positions, and every later outcome
    diverges anyway.
*   **Seeding:** a `splitmix32` chain seeded with `matchSeed` produces the
    four sfc32 words; then the first 16 **sfc32** outputs are discarded.
    `splitmix32` uses increment `0x9E3779B9`, multipliers `0x85EBCA6B` and
    `0xC2B2AE35`, and shifts 16, 13, 16.
*   Commentary, Best Moments detection and the UI never touch `engineRng`.
    Commentary uses its own `sfc32` per event, seeded by the same chain from
    `matchSeed ^ Math.imul(event.seq + 1, 0x9E3779B9)`.
*   **Rules for code under `engine/`** (this list is the single source;
    the ESLint config in item 3 implements it):
    *   `Math` members are allowed only from this list: `floor`, `ceil`,
        `round`, `trunc`, `abs`, `sign`, `sqrt`, `min`, `max`, `imul`,
        `fround`, `clz32`. ECMAScript fully specifies their results, so
        they are identical across engines. Everything else (`sin`, `exp`,
        `pow`, `random`, `cbrt`, `log2` and the rest) is banned.
    *   The `**` and `**=` operators are banned, as is any use of `Math`
        other than `Math.<allowed>` (no aliasing, no computed access).
    *   No `Date`, `performance`, `Intl`, `globalThis` or `localeCompare`.
    *   Use `engine/math/detmath.js` instead: polynomial `fastAtan2` and
        `fastExp` (plus a `sigmoid` built on it), built only from `+ - * /`,
        which IEEE-754 requires to be correctly rounded, so every
        conforming engine returns the same bits.
    *   Every sort uses a comparator that breaks ties by player index. Code
        never iterates a `Map` or `Set` whose insertion order depends on
        timing.
*   **Proof in CI:** golden seeds run in Node and in headless Chromium
    (Playwright). The two runs must produce the same per-tick hash stream.
    On the phone, the resume hash check (§20) and a golden-hash line on
    `#bench` cover the Android System WebView.

### 6. Players: effective attributes and fitness

*   `getEffectiveAttribute(player, attr)` is the only way engine code reads
    an attribute. In v1 it returns
    `base × fitnessFactor(attr) × injuryFactor(attr)`, clamped to 1–20.
    *   `fitnessFactor` is 1.0 above a configured fitness threshold, then
        falls linearly. Physical attributes fall faster than mental ones;
        the slopes are in `weights.yaml`.
    *   Each injury level has a multiplier per attribute group in
        `injuries.yaml`.
*   Role weighting: each role in `roles.yaml` lists primary and secondary
    attributes (item 9). A role rating, 0.7 × the primary mean plus 0.3 ×
    the secondary mean, is used by the squad generator and the AI coach. It
    is not used to resolve actions; actions read the specific attributes
    they need. The stand-in keeper rule uses Reflexes + Positioning (§11).
*   Formation slots map to roles in `tactics.yaml` (for example 4-4-2's
    wide midfielders use the `W` role, its central ones `MF`). Roles are
    config, not a fixed enum.
*   Fitness falls each second by a base cost for the player's speed band
    (walk, jog, run, sprint; formulas in §9a). The cost is scaled down by
    Stamina and up by Work Rate, and fitness recovers slowly while walking. A sprint is counted
    each time speed rises above the sprint threshold (config, default
    7.0 m/s) after being below it for at least 1 s. Distance adds
    `|velocity| × dt` each tick.

### 7. Movement and tactical anchors

*   Each formation slot has an anchor in `tactics.yaml`, in pitch-fraction
    coordinates for attacking and for defending phases. The anchor moves
    with the ball by per-slot coefficients:
    `anchor = base + (ball − centre) × follow`. It is clamped so defenders
    never pass their own goal line and the offside line rules still apply.
*   Off-ball roles set each player's target:
    *   **Hold:** go to the anchor.
    *   **Press:** the nearest one or two defenders go to the ball carrier
        when the carrier is inside the press zone.
    *   **Mark:** a defender shadows the nearest opponent inside the
        defender's zone.
    *   **Support:** attackers find space near the anchor, away from the
        nearest defender.
*   Movement steers velocity toward the target. Top speed comes from Pace,
    acceleration from Acceleration, both through `getEffectiveAttribute`.
    No trigonometry is used: directions are unit vectors from `dx / dist`.
*   Formation switches replace anchors at once. Players walk to the new
    shape at normal speed.
*   **Reduced teams:** after a red card or a HIGH injury with no
    substitutes left, the team uses the reduced variant of its current
    formation from `tactics.yaml`:
    *   ten men: 4-4-1 from 4-4-2, 4-3-2 from 4-3-3
    *   nine men: 4-3-1

### 8. Ball

*   **Ground balls** have position and velocity. Rolling resistance
    multiplies velocity by a precomputed per-tick factor (one
    multiplication, no `exp`).
*   **Lofted balls** (long passes, crosses, chips, clearances, shots that
    rise) store a flight descriptor: launch tick, launch position, landing
    point, flight time and peak height. Position along the path is linear in
    time. Height comes from a closed-form parabola,
    `h(t) = 4 × peak × s × (1 − s)` with `s` the fraction of flight
    completed. Height is never integrated tick by tick. It is evaluated only
    when a player is close enough to the ball's path to contest it.
*   **Swept checks:** each tick, for every opponent within a coarse radius
    of the ball's segment from `prevPos` to `currPos`, find the closest
    point on that segment.
    *   For ground balls: the player can attempt an interception or block if
        that distance is under their reach.
    *   For lofted balls: the player can also attempt one, but only if
        `h(t)` at that point is under their standing or jumping reach (from
        Jumping Reach; keepers use Aerial Reach). v1 has no height field.

    Brute force over the 22 on-pitch players stays within the G4 budget; no
    spatial grid.
*   **Shots:** a shot picks a goal-mouth target `(goalY, goalZ)`, with
    `goalY ∈ [−3.66, 3.66]` m from the centre and `goalZ ∈ [0, 2.44]` m,
    and a speed `v_shot`. `goalZ` is a shot-resolution parameter only. It
    sets the flight descriptor's end height and feeds the save formula and
    PSxG. The ball does not fly in 3D.

### 9. Decisions and action resolution

*   **Ball carrier.** At each decision the carrier scores candidate actions
    and picks the highest:
    *   a pass to each team-mate (short, long, through ball, switch)
    *   dribble forward or sideways
    *   shoot
    *   cross, when in a wide attacking zone
    *   hold the ball

    Each score is a weighted sum of features: lane safety (the nearest
    opponent's distance to the pass segment), progress toward goal, receiver
    pressure, estimated xG, the carrier's pressure. The weights are in
    `weights.yaml`. Noise from `engineRng`, scaled down by Decisions and up
    by low fitness, is added before picking. That noise is the source of
    mistakes. Feature and noise formulas are in §9a.
*   **Resolution.** Each action's outcome comes from one pure function in
    `engine/resolve/`, with inputs as plain numbers and no state access:
    *   `passOutcome(dist, laneThreat, receiverPressure, passing,
        technique)` → `{pComplete, errM}`
    *   `firstTouch(ballSpeed, pressure, firstTouch, technique)` →
        `{controlled}`
    *   `dribbleOutcome(dribbling, agility, flair, defTackling,
        defPositioning)` → `{beat}`
    *   `tackleOutcome(tackling, strength, carrierDribbling,
        carrierBalance, aggression, fitness, fromBehind, injuryLevel)` →
        `{won, foul}`
    *   `aerialDuel(aerialA, aerialB)` → `{aWins}`, where each player's
        aerial score is `(jumpingReach + strength + bravery) / 3`
    *   `shotPlacement(finishing, composure, pressure, aimY, aimZ, vAim)` →
        `{goalY, goalZ, vShot, onTarget, woodwork}`
    *   `saveOutcome(reflexes, positioning, oneOnOnes, isOneOnOne,
        placement, vShot)` → `{saved, kind}`

    §9a is the authoritative source for each formula; this list and
    item 43 follow it. `laneThreat = 1 − laneSafety`.
    Each function's form is fixed in §9a and its coefficients are in
    `weights.yaml`. They can be unit tested and tuned in isolation before
    they run inside matches. Outcomes draw from `engineRng`.
*   **Defenders off the ball** choose among hold, press (which includes the
    tackle attempt), mark and intercept on the same 0.25 s cycle.
    Aggression raises the chance of a pressing defender attempting a
    tackle, and the tackle's foul propensity.

### 9a. Resolution formulas

These fix the form of every outcome function. Coefficient names are YAML
keys in `weights.yaml` (item 8), with starting values set there and
changed only by calibration. `n(a) = (a − 10) / 10` normalises an attribute
to about [−0.9, 1]. `σ(z) = 1 / (1 + fastExp(−z))`.

*   **Pass:** `pComplete = σ(p0 + p1·n(passing) + p2·n(technique) −
    p3·dist/30 − p4·laneThreat − p5·receiverPressure)`. Direction error is
    `e0 · dist · (1 − 0.5·n(passing))` metres. `vision` widens the
    candidate set (through-ball candidates need `vision ≥ visionMin`).
*   **First touch:** `pControl = σ(t0 + t1·n(firstTouch) + t2·n(technique) −
    t3·ballSpeed/20 − t4·pressure)`.
*   **Dribble:** `pBeat = σ(d0 + d1·n(dribbling) + d2·n(agility) +
    d3·n(flair) − d4·n(def.tackling) − d5·n(def.positioning))`.
*   **Tackle:** `pWin = σ(k0 + k1·n(tackling) + k2·n(strength) −
    k3·n(carrier.dribbling) − k4·n(carrier.balance))`;
    `pFoul = σ(f0 + f1·n(aggression) − f2·n(tackling) + f3·(1 − fitness) +
    f4·fromBehind + f5·injuryLevel)`.
*   **Aerial duel:** `pWinA = σ(a0 + a1·(aerialA − aerialB)/10)`.
*   **Shot placement:** aim at a target `(goalY, goalZ)`; error radius
    `r0 · (1 − 0.5·n(finishing)) · (1 + r1·pressure) · (1 − 0.3·n(composure))`
    metres. Headed shots use `heading = (jumpingReach + finishing) / 2` in
    place of finishing. A result inside the frame is on target; within the
    post-width band (0.12 m) is `WOODWORK`.
*   **Save:** `pSave = σ(g0 + g1·n(reflexes) + g2·n(positioning) +
    g3·n(oneOnOnes)·isOneOnOne − g4·placement − g5·vShot/30)`, where
    `placement` runs from 0 (central) to 1 (corner). A save is `HELD` when
    `vShot < h1` m/s, `TIPPED` when the save point is within 0.3 m of the
    frame, otherwise `PARRIED`.
*   **Decision score:** `Σ w_k·f_k + noise`. Each feature `f_k` is
    normalised to [0, 1] (`laneSafety = min(1, nearestOpponentDist / 8)`,
    `progress = Δ(distance to goal) / 30`, pressures = `1 − min(1,
    nearestOpponent / 5)`). Noise is triangular: the sum of two uniforms in
    [−0.5, 0.5], scaled by `n0 · (1 − 0.5·n(decisions)) · (1 + n1·(1 −
    fitness))`.
*   **Fitness:** speed bands walk < 2, jog < 5, run < 7, sprint ≥ 7 m/s.
    Drain per second = `c[band] · (1.5 − stamina/20) · (0.8 + workRate/50)`.
    Recovery is `rec` per second while walking and during dead balls.
    Effective physical attribute = `a · (1 − s_phys · max(0, 0.7 −
    fitness))`; mental attributes use `s_ment`.
*   **Injury:** per contact, `pInj = i0 · (1 + i1·(1 − fitness)) · (1 +
    i2·n(opponent.aggression))`. Level split: `LIGHT` 0.70, `MEDIUM` 0.22,
    `HIGH` 0.08 (in `injuries.yaml`).
*   **Off-ball:** the nearest defender presses the carrier when the carrier
    is inside the press zone; the second-nearest also presses when
    `pressTrigger` is true (carrier facing own goal or under a heavy touch).
    A defender whose reach covers a predicted pass lane intercepts. The rest
    mark the nearest unmarked attacker in their zone, or hold their anchor.

### 9b. Behaviour rules

Like §9a, these fix the form of each rule and name its YAML keys (in
`weights.yaml` unless another file is named). Every constant starts with
the value shown, is marked `initial: true`, and is tuned in build steps
3–4. Distances are metres, speeds m/s, `u` is a uniform draw from
`engineRng`.

*   **Movement:**
    *   `topSpeed = v0 + v1·pace/20` (starting 5.5 + 3.5·pace/20).
    *   `accel = a0 + a1·acceleration/20` (starting 3 + 4·acceleration/20)
        m/s².
    *   Steering: the velocity turns toward `(target − pos)` and changes
        by at most `accel` per second.
    *   Arrival: speed scales down linearly inside `rArrive` (2 m) of
        the target.
*   **Ball contests:**
    *   Kind, in this order: an intercept if the ball is below the
        player's reach and the player is in front of the ball's path;
        otherwise a block (shots only).
    *   `pWin = σ(c0 + c1·n(anticipation) − c2·ballSpeed/20 −
        c3·distToPath/reach)`, where anticipation is `positioning` (keepers
        use `reflexes`).
    *   A deflection leaves along the reflection about the contact normal,
        plus uniform noise of ±`defl` degrees (starting 25).
    *   After an aerial duel, the winner heads toward their decision
        target if they are on the ball owner's team; otherwise it is a
        clearance away from their own goal.
*   **Pass flight** (`ball.kinds`):

    | Kind | Peak (m) | Launch speed (m/s) |
    | :-- | :-- | :-- |
    | SHORT | ground | 12 |
    | THROUGH | ground | 16 |
    | SWITCH | ground | 20 |
    | LONG | 8 | 22 |
    | CROSS | 4 | 20 |
    | CLEARANCE | 12 | 25 |
    | CHIP | 3 | 14 |

    Lofted flight time is distance ÷ launch speed. Passes to feet aim at
    the receiver's position. A `THROUGH` pass leads the receiver by
    `velocity × flightTime`.
*   **Shots:**
    *   Aim: the far post when the angle to the posts is at least `θfar`
        (starting 0.35 rad); otherwise the corner further from the keeper.
        `aimZ` is 0.5 m, or 1.8 m when `finishing ≥ 15`.
    *   `vAim = s0 + s1·n(finishing)` (starting 24 + 6·n). Headers use
        `12 + 4·n(heading)`.
    *   `isOneOnOne`: no outfield defender is inside the shot cone and the
        distance is under 16 m.
    *   `placement = max(|goalY| / 3.66, goalZ / 2.44)`.
*   **Goalkeeper:**
    *   Position: on the line from the ball to the goal centre, at depth
        `gkDepth = 1 + 5·(1 − dist/40)`, clamped to 0.5–6 m.
    *   `CLAIM` or `PUNCH`: on a lofted ball landing inside
        `commandRadius = 4 + 0.3·commandOfArea`. The keeper contests with
        reach `aerialReach/20 × 0.5` m above jumping reach. If the keeper
        wins, it is a `CLAIM` when `σ(q0 + q1·n(commandOfArea) −
        q2·crowd) > u`, otherwise a `PUNCH`. `crowd` is the number of
        players within 2 m.
    *   `SMOTHER`: in a one-on-one, the keeper reaches the ball first.
    *   Distribution: a throw for targets under 30 m, otherwise a kick. The
        target is chosen by the carrier decision model.
*   **Officiating** (`officiating.yaml`):
    *   `severity` starts at 0. Add 0.4 for a tackle from behind, 0.3 if
        the tackler's speed is above 6 m/s, 0.5 if the fouled player was
        the last attacker past the last defender. Clamp to [0, 1].
    *   `pCard = σ(y0 + y1·severity + y2·n(aggression))`. The card is red
        when `severity ≥ 0.9` and `u < r0 + r1·severity`; otherwise yellow.
    *   Advantage: play on while the fouled team keeps the ball for
        `advSeconds` (3 s) and its progress gain is at least `advMin`
        (5 m). Otherwise play is called back for the free kick.
    *   Every foul gives a direct free kick. Offside and a keeper handling a
        deliberate back-pass give an indirect one.
    *   Penalty: resolved with `shotPlacement` and `saveOutcome`, using the
        taker's finishing and composure, from 11 m, with
        `isOneOnOne = true`. The `SHOT` event carries `xg = penaltyXg`.
*   **Restarts** (`tactics.yaml`):
    *   Takers:
        *   throw-in: the nearest FB or W
        *   corner: the highest `crossing`
        *   free kick: the highest `crossing`, or the highest `finishing`
            for a direct free kick within 30 m of goal
        *   goal kick: the keeper
        *   penalty: the highest `finishing + composure`
    *   Hold time: `setPieceSeconds` per restart kind.
    *   Kick-off: the conceding team after a goal. The home team kicks off
        the first half, and the away team the second.
*   **Injuries** (`injuries.yaml`):
    *   Contact events are `TACKLE`, `FOUL`, `AERIAL_DUEL` and `BLOCK`.
        Each one rolls the per-contact formula in §9a.
    *   Fatigue: each second with fitness below 0.3, roll
        `pFat = j0·(0.3 − fitness)`.
*   **Carrier decisions:**
    *   Features per action:
        *   pass: `laneSafety`, `progress`, `1 − receiverPressure`
        *   dribble: space ahead (distance to the nearest opponent in a
            60° cone, ÷ 10), `n(dribbling)`
        *   shot: estimated xG
        *   cross: in a wide attacking zone, and team-mates in the box ÷ 3
        *   hold: `1 − pressure`
    *   Dribble directions: forward and ±35°.
    *   Wide attacking zones: 13, 15, 16 and 18 (§2).
    *   An interrupt (an immediate decision) fires when the player receives
        the ball, when the ball's target changes, or when an opponent comes
        within 2 m.
*   **Support runs:** sample 8 points on a 6 m ring around the anchor.
    Choose the onside point with the largest distance to the nearest
    opponent. Ties go to the lower point index.

### 10. Officiating, restarts and clock

*   `engine/officiating/Referee.js` exposes one interface:
    *   `judgeContact(ctx)` → `{foul, card, penalty, advantage}`
    *   `judgeOffside(passCtx)` → boolean
    *   `computeAddedTime(state)` → minutes

    v1 uses probability checks with `engineRng`, plus geometry.
*   **Fouls and cards.** Foul probability rises with the tackler's
    Aggression, a late or behind tackle angle, low fitness, and the
    tackler's injury state. A foul in the box is a penalty. Card
    probability rises with foul severity and Aggression. A second yellow
    is a red.
*   **Offside.** A geometric check at the moment a forward pass is
    played, applied to the intended receiver only. The receiver is offside
    if they are in the opponent half, strictly ahead of the ball, and
    strictly ahead of the second-last defender (level is onside). There is
    no offside directly from a throw-in, goal kick or corner.
*   **Restart state machine:**
    *   States: `IN_PLAY`, `DEAD_BALL(kind, teamIndex, x, y,
        resumeTick)`, `HALF_TIME`, `FULL_TIME`.
    *   Kinds: kick-off, throw-in, goal kick, corner, free kick (direct or
        indirect), penalty, drop ball.
    *   During `DEAD_BALL`, players move to set-piece positions from
        `tactics.yaml` for a configured time, then play resumes with the
        taker's decision.
*   **Substitutions** wait in a queue and are applied on the first tick of
    any `DEAD_BALL` state. A forced substitution, for a HIGH injury or a
    goalkeeper sent off, applies at once, because play is already stopped
    for the injury or the foul.
*   **Clock.** The clock runs during dead balls, as in real football. Each
    goal, substitution, card and injury stoppage adds configured seconds to
    an accumulator. At 45:00 and 90:00 the accumulator is rounded up to whole
    minutes, announced, and played.

### 11. Injuries and forced decisions

*   Contact events and high fatigue roll `engineRng` against rates in
    `injuries.yaml` (formula in §9a).
*   `LIGHT` and `MEDIUM` apply attribute multipliers and show a badge.
    `MEDIUM` also emits a "needs substitution" event.
*   `HIGH` stops play with an injury stoppage and marks the player as
    unable to continue.
*   A HIGH injury or a goalkeeper red card emits a
    `FORCED_DECISION_REQUIRED` event and sets `state.awaitingDecision`.
    The tick that raises it runs to completion (all 9 steps); `step()`
    then returns with `stoppedFor: 'FORCED_DECISION'` and runs no further
    ticks until the team resolves it through `applyCommand`. If both teams
    need a decision on the same tick, the home team resolves first.
*   For the AI team, the coach resolves it immediately.
*   Forced substitutions count toward the 5. With no substitutes left,
    the player leaves and the team takes its reduced shape. For a goalkeeper with no keeper available, the on-pitch
    outfield player with the highest Reflexes + Positioning moves into goal
    and gets the keeper badge.

### 12. Commands and the AI coach

*   **Command shape:** one entry point,
    `applyCommand({issuer: 'human' | 'ai', type, teamIndex, payload})`.
    The engine assigns `seq` (a counter) and `tick` (the last completed
    tick). The command takes effect at step 1 of tick `tick + 1`.
    *   Types:
        *   `SUBSTITUTE {outIndex, inIndex}`: queued to the next dead ball.
        *   `SET_FORMATION {formationId}`: applies on the next tick.
        *   `CANCEL_SUBSTITUTION {seq}`.
        *   `RESOLVE_FORCED {inIndex | null, outIndex | null}`: `inIndex`
            is the bench player coming on (any bench player; an outfield
            player can be the stand-in keeper). `outIndex` is required when
            the player making way is not the injured or sent-off player,
            for example an outfield player removed so a bench keeper can
            replace a sent-off keeper. `inIndex: null` means play on with
            fewer players.
    *   It returns `{ok, code}`. The error codes are a closed list:
        `NO_SUBS_LEFT`, `PLAYER_NOT_ON_PITCH`, `PLAYER_NOT_ON_BENCH`,
        `ALREADY_PENDING`, `SENT_OFF_PLAYER`, `UNKNOWN_FORMATION`,
        `UNKNOWN_TYPE`, `BAD_TEAM`, `NOT_AWAITING_DECISION`,
        `DECISION_PENDING`, `OUT_REQUIRED`, `MATCH_OVER`, `UNKNOWN_SEQ`.
*   Every accepted command is appended to the engine's command log (the
    engine owns it; callers read it with `getCommandLog()`). The log keeps
    AI commands for the record, but **replay re-applies only
    `issuer: 'human'` entries**. The AI coach re-derives its own commands
    from the same state during re-simulation, so they are not applied
    twice. `MatchEngine.replay` (item 27) defines the algorithm.
*   **Validation**, checked in this order: type known (`UNKNOWN_TYPE`),
    team valid (`BAD_TEAM`), match not over (`MATCH_OVER`), then the
    type-specific checks:

    | Code | Condition |
    | :-- | :-- |
    | `DECISION_PENDING` | the team has an unresolved forced decision, and the command is not `RESOLVE_FORCED` |
    | `NOT_AWAITING_DECISION` | `RESOLVE_FORCED` with no forced decision pending |
    | `NO_SUBS_LEFT` | used plus pending substitutions is already 5 |
    | `PLAYER_NOT_ON_PITCH` | `outIndex` is not on the pitch |
    | `PLAYER_NOT_ON_BENCH` | `inIndex` is not an unused bench player |
    | `SENT_OFF_PLAYER` | `outIndex` or `inIndex` has been sent off |
    | `ALREADY_PENDING` | `outIndex` or `inIndex` is already in a pending substitution |
    | `OUT_REQUIRED` | `RESOLVE_FORCED` needs an `outIndex` (for example a bench keeper replacing a sent-off keeper) and none was given |
    | `UNKNOWN_FORMATION` | `formationId` is not in `tactics.yaml` |
    | `UNKNOWN_SEQ` | `CANCEL_SUBSTITUTION` names no pending substitution (including one already applied) |
*   **AI forced decisions:** for a team with `controlledBy: 'ai'`, the AI
    coach resolves a forced decision inside step 7 of the same tick. It
    ignores the 20-tick interval, clears `awaitingDecision`, and does not
    stop `step()`.
*   **A HIGH injury with no substitutes left** raises no forced decision.
    The player leaves, the team takes its reduced shape, and an `INJURY`
    event is emitted.
*   **AI coach** (`engine/ai/AiCoach.js`). Every 1 s of match time it reads
    the state and applies the rules in `ai_coach.yaml`:
    *   after 55', substitute players under 60% fitness, or with a MEDIUM or
        HIGH injury, using the best role match on the bench
    *   after 70' and losing, or after a red card, switch formation

    It issues commands through `applyCommand` with `issuer: 'ai'`, so the
    same limits apply and the commands go in the log. In v1 it reads exact
    state.
*   **`MatchResult`** (returned by `engine.getResult()` at full time,
    versioned):
    *   `{v: 1, engineVersion, configHash, seed, score, events, stats}`
    *   per player: minutes, distance, final fitness, cards, injury level,
        goals, assists
    *   `suspensions` (red cards)
    *   `finalStateHash`

    Career mode uses this to carry state between matches.

### 13. Events and statistics

*   **Event registry.** `config/events.yaml` is the single list of event
    types. For each type it gives:
    *   its required actors
    *   its metadata fields and their types
    *   whether it is a highlight trigger, and whether it forces a pause
    *   which stats it updates
    *   its minimum number of commentary variations (`minVariations`)

    The full list of types is in item 14.

    The build turns it into `generated/events.js`. Engine debug builds
    validate every emitted event against it. The commentary build checks
    that every type has templates in every locale. Types may be added but
    never renamed.
*   **Event shape:**
    `{v: 1, seq, tick, type, teamIndex, actorIndex, secondaryIndices,
    x, y, zone, meta}`. `meta` holds type-specific numbers, for example
    `xg`, `psxg`, `goalY`, `goalZ`, `vShot`, `distance` and `bodyPart` for
    shots.
*   **Stats.** `MatchStats` updates only from events. Every reported
    number therefore has a formula over the event stream, and the
    calibration runner can recompute any metric from a stored event log.
    Possession % is pass share: a team's attempted `PASS` events over both
    teams' attempted `PASS` events. Every open-play cross also emits a
    `PASS` (kind `CROSS`) and every open-play keeper distribution a `PASS`
    (kind `GK_THROW` or `GK_KICK`), because StatsBomb records both as
    passes. Restarts (kick-offs, throw-ins, goal kicks, corners, free kicks)
    are separate event types and never `PASS`, so they are excluded on both
    sides, matching the reference extractor.
    Three soft extras are read from state, not events: `timeOnBallPct`
    (ticks in control), distance and sprints. Every hard metric comes from
    events only.
*   **xG and PSxG** live in `engine/xg/` and are separate from shot
    resolution.
    *   `xg({distance, angle, isHeader, defendersInCone, assistType})` is a
        logistic formula (features defined in item 26b). Its coefficients are in
        `config/xg.yaml`, fitted offline to public StatsBomb Open Data.
    *   `psxg(xg, goalY, goalZ, vShot)` (post-shot expected goals) multiplies
        the xG by a placement and speed factor, so shots placed near the
        goal's corners and fast shots tend toward 0.75–0.95, and central or
        slow shots toward 0.05–0.15. Off-target and blocked
        shots get 0.

    The engine never uses xG to decide whether a shot scores. Shots are
    decided by `shotPlacement` and `saveOutcome`. That separation is what
    makes "goals ≈ xG" a real test.
*   Secondary metrics are computed from the same events and reported:
    PPDA (opponent passes allowed per defensive action in the opponent's
    60% of the pitch), field tilt (a team's share of both teams'
    final-third passes) and PSxG totals.

### 14. Runtime: playback controller (browser, main thread)

`runtime/MatchController.js` owns the live engine, a `RenderSnapshot`
ring and the playback state machine.

*   **Pull loop.** On each `requestAnimationFrame`:
    1.  Clamp `frameSeconds` to at most 0.1 s, then add
        `frameSeconds × 20 × speed` to a tick budget, where speed is 0–60.
    2.  Step `floor(budget)` ticks, capped at 20 per frame
        (`maxTicksPerFrame` in `playback.yaml`), then clamp the remaining
        budget to at most 1. Sim time beyond the cap is dropped, so a slow
        phone runs a little slower than the slider instead of building an
        unbounded backlog. `#bench` counts dropped budget.
    3.  Draw using `alpha = clamp(budget, 0, 1)` to interpolate between
        previous and current positions.

    At 0x the loop stops requesting frames until the speed changes.
*   **Render ring.** After every stepped tick the controller copies the
    engine's `RenderSnapshot` into a preallocated ring of 500 frames
    (300 lead-up + 40 post-roll + 160 extension; about 200 KB), along with
    that tick's event range.
*   **Playback states:** `FULL_MATCH`, `FAST_FORWARD`, `REPLAY`,
    `PAUSED_HIGHLIGHT`, `PAUSED_FORCED`, `PAUSED`, `HALF_TIME`, `FULL_TIME`.
*   **Best Moments:**
    1.  In `FAST_FORWARD`, call `step(1)` in a loop, checking the injected
        `now()` clock after each call. Stop when 8 ms of the frame have
        passed or after `ffMaxTicksPerFrame` (2,000) ticks, whichever comes
        first. This is controller code, not engine code.
    2.  When a highlight-trigger event appears, keep stepping the live
        engine to `triggerTick + 40`. If another trigger fires inside that
        window, extend to its tick + 40, but never past
        `firstTriggerTick + 160`; a trigger after that starts the next
        replay. The end point is `replayEndTick`.
    3.  If a forced decision stops `step()` inside that window,
        `replayEndTick` becomes the forced tick.
    4.  Play the ring from `triggerTick − 300` (or the first recorded tick)
        to `replayEndTick` at 1–2x, releasing each tick's events to the
        commentary as the replay reaches them.
    5.  Enter `PAUSED_FORCED` if the replay was cut short by a forced
        decision, otherwise `PAUSED_HIGHLIGHT` with a "Continue" button and
        a countdown. Opening the Manager drawer cancels the countdown.
    6.  Manager commands are disabled during `REPLAY`. Commands issued
        afterwards apply from the live engine's tick, which is
        `replayEndTick`, the same moment the replay ended on.
*   **Forced decisions** (`FORCED_DECISION_REQUIRED`) outside a replay move
    any state to `PAUSED_FORCED` and open the Subs drawer.
*   **Half-time and full-time.** When `step()` stops for `HALF_TIME`, the
    controller enters `HALF_TIME` and shows the half-time dialog;
    "Continue" calls `step()` again. At `FULL_TIME` it shows the result
    dialog and deletes the save record. A replay never spans half-time.
*   **Event release.** In Full Match the live engine never runs ahead of the
    screen, so events go to the views as they are produced. In Best Moments,
    during fast-forward the commentary shows one line per
    highlight-flagged event, the scoreboard shows score and clock, and the
    pitch shows only the ball's zone. Stats always include every event,
    including events from highlights over the replay cap.
*   **Repro record.** The save record (§20) is also the repro record; the
    app can copy it to the clipboard.

### 15. UI

*   `ui/index.html` is a static portrait shell. `ui/styles/` holds a base
    sheet plus one sheet per view, using CSS variables and a container
    with aspect ratios between 9:16 and 9:19.5.
*   Each view has an HTML partial (`*.html`) and an ES6 class. Vite
    imports the partial as a string (`?raw`), so there is no runtime fetch.
    Each class has `mount(rootEl)`, `update(frame)` and `destroy()`, where
    `frame` is the object the controller gives views (item 52).
*   The views:
    *   `ScoreboardView`: score, clock, half, added time, language toggle
    *   `PitchCanvasView`: described below
    *   `ControlsView`: speed slider 0–60x, mode toggle
    *   `CommentaryView`: scrolling feed
    *   `StatsView`: comparison bars
    *   `ManagerView`: formation switch, bench, pending substitutions,
        forced-decision prompt
    *   `BenchView`: the `#bench` performance page
*   Stats and Manager open as bottom drawers.
*   `PitchCanvasView`:
    *   Draws the static pitch once to an offscreen canvas.
    *   Scales by `devicePixelRatio`.
    *   Each frame draws 22 player dots with numbers, the ball (drawn larger
        when high), fitness rings, and badges for cards, injuries and the
        stand-in keeper.
*   The language toggle sets a global locale. `CommentaryView` re-renders
    the whole feed from the stored events. A line is a pure function of the
    event, the locale and the commentary seed, so past lines change
    language too.

### 16. Commentary and languages

*   `config/commentary/pt-PT.yaml` and `en-GB.yaml` map each event type to
    a list of template variations.
*   `i18n/Commentator.js` picks a variation index from the commentary RNG
    seeded from `matchSeed` and `event.seq` (§5). Every locale has the same
    number of variations per type, so the index is the same in both
    languages, which keeps switching predictable.
*   Templates use a fixed token namespace: `{minute}`; `{player.*}` (the
    event's `actorIndex`); `{player2.*}` (`secondaryIndices[0]`);
    `{team.*}` (`teamIndex`); `{opponent.*}` (the other team);
    `{meta.<field>}`. Examples: `{player.name}`, `{team.artDef}`,
    `{team.contractionDe}` and `{player.g:substituído|substituída}`. The
    last one picks a word by the player's `gender`.
*   `Team` and `Player` input records carry `gender` and the Portuguese
    article tokens, defaulting to masculine.
*   The build checks that every event type has at least one template per
    locale, and that every token exists on that event type. With
    `--strict-i18n` (on from build step 8) it also requires
    `minVariations` per type and equal counts across locales.
*   `config/ui-strings/pt-PT.yaml` and `en-GB.yaml` hold button and label
    text.

### 17. Config build

*   `scripts/build-config.mjs` does the following:
    1.  Reads every file in `config/` with the `yaml` package, which
        reports errors with line and column.
    2.  Validates each file against its JSON Schema in `config/schema/`
        using `ajv`, with `additionalProperties: false` on record objects, so
        misspelled keys fail the build.
    3.  Writes `generated/config.js` and `generated/events.js`.
    4.  Computes `configHash` as SHA-256 of the canonical JSON (keys sorted
        recursively).

    It runs before `dev`, `build`, `test`, `typecheck`, `bench` and
    `calibrate`.
*   Squads are not compiled into the app. They are `MatchInput` data; the
    sample squads in `config/squads/` are converted to JSON input files by
    the same script.
*   Calibration targets live in `config/calibration/targets.yaml`,
    separate from weights.

### 18. Calibration and benchmarks (Node)

*   **Squad generator** (`shared/squadgen.js`) builds squads from
    these normal distributions, clamped to 1–20. The Scenario B gap is
    frozen before tuning starts:
    *   Scenario A: primary mean 14 (sd 1.5), secondary mean 12.5 (sd 1.5)
    *   Scenario B strong: primary 17 (sd 1.2), secondary 15 (sd 1.5)
    *   Scenario B weak: primary 10 (sd 1.5), secondary 9 (sd 1.5)

    It lives in `src/shared/` and runs in Node and the browser. It uses
    `sfc32` and an Irwin–Hall normal approximation with its own seed, so a
    scenario's squads are byte-identical across Node versions.
*   **Runner** (`calibration/run.js`):
    1.  Splits match seeds across a `worker_threads` pool, one worker per
        core.
    2.  Each match collects per-team metrics from its event stream.
    3.  For every metric, computes the mean, p10 and p90 per scenario.
    4.  Compares them with `targets.yaml`:
        *   Scenario A: a hard metric passes only if the mean is in its band
            and p10 and p90 are each within
            `max(tolerance × |ref|, toleranceAbs)` of the reference
            percentiles, with `tolerance` fixed per metric (0.15 or 0.20).
        *   Scenario B: strong-side mean possession 60–70%, strong-side xG
            share ≥ 0.75 and strong-side win rate 70–80% are hard. All other
            Scenario B values are soft.
    5.  Writes `reports/calibration-<YYYY-MM-DD>-<configHash8>.json` and a
        Markdown summary, including the config hash, engine version and
        seed range, and the 3 worst seeds per failing metric (so they can
        be opened in the debug viewer).
    6.  Exits non-zero on any hard failure.

    Reports are grouped by four layers: L1 physical, L2 progression, L3
    defending, L4 chances and discipline. Each metric's layer is in
    `targets.yaml`. Tuning is not done layer by layer; every run checks
    every band.
*   Extra checks reported (soft): goals per match, draw rate, 0–0 rate,
    mirrored squads giving mirrored results, and absurd-state counters (a
    player more than 30 m from their anchor for more than 20 s).
*   **Benchmarks** are described after §18a.

### 18a. Reference data for calibration

*   **Possession definition:** pass share. A team's possession % is its
    attempted open-play passes divided by both teams' attempted open-play
    passes (FBref/Opta style). The engine computes it from `PASS` events,
    and `scripts/build-reference.mjs` computes it from StatsBomb events with
    the same formula, so the two numbers always share one definition.
    Ticks in control stay as a soft metric, `timeOnBallPct`.
*   **Reference percentiles:** StatsBomb Open Data, full-season league
    competitions only (the 2015/16 seasons of the five top European
    leagues, about 1,800 matches and 3,600 team rows). The single-club
    collections (for example the Barcelona-only La Liga seasons) are
    excluded because they skew possession and passes. All 8 hard metrics
    are computed per team per match from the raw events, never copied
    from season averages: season averages have a much narrower spread than
    single matches and would make the p10/p90 check fail for the wrong
    reason. Reference xG is the project's own `xg.yaml` model applied to the
    StatsBomb shots, not StatsBomb's xG, so the check compares the engine
    with real shot locations under one model. FBref/Opta team match logs
    are a manual cross-check only: their xG, shot and foul definitions
    differ from StatsBomb's, their data cannot be redistributed, and their
    availability is outside the project's control.
*   **Scenario B reference subset:** every 2015/16 league match between a
    final-table top-4 side and a bottom-4 side of the same league. That is
    4 × 4 pairs × 2 legs = 32 matches per league, 160 matches in all, which
    gives 160 `strong` rows and 160 `weak` rows. Each tail percentile rests
    on about 16 rows, which is too noisy to gate the build, so Scenario B
    percentiles are soft. The hard Scenario B checks are strong-side
    possession (60–70%), xG share (≥ 0.75) and win rate (70–80%). The
    extractor reports these three from the subset, plus a bootstrap 90%
    interval for every percentile, for information.
*   **Scenario B attribute gap:** the squad distributions in
    `scenarios.yaml` (strong 17/15, weak 10/9) are frozen before tuning
    starts. Calibration may change weights, not the gap, so a pass cannot
    come from moving the gap.
*   **Tolerance floor:** the per-metric tolerance (0.15 or 0.20) is relative, which breaks
    for percentiles at or near zero (goals p10 is 0 for most rows; weak-side
    shots on target p10 is about 0–1). Each metric gets an absolute floor,
    `toleranceAbs`, and the allowed gap is `max(tolerance × |ref|,
    toleranceAbs)`.

### 18b. Benchmarks

*   **Benchmarks.**
    *   `npm run bench` runs 20 full matches in Node and reports the mean
        engine ms per 20-tick window and the time to re-simulate a full
        match. It fails only above 1.0 ms per 20 ticks (a loose ceiling;
        the estimate from the assumed 6× slowdown is 0.33 ms).
    *   `#bench` in the app runs the same loop on the device and shows p95
        ms per frame for engine work and for drawing, the full-match
        re-simulation time, dropped budget, and the golden hash.

### 19. Tooling

*   Vite for the dev server and bundle. Capacitor for Android.
*   ESLint for the determinism rules and import boundaries.
*   `node:test` for unit and golden tests, so no test framework is needed.
*   Playwright for the cross-engine determinism check.
*   Runtime dependencies: `@capacitor/core`, `@capacitor/app` and
    `@capacitor/preferences`, none of them inside the engine. Build-time:
    `yaml`, `ajv`, `vite`, `@capacitor/cli`, `@capacitor/android`, `eslint`,
    `@eslint/js`, `globals`, `eslint-plugin-import`, `typescript`,
    `@types/node` and `@playwright/test` (versions in item 1).

### 20. App lifecycle and persistence

*   `runtime/Persistence.js` listens to `@capacitor/app` `pause` and to
    `visibilitychange`.
*   It saves one record with `@capacitor/preferences` under key
    `freefoot.match.v1` when a command is accepted and on either lifecycle
    event (skipped if `tick` has not changed since the last save). The save
    call starts synchronously inside the handler, so it is queued before
    the WebView is suspended. The record is a few tens of KB:
    *   `schemaVersion`, `engineVersion`, `configHash`
    *   the compiled config itself
    *   the `MatchInput`
    *   the command log
    *   `tick` and `stateHash` at that tick
    *   the playback state and mode
*   **Resume.** On launch, if a record exists and its `schemaVersion` and
    `engineVersion` match, the app offers "Resume match". It verifies the
    config's SHA-256 against `configHash`, re-creates the engine from the
    saved config and input, applies the command log, and steps to `tick`
    behind a progress overlay. Up to about 11 s at 85' on the reference
    device at the 2.0 ms budget. Then it compares `hash()` with
    `stateHash`.
    *   On a hash match it restores the saved playback state (a saved
        highlight pause resumes as `PAUSED`). The full event history is
        rebuilt by the re-simulation, so the commentary feed and
        `getResult()` are complete.
    *   On any version or hash mismatch the record is discarded and the
        user is told why. A hash mismatch is also a determinism failure on
        this device and is logged on `#bench`.
    *   Because the record carries its config, an app update that changes
        only YAML does not discard a saved match.
    *   Fallback, if `#bench` shows re-simulation too slow: add a
        `serialize()` snapshot to the record and resume from it. This is a
        stated contingency, not v1 work.
*   The Android back button (`@capacitor/app` `backButton`) opens a
    "Leave match?" prompt. "Leave" saves the record, then calls
    `App.minimizeApp()`; "Stay" does nothing.
*   At full time the record is deleted.
*   The same record is the repro record (§14, CUJ 3).

## Risks & Mitigations

Each mitigation below already exists elsewhere in this design; the table
records the risk and where it is handled.

| Risk | Category | Likelihood / impact | Mitigation | Detection or trigger |
| :-- | :-- | :-- | :-- | :-- |
| Manual calibration does not converge on all hard checks | Calibration | High / High (largest schedule risk) | Time-box tuning rounds; the debug viewer opens the 3 worst seeds per failing metric (§18, build step 6); bands are corrected once before tuning and then frozen; the attribute gap is frozen (§18a). Fallback: make the Scenario A p10/p90 checks soft and record that as a v1 limitation. Automatic calibration stays in Future Improvements. | `npm run calibrate` report |
| The phone misses the 2.0 ms budget | Performance | Medium / High | Plain objects first, typed arrays as a contingency (§4); the tick budget drops excess sim time instead of building a backlog (§14). Fallbacks: cap the slider at 30x, then move the engine to a Web Worker (Non-Goals). | `#bench` on the reference device |
| Determinism breaks on an Android System WebView update | Determinism | Low / High | Banned transcendental math and an allowlist (§5); CI compares Node and Chromium; the resume hash check and the `#bench` golden hash run on the device (§20). | Resume hash mismatch; `#bench` golden hash |
| Resume takes too long late in a match | UX | Medium / Medium | Progress overlay; measured on `#bench`. Fallback: add a `serialize()` snapshot to the save record (§20). | `#bench` re-simulation time |
| A save is lost when Android kills the app | Data | Low / Medium | Save on every accepted command and on `pause`, started synchronously in the handler (§20). | Force-stop check in the Verification Plan |
| An engine update discards an in-progress match | Data | Medium / Low | Accepted v1 limitation; config-only updates keep saves because the record carries its config (§20). The user is told why. | Discard reason shown at launch |
| Noisy reference tails for Scenario B | Calibration | High / Medium | Scenario B percentiles are soft; only possession, xG share and win rate gate the build (§18a). | Bootstrap intervals in the reference report |
| A malformed save record or repro record reaches the engine | Security / robustness | Low / Low | `validateMatchInput` (item 28), `applyCommand` validation and the config SHA-256 check before re-simulation (§20). Records come only from local storage or the author. | Validation errors |
| StatsBomb Open Data terms | Licensing | Low / Medium | Only fitted coefficients and summary percentiles ship, never the data; attribution in the README and the `xg.yaml` source note. Check the StatsBomb user agreement before a public release. | Release checklist |

## Alternatives Considered

### Alternative A: Checkpoint re-simulation every 5 match minutes

*   **Pros**: Bounded re-simulation cost for any rewind.
*   **Cons**: With a deterministic engine, replaying unchanged inputs from a
    checkpoint just reproduces the same state, so it does nothing useful
    unless ticks were simulated ahead of the screen. At 5-minute spacing a
    rewind costs up to 6,000 ticks.
*   **Reason for Rejection**: Rejected. The pull model never
    simulates ahead of the screen, so commands need no rewind. Replays use
    a render ring; save and repro re-simulate from tick 0.

### Alternative B: Web Worker running 1–2 s ahead of the screen

*   **Pros**: The engine runs off the main thread, so heavy ticks can't
    drop frames.
*   **Cons**:
    *   A command at the displayed tick needs the full state of a tick the
        worker has already passed, which a render buffer can't provide.
    *   "1–2 s" was undefined: 1–2 s of match time is about 120 ticks;
        1–2 s of real time at 60x is about 7,200.
    *   It adds async message ordering, and the events shown can run ahead
        of the pitch.
*   **Reason for Rejection**: Rejected for v1. Engine work at 60x
    is 20 ticks per frame. The 2.0 ms budget is expected to hold, pending
    the first `#bench` run (see Open Questions). A worker can be added
    in v2 if the phone benchmark shows dropped frames. The engine has no DOM
    dependency, so the move is mechanical.

### Alternative C: Command delay rule (touchline delay ≥ lookahead)

*   **Pros**: Removes rollback while keeping a worker that runs ahead. Fits
    the idea that a coach's instructions take time to reach the players.
*   **Cons**: Every command feels late, and the delay is tied to an
    implementation detail (the lookahead) rather than to football.
*   **Reason for Rejection**: Rejected. Not needed once nothing
    runs ahead of the screen.

### Alternative D: Fixed 60 Hz simulation step

*   **Pros**: The ball moves only about 0.5 m per step, so simple endpoint
    distance checks rarely miss contacts. No interpolation needed for
    drawing.
*   **Cons**:
    *   Decisions run at 4–5 Hz anyway.
    *   At 10x–60x the screen shows only 1 tick in 10–60.
    *   Calibration and battery cost scale with the tick count: 3× the work
        of 20 Hz.
*   **Reason for Rejection**: Rejected. Replaced by 20 Hz with
    swept ball checks and 60 FPS interpolation.

### Alternative E: Five per-subsystem RNG streams, or a mulberry32 stream

*   **Pros**: Per-subsystem streams look as if they keep one subsystem's
    extra draws from changing another's outcomes. mulberry32 is about 5
    lines of code.
*   **Cons**:
    *   In a coupled spatial simulation the isolation never holds: one
        extra draw changes a pass, which changes positions, contacts and
        every later outcome.
    *   mulberry32 puts every seed on the same 2^32-step cycle. At 3–4
        million draws per match, the 1,000 calibration seeds (500 per
        scenario) overlap about 800 times, so samples aren't independent.
*   **Reason for Rejection**: Rejected. One `sfc32` engine stream
    seeded through a `splitmix32` chain, plus a separate commentary
    generator.

### Alternative F: Determinism guaranteed only within one V8 version

*   **Pros**: Free; no restrictions on `Math` functions.
*   **Cons**: Android System WebView updates itself and its V8 differs from
    Node's. Transcendental functions (`sin`, `atan2`, `exp`, `pow`) have
    changed results across V8 versions, so a phone bug report might not
    reproduce in Node.
*   **Reason for Rejection**: Rejected. The engine bans those
    functions and uses polynomial versions built from correctly rounded
    IEEE-754 arithmetic, checked in CI across Node and Chromium.

### Alternative G: Typed arrays (structure of arrays) behind facade classes

*   **Pros**: Flat memory, cheap keyframe copies and byte-level hashing.
*   **Cons**:
    *   Two parallel views of every entity (arrays plus getter/setter
        facades) and more work for every new field.
    *   The benefit applies to frequent state copies, which the design no
        longer makes: no keyframes, and `serialize()` runs only in tests,
        repro and the save fallback.
    *   The state is 36 players and one ball; temporaries, not long-lived
        objects, cause GC pressure.
*   **Reason for Rejection**: Rejected for v1. Plain objects
    created once, with index references and scratch buffers. Typed arrays
    remain the contingency if `#bench` fails.

### Alternative H: A separate replay engine restored from keyframes

*   **Pros**: The lead-up can be any length without a ring sized for the
    worst case.
*   **Cons**:
    *   A second engine, a keyframe ring every 150 ticks, `fromState` for
        replays and command-log replay inside the runtime.
    *   A long chain of triggers can evict the keyframe a replay needs.
    *   A replay only draws, so restoring full state is never needed.
*   **Reason for Rejection**: Rejected. The live engine already
    steps to `replayEndTick` before a replay starts, so a 500-frame
    `RenderSnapshot` ring (about 200 KB) holds everything a replay draws.

### Alternative I: Morale and coach authority in v1

*   **Pros**: Matches the original concept; makes matches swing after goals
    and bad decisions.
*   **Cons**:
    *   Without career mode there is no source for starting values.
    *   It adds about five interacting tuning knobs on an uncalibrated core,
        and can create runaway loops (losing → low morale → fouls → red →
        losing).
*   **Reason for Rejection**: Rejected for v1. Deferred to v2
    behind `getEffectiveAttribute`.

### Alternative J: "Mean inside the band" as the only calibration check

*   **Pros**: Simple to compute and explain.
*   **Cons**: The bands describe match-to-match spread, and a 500-match mean
    barely moves (shots standard error ≈ 0.18). An engine that gives every
    match the same score would pass.
*   **Reason for Rejection**: Rejected. Scenario A hard metrics
    also require p10 and p90 within a per-metric tolerance of the reference
    values, which bounds the spread from below.

### Alternative K: The engine's own shot probability reported as xG

*   **Pros**: No second model to build.
*   **Cons**: Circular: the xG band would only check that the engine agrees
    with itself.
*   **Reason for Rejection**: Rejected. xG comes from a separate
    logistic formula fitted to public StatsBomb data. Goals come from shot
    placement and save resolution.

### Alternative L: Layer-by-layer manual calibration

*   **Pros**: Easy to reason about one group of metrics at a time.
*   **Cons**: The layers are coupled. Tuning tackles moves possession,
    which moves passes and shots, so tuning one layer at a time goes round
    in circles.
*   **Reason for Rejection**: Rejected as a tuning order. Layers
    remain the way the report is organised; every run checks every band.

### Alternative M: Plain `{variable}` substitution for Portuguese

*   **Pros**: Simplest templating.
*   **Cons**: Can't agree articles and endings with gender ("o Benfica" /
    "a Académica", "substituído" / "substituída").
*   **Reason for Rejection**: Rejected. `Team` and `Player` carry
    gender and article tokens; templates have a gender-choice token.

### Alternative N: Substitutions at the tick on screen, or after a timeout

*   **Pros**: Immediate feedback for the manager. A timeout variant (force
    the swap after N seconds) caps the wait.
*   **Cons**: A player vanishing mid-attack looks wrong and can be exploited,
    for example by swapping a centre-back just before a cross. The timeout
    variant needs a walk-off state and can still swap mid-attack.
*   **Reason for Rejection**: Rejected. Substitutions are queued
    to the next dead ball; formation switches stay immediate.

### Alternative O: IFAB substitution windows (3 plus half-time)

*   **Pros**: Matches real competition rules.
*   **Cons**: In v1, substitutions are the main lever a manager has (G5);
    there are only two formations and no tactical instructions. Windows
    would cut the number of interventions that can be observed per
    calibration and play-test session, and add window state and test cases
    that only a career mode enforcing competition rules needs.
*   **Reason for Rejection**: Rejected for v1. 5 substitutions,
    no window limit; windows can be added with career-mode competition
    rules.

### Alternative P: Physics library or 3D ball flight

*   **Pros**: Realistic bounces, spin and trajectories with little custom
    code.
*   **Cons**:
    *   Libraries such as planck.js and matter.js use transcendental math
        and internal ordering that break cross-engine determinism.
    *   Per-tick 3D integration costs more on a phone.
*   **Reason for Rejection**: Rejected. 2D kinematics plus a
    closed-form height for lofted balls, and `goalZ` used only at shot
    resolution.

### Alternative Q: Event-driven "phase" simulation without positions

*   **Pros**: Very fast; easy to calibrate.
*   **Cons**: Nothing to draw on the pitch; statistics don't come from
    space and movement.
*   **Reason for Rejection**: Rejected for this engine. Kept as a
    candidate for career mode's fast simulation of other matches.

### Alternative R: SharedArrayBuffer between engine and UI

*   **Pros**: Zero-copy snapshots.
*   **Cons**: Needs cross-origin isolation headers (COOP/COEP), which are
    awkward in Capacitor; pointless without a worker.
*   **Reason for Rejection**: Rejected. Deferred with the worker.

### Alternative S: Plain JS config modules instead of YAML

*   **Pros**: No parser or build step; comments and computed values.
*   **Cons**: Harder for non-programmers and translators to edit;
    templates are noisier in JS strings.
*   **Reason for Rejection**: Rejected. YAML is the editing
    format, validated by JSON Schema and compiled to JS at build time.

## Non-Functional Requirements

*   **Performance:**
    *   p95 engine work per 20 ticks under 2.0 ms on the reference device
        (a Snapdragon 680 phone), measured with `#bench`.
    *   p95 frame time at or under 16.7 ms at every speed.
    *   Full-match re-simulation for resume under 12 s on the reference
        device.
    *   `npm run bench` in CI reports, and fails only above 1.0 ms per 20
        ticks.
*   **Memory:**
    *   One engine plus a 500-frame `RenderSnapshot` ring (about 200 KB).
    *   The event log for one match (about 3,000–5,000 events).
    *   Target under 30 MB of JS heap for a match on the phone.
*   **Offline:** no network requests at runtime. All config, squads and
    strings are bundled.
*   **Determinism:** the same input and command log give the same per-tick
    hash in Node and Chromium. This is a release gate.
*   **Privacy and security:** no accounts, no network, no telemetry. The
    repro bundle is exported only when the user taps "Export".
*   **Rollout and rollback:**
    *   Saved matches carry `schemaVersion`, `engineVersion` and their own
        config. An engine or schema change discards the save; a config-only
        update does not, because the save re-simulates with its own config.
    *   `MatchEvent` and `MatchInput` carry a version field `v` from day
        one, so career-mode saves can be migrated later.

--------------------------------------------------------------------------------

## Additional Resources

*   [concepts_brief.md](../../concepts_brief.md): the brainstorm record and
    the decisions made in each design round.
*   StatsBomb Open Data (`github.com/statsbomb/open-data`): source for
    fitting the xG coefficients and for the reference mean, p10 and p90 of
    the 8 hard metrics (2015/16 top-five league seasons). Attribution as
    required by the StatsBomb licence goes in `reports/` and the README;
    the data itself is not shipped in the app.
*   IFAB Laws of the Game: offside (Law 11), substitutions (Law 3),
    added time (Law 7).
*   Capacitor docs for `@capacitor/app` and `@capacitor/preferences`.

## Future Improvements

*   **Automatic calibration.** Add a black-box optimiser (CMA-ES in
    `worker_threads`, or Optuna reading the JSON reports). It would use
    the same seed set on every run and a sensitivity screen showing which
    weights move which metrics. Manual tuning across 8 hard metrics and
    about 30 soft ones is the largest schedule risk.
*   **Morale and coach authority** through `getEffectiveAttribute`
    modifiers, with caps and a recovery rate to prevent runaway loops.
*   **Referee error and VAR** as a decorator around `Referee`.
*   **Web Worker** for the live engine, if `#bench` shows dropped frames.
*   **Native share sheet** for repro records (`@capacitor/filesystem` plus
    `@capacitor/share`), if clipboard copy proves awkward.
*   **More tactical instructions** (pressing height, width, tempo) as anchor
    and decision-weight modifiers.
*   **Fast low-detail simulator** for other matches in a league round,
    calibrated against this engine's reports.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

All source is `.js` (ES2022 modules) with JSDoc types, checked by
`tsc --noEmit` through `jsconfig.json` (`checkJs: true`); there are no
TypeScript source files. Paths are relative to the
repository root. Files under `generated/` and `reports/` are build output
and are not edited by hand. `android/` is generated once by
`npx cap add android` and committed; its only hand edit is the portrait
lock (item 87).

### Target Files to Create/Modify

#### Project setup

##### 1. `./package.json` (Create)

*   **Type / Scope**: npm manifest.
*   **Proposed Changes**:
    *   `"private": true`, `"type": "module"`,
        `"engines": {"node": ">=22.8"}`, and
        `"imports": {"#generated/*": "./generated/*"}` (resolved by both
        Node and Vite).
    *   Scripts:
        *   `build:config`: `node scripts/build-config.mjs`
        *   `dev`: `npm run build:config && vite`
        *   `build`: `npm run build:config && vite build`
        *   `test`: `npm run build:config && node --test "tests/**/*.test.js"`
        *   `test:coverage`: `npm run build:config && node --test --experimental-test-coverage --test-coverage-lines=85 --test-coverage-include="src/engine/**" --test-coverage-include="src/runtime/**" "tests/**/*.test.js"`
        *   `test:e2e`: `npm run build:config && playwright test`
        *   `lint`: `eslint .`
        *   `typecheck`: `npm run build:config && tsc --noEmit -p jsconfig.json`
        *   `bench`: `npm run build:config && node src/calibration/bench.js`
        *   `calibrate`: `npm run build:config && node src/calibration/run.js`,
            with `--scenario A|B|all` and `--matches N` (default 500)
        *   `repro`: `node scripts/repro.mjs <record.json> [--tick N]`
        *   `fit-xg`: `node scripts/fit-xg.mjs <statsbomb-dir>`
        *   `reference`: `node scripts/build-reference.mjs <statsbomb-dir>`
        *   `android`: `npm run build && cap sync android`
    *   Golden files: see item 75 (`UPDATE_GOLDEN=1`).
    *   The `test` glob matches `*.test.js` only; Playwright specs are
        named `*.spec.js`, so `node --test` never picks them up.
    *   Runtime dependencies (caret on the major): `@capacitor/core@^7`,
        `@capacitor/app@^7`, `@capacitor/preferences@^7`,
        `@capacitor/clipboard@^7`.
    *   Dev dependencies: `yaml@^2`, `ajv@^8`, `vite@^6`, `@capacitor/cli@^7`,
        `@capacitor/android@^7`, `eslint@^9`, `@eslint/js@^9`, `globals@^15`,
        `eslint-plugin-import@^2`, `typescript@^5` (type checking only),
        `@types/node@^22`, `@playwright/test@^1`.
*   **Why**: one entry point for every workflow in the CUJs.

##### 1a. `./.nvmrc` (Create)

*   **Type / Scope**: Node version pin.
*   **Proposed Changes**: `22`.
*   **Why**: the test glob and coverage flags need Node 22.8 or later.

##### 2. `./jsconfig.json` (Create)

*   **Type / Scope**: Type-check configuration.
*   **Proposed Changes**: `checkJs: true`, `allowJs: true`, `strict: true`,
    `noEmit`, `module: ESNext`, `moduleResolution: "bundler"`,
    `resolveJsonModule: true`, `target: ES2022`, `lib: ["ES2022", "DOM"]`,
    `types: ["node", "vite/client"]`. Includes `src/`, `scripts/`,
    `tests/`, `generated/`.
*   **Why**: catches shape errors in the plain-object contracts (events,
    commands, input) without leaving JavaScript.

##### 3. `./eslint.config.js` (Create)

*   **Type / Scope**: Lint configuration (flat config).
*   **Proposed Changes**: implements the rules in §5.
    *   First config object: `{ignores: ['dist/**', 'generated/**',
        'reports/**', 'test-results/**', 'playwright-report/**',
        'android/**']}`.
    *   Base: `@eslint/js` recommended; `globals.node` for the root
        `*.config.js` files; `globals.browser` for `src/ui` and
        `src/runtime`, `globals.node` for `scripts`, `src/calibration` and
        `tests`.
    *   For `src/engine/**`, `no-restricted-syntax` with these selectors:
        *   `MemberExpression[object.name='Math'][property.name!=/^(floor|ceil|round|trunc|abs|sign|sqrt|min|max|imul|fround|clz32)$/]`
        *   `MemberExpression[object.name='Math'][computed=true]`
        *   `BinaryExpression[operator='**']` and
            `AssignmentExpression[operator='**=']`
        *   `CallExpression[callee.property.name=/^(localeCompare|toLocaleString|toLocaleUpperCase|toLocaleLowerCase)$/]`
        *   `Identifier[name='Math']:not(MemberExpression[object.name='Math'] > Identifier.object)`
            (bans aliasing)
        *   `Math.PI` is outside the allowlist; `detmath.js` exports `PI`.
    *   For `src/engine/**`, `no-restricted-globals` bans `Date`,
        `performance`, `Intl`, `globalThis`, `window`, `document`, `process`,
        `require`.
    *   `import/no-restricted-paths` (from `eslint-plugin-import`) with two
        zones:
        *   target `./src/engine`, from `./src`, except `./engine`; and
            target `./src/engine`, from `./generated`
        *   target `./src/runtime`, from `./src/ui`
    *   For `src/engine/**`, `no-restricted-imports` with
        `patterns: [{group: ['node:*', '#*']}, {regex: '^(?![./])',
        message: 'engine imports only relative engine modules'}]`. This
        blocks `#generated/*` and every bare package, which
        `import/no-restricted-paths` cannot see because its resolver does
        not resolve `package.json` `"imports"`.
*   **Why**: enforces G1 (determinism) and G2 (engine boundary)
    mechanically.

##### 4. `./vite.config.js` (Create)

*   **Type / Scope**: Bundler configuration.
*   **Proposed Changes**:
    *   `root: 'src/ui'`, `build.outDir: '../../dist'`,
        `build.emptyOutDir: true`, `base: './'`.
    *   `build.rollupOptions.input`:
        `fileURLToPath(new URL('./src/ui/index.html', import.meta.url))`
        only, so the e2e page (item 85b) is served in dev but not bundled.
    *   Vite's default `server.fs.allow` already covers the repository
        root, so pages under `src/ui` can import `src/engine` and
        `generated/`.
    *   HTML partials imported with `?raw`.
*   **Why**: one offline bundle for Capacitor; dev server avoids desktop
    `file://` module restrictions.

##### 5. `./capacitor.config.json` (Create)

*   **Type / Scope**: Capacitor configuration.
*   **Proposed Changes**: `appId: "app.freefoot"`, `appName: "freefoot"`,
    `webDir: "dist"`, `android.adjustMarginsForEdgeToEdge: "force"`
    (Capacitor 7 targets SDK 35, where Android 15 enforces edge-to-edge,
    and older WebViews report 0 for `env(safe-area-inset-*)`). CSS
    `env(safe-area-inset-*)` stays as the web fallback (item 70).
    `androidScheme` is left at its default (`https`). The portrait lock is
    in item 87.
*   **Why**: packaging target (Capacitor, Android, offline).

##### 6. `./.gitignore` (Create)

*   **Type / Scope**: VCS ignore list.
*   **Proposed Changes**: `node_modules/`, `dist/`, `generated/`, `reports/`,
    `android/app/build/`, `test-results/`, `playwright-report/`.
*   **Why**: every listed path is produced by install, build, test or
    calibration runs; only sources are committed.

##### 7. `./README.md` (Create)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**:
    *   Folder map.
    *   Every npm script.
    *   How to tune: edit YAML, run `calibrate`, read the report.
    *   The determinism rules for engine code.
    *   How to run `#bench` on a phone.
    *   How to replay a repro record.
    *   Setup: `nvm use`, `npm ci`, `npx playwright install chromium`;
        JDK 21 and Android Studio for Android builds; and where to download
        StatsBomb Open Data (`<statsbomb-dir>` is the repository root that
        contains `data/`).
    *   StatsBomb Open Data attribution, as its licence requires.
*   **Why**: the author's working guide; the engine rules must be visible
    to anyone editing `src/engine/`.

#### Config (YAML sources and schemas)

##### 8. `./config/weights.yaml` (Create)

*   **Type / Scope**: Engine tuning data.
*   **Proposed Changes**: one key per coefficient named in §9a, each with a
    starting value and `initial: true` until calibration changes it:
    *   `decision`: feature weights `w` per action (pass, dribble, shot,
        cross, hold), noise `n0`, `n1`, and `visionMin`.
    *   `pass`: `p0`–`p5`, `e0`; `firstTouch`: `t0`–`t4`.
    *   `dribble`: `d0`–`d5`; `tackle`: `k0`–`k4`, `f0`–`f4`;
        `aerial`: `a0`, `a1`.
    *   `shot`: `r0`, `r1`, post-width band; `save`: `g0`–`g5`, `h1`.
    *   `movement`: top speed and acceleration from Pace and Acceleration;
        sprint threshold, default 7.0 m/s.
    *   `fitness`: band costs `c.walk|jog|run|sprint`, `rec`, `s_phys`,
        `s_ment`, threshold 0.7.
    *   `ball`: rolling resistance and loft parameters.
    *   `homeAdvantage: 0`.
    *   All rates are per second.
    *   Also the §9b behaviour constants (`movement`, `contest`,
        `ball.kinds`, `shot`, `keeper`, `decision.features`, `support`).
    *   Starting values and rate flags. `create()` converts every key
        marked as a rate to a per-tick value:

        | Keys | Start | Rate |
        | :-- | :-- | :-- |
        | logistic intercepts (`p0`, `t0`, `d0`, `k0`, `f0`, `a0`, `g0`, `c0`, `q0`, `y0`) | 0 | no |
        | logistic slopes (all other `p`, `t`, `d`, `k`, `f`, `a`, `g`, `c`, `q`, `y` keys) | 1.0 | no |
        | `e0` (pass error, m per m) | 0.05 | no |
        | `r0`, `r1` (shot error radius) | 0.6, 0.5 | no |
        | `h1` (held-save speed) | 18 | no |
        | `n0`, `n1` (decision noise) | 0.3, 0.5 | no |
        | `c.walk/jog/run/sprint` (fitness per second) | 0.00002 / 0.00005 / 0.0001 / 0.0003 | yes |
        | `rec` (recovery per second) | 0.00004 | yes |
        | `s_phys`, `s_ment` | 0.6, 0.2 | no |
        | `v0`, `v1`, `a0m`, `a1m` (movement) | 5.5, 3.5, 3, 4 | no |
        | ball rolling resistance (per second) | 0.6 | yes |

        Values given in §9a and §9b take precedence over this table. The
        injury keys `i0`–`i2` and `j0` live in `injuries.yaml`.
*   **Why**: G8. Tuning coefficients live here or in items 9–18; structural
    rule limits (11 players, 5 subs, pitch size) are code constants.

##### 9. `./config/roles.yaml` (Create)

*   **Type / Scope**: Role definitions.
*   **Proposed Changes**: roles `GK`, `CB`, `FB`, `MF`, `W`, `ST`, each with
    primary | secondary attributes, and rating weights 0.7 (primary mean) and
    0.3 (secondary mean):

    | Role | Primary | Secondary |
    | :-- | :-- | :-- |
    | GK | reflexes, oneOnOnes, agility, aerialReach, commandOfArea | positioning, composure, kicking, throwing |
    | CB | pace, acceleration, jumpingReach, strength, positioning | tackling, marking, composure, concentration, bravery |
    | FB | pace, acceleration, stamina, workRate, positioning | crossing, balance, decisions, marking, technique |
    | MF | decisions, positioning, teamwork, workRate, stamina | passing, technique, firstTouch, vision, tackling, aggression |
    | W | pace, acceleration, dribbling, offTheBall, decisions | agility, balance, flair, crossing, firstTouch |
    | ST | finishing, composure, offTheBall, pace, acceleration | firstTouch, determination, jumpingReach |
*   **Why**: roles are config, so a new role that reuses existing decision
    behaviour (for example DM, AM) needs no code change.

##### 10. `./config/tactics.yaml` (Create)

*   **Type / Scope**: Formations.
*   **Proposed Changes**:
    *   Formations `4-3-3` and `4-4-2`, plus reduced variants `4-3-2`,
        `4-4-1` and `4-3-1`, with reduction rules.
    *   Each slot has: role, attacking and defending anchor (pitch
        fractions), ball-follow coefficients, press zone, mark zone.
    *   Set-piece positions per restart kind.
    *   The emergency-shape mapping.
*   **Why**: §7 anchors, §11 reduced teams.

##### 11. `./config/injuries.yaml` (Create)

*   **Type / Scope**: Injury model.
*   **Proposed Changes**:
    *   `i0`, `i1`, `i2` (per-contact, §9a) and `j0` (fatigue, §9b).
    *   The level probability split.
    *   Per-level attribute multipliers by group (physical, technical,
        mental).
    *   Stoppage seconds per level.
*   **Why**: §11.

##### 12. `./config/officiating.yaml` (Create)

*   **Type / Scope**: Referee model.
*   **Proposed Changes**:
    *   Card terms `y0`–`y2`, red-card terms `r0`, `r1`, severity weights
        (§9b).
    *   Advantage: `advSeconds: 3`, `advMin: 5`.
    *   Added-time seconds per goal, substitution, card and injury.
    *   Offside tolerance in metres, default 0.
*   **Why**: §10.

##### 13. `./config/ai_coach.yaml` (Create)

*   **Type / Scope**: AI coach rules.
*   **Proposed Changes**:
    *   `evalIntervalTicks: 20`.
    *   Fitness threshold 60%; earliest minute for tired substitutions, 55'.
    *   Injury levels that trigger a substitution.
    *   Losing-late minute 70', and which formation to switch to.
    *   Red-card reaction.
    *   Maximum substitutions per check.
*   **Why**: §12.

##### 14. `./config/events.yaml` (Create)

*   **Type / Scope**: Event registry.
*   **Proposed Changes**: these types, each with required actors, `meta`
    fields with types, `highlight` (whether the type can trigger a
    highlight; the thresholds live only in `playback.yaml`),
    `forcesPause`, `minVariations` (3 unless marked 1) and stat entries in
    the form `{metric, side: actor | opponent, inc?: number, incFrom?:
    '<meta field>', when?: {<meta field>: value}}`. Examples:
    *   `SHOT`: `{metric: shots, side: actor}`,
        `{metric: xG, side: actor, incFrom: xg}`,
        `{metric: shotsOnTarget, side: actor, when: {result: ON_TARGET}}`
    *   `PASS`: `{metric: passes, side: actor}`,
        `{metric: passesCompleted, side: actor, when: {completed: true}}`
    *   `GOAL`: `{metric: goals, side: actor}`. An own goal (`kind:
        OWN_GOAL`) uses `side: opponent`.

    Derived metrics are computed in `metrics.js`, not stored:
    `passCompletionPct = passesCompleted / passes` and
    `possessionPct = passes / (passes + opponentPasses)`.

    Emission rules and ticks:
    *   `PASS` is emitted at launch, and its outcome event (`PASS` meta
        update or `POSSESSION_LOST`) at reception or interception.
        `meta.completed` is set on the launch event when the pass resolves.
        Stats count it at resolution.
    *   `SHOT` is emitted at the strike, with `meta.result` set when the
        ball is saved, blocked or leaves play.
    *   `GOAL` follows the `SHOT` in the same tick (higher `seq`). `ASSIST`
        follows the `GOAL` when the last pass by a team-mate came within
        10 s.
    *   `KEY_PASS` is emitted for a pass whose receiver shoots next.
        `TOUCH_IN_BOX` is emitted when a player receives inside the
        opponent box. `RECOVERY` is emitted when a team regains a loose
        ball. `BIG_CHANCE` follows a `SHOT` whose xG reaches the threshold.
    *   Events with no actor or location (`HALF_TIME`, `ADDED_TIME`,
        `FULL_TIME`) use `actorIndex: -1`, `x: -1`, `y: -1`.

    The table:

    | Group | Types | highlight | forcesPause | Hard stats fed |
    | :-- | :-- | :-- | :-- | :-- |
    | Goals | `GOAL` (meta.kind `OPEN_PLAY`/`PENALTY`/`FREE_KICK`/`OWN_GOAL`), `ASSIST` | `GOAL` | – | goals |
    | Shots | `SHOT` (meta.result `ON_TARGET`/`OFF_TARGET`/`BLOCKED`/`WOODWORK`; meta `xg`, `psxg`, `goalY`, `goalZ`, `vShot`, `distance`, `bodyPart`), `BIG_CHANCE` (derived; threshold in `playback.yaml`) | `WOODWORK` result, `BIG_CHANCE` | – | shots, shotsOnTarget, xG |
    | Chance creation | `KEY_PASS`, `CROSS` (meta.completed), `DRIBBLE` (meta.won), `TOUCH_IN_BOX` | – | – | – |
    | Passing | `PASS` (meta.kind `SHORT`/`LONG`/`THROUGH`/`SWITCH`/`CROSS`/`GK_THROW`/`GK_KICK`; meta.completed), `POSSESSION_LOST`, `MISCONTROL` | – | – | passes, passesCompleted (→ passCompletionPct, possessionPct) |
    | Defending | `TACKLE` (meta.won), `INTERCEPTION`, `CLEARANCE`, `BLOCK`, `AERIAL_DUEL` (meta.won), `RECOVERY` | – | – | – |
    | Goalkeeping | `SAVE` (meta.kind `HELD`/`PARRIED`/`TIPPED`; meta.psxg), `CLAIM`, `PUNCH`, `SMOTHER`, `GK_DISTRIBUTION` | `SAVE` (psxg threshold in `playback.yaml`) | – | – |
    | Restarts | `KICK_OFF`, `THROW_IN`, `GOAL_KICK`, `CORNER`, `FREE_KICK` (meta.direct), `PENALTY_AWARDED`, `DROP_BALL` (1) | `PENALTY_AWARDED` | – | – |
    | Officiating | `FOUL`, `OFFSIDE`, `YELLOW_CARD`, `RED_CARD` (meta.secondYellow) | `RED_CARD` | – | foulsCommitted |
    | Status | `INJURY` (meta.level), `INJURY_STOPPAGE` (1), `SUBSTITUTION`, `FORMATION_CHANGE`, `FORCED_DECISION_REQUIRED` (1; meta.reason `HIGH_INJURY`/`GK_SENT_OFF`) | – | `FORCED_DECISION_REQUIRED` | – |
    | Clock | `ADDED_TIME`, `HALF_TIME` (1), `FULL_TIME` (1) | – | – | – |

    *   `actorIndex` is the player who acts (shooter, passer, tackler,
        saving keeper, fouling player). `secondaryIndices[0]` is the other
        participant (receiver, fouled player, assisted shooter).
    *   Only `PASS` counts toward passes and possession. Every open-play
        cross and keeper distribution also emits a `PASS`; restarts are
        never `PASS`.
    *   VAR events are out of scope for v1.
*   **Why**: one list drives engine validation, stats, commentary coverage
    and highlight detection (§13). Types are never renamed, so the list is
    fixed here rather than guessed during implementation.

##### 15. `./config/xg.yaml` (Create)

*   **Type / Scope**: Shot models.
*   **Proposed Changes**:
    *   Logistic xG coefficients (intercept, distance, angle, header,
        defenders in cone, assist type).
    *   `penaltyXg: 0.76`.
    *   PSxG placement and speed factor parameters.
    *   Until `fit-xg` runs, placeholder coefficients (intercept −1,
        distance −0.1, angle 1.0, header −0.5, defenders −0.3, assist
        terms 0), marked `source: placeholder`.
    *   A `source` note naming the dataset and fit date.
*   **Why**: §13. Keeps xG separate from shot resolution.

##### 16. `./config/playback.yaml` (Create)

*   **Type / Scope**: Runtime settings.
*   **Proposed Changes**:
    *   Highlight thresholds: big chance xG ≥ 0.32, major save
        PSxG ≥ 0.35.
    *   Ring: lead-up 300 ticks, post-roll 40 ticks, extension cap 160
        ticks (500 frames).
    *   Replay speed 1.5x, replay cap 25.
    *   Countdown 5 s.
    *   Fast-forward slice 8 ms, `ffMaxTicksPerFrame: 2000`.
    *   `maxTicksPerFrame: 20`, `maxFrameSeconds: 0.1`.
    *   `commentaryDomCap: 200`.
*   **Why**: §14. Playback tuning without code changes.

##### 17. `./config/calibration/targets.yaml` (Create)

*   **Type / Scope**: Calibration targets.
*   **Proposed Changes**: per metric: `id`, `unit` (`perTeam` or
    `perMatch`), `layer` (L1–L4), `hard`, `bandA`, Scenario B values,
    `tolerance`, `toleranceAbs`, `reference {mean, p10, p90, ci90}` and
    `source`. Per team per match:

    | id | Hard | bandA (mean) | Scenario B | tolerance | toleranceAbs | Layer |
    | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
    | goals | yes | 0.9–1.9 | soft | 0.20 | 0.5 | L4 |
    | xG | yes | 0.8–2.2 | strong-side xG share ≥ 0.75 (hard); strong 2.2–3.5, weak 0.2–0.7 (soft) | 0.20 | 0.15 | L4 |
    | shots | yes | 8–18 | soft | 0.20 | 2 | L4 |
    | shotsOnTarget | yes | 3–6 | soft | 0.20 | 1 | L4 |
    | possessionPct | yes | 45–55 | strong 60–70 (hard) | 0.15 | 3 | L2 |
    | passes | yes | 350–650 | soft | 0.15 | 40 | L2 |
    | passCompletionPct | yes | 75–88 | soft | 0.15 | 3 | L2 |
    | foulsCommitted | yes | 9–15 | weak > strong (soft) | 0.20 | 2 | L4 |
    | strongWinRate | yes (B only, perMatch) | – | 0.70–0.80 | – | – | L4 |

    *   **Release gate** (the one term used everywhere else): the 8
        Scenario A hard metrics above, plus the 3 Scenario B hard checks
        (strong-side possession 60–70%, strong-side xG share ≥ 0.75,
        `strongWinRate` 0.70–0.80).
    *   Scenario B formulas: xG share is the per-match mean of
        `xgStrong / (xgStrong + xgWeak)`; a draw counts as not won.
    *   `passesCompleted` is an extra counter used by the derived metrics.

    *   In Scenario A, mean possession is 50% by symmetry; its p10 and p90
        carry the information.
    *   Soft ids: `bigChances, woodwork, shotsInBoxPct, finalThirdPassPct,
        progressivePasses, crosses, crossCompletionPct, tackles,
        tackleWinPct, interceptions, clearances, aerialDuels,
        aerialWinPct, recoveries, yellows, reds, corners, offsides, gkSaves,
        distanceKm, sprints, timeOnBallPct, ppda, fieldTiltPct, psxgTotal`.
    *   The `reference` fields are written by `scripts/build-reference.mjs`
        with `source: statsbomb-2015-16-top5` (Scenario A, all team rows) or
        `source: statsbomb-2015-16-top5-top4-vs-bottom4` (Scenario B
        `strong` and `weak`), plus the extractor version and row count.
    *   If `build-reference.mjs` warns that a reference mean lies outside
        `bandA` (item 26a), the author corrects that band before
        calibration starts. Bands do not change during tuning.
*   **Why**: G3; targets are kept apart from weights, so tuning weights
    cannot change the targets they are measured against.

##### 18. `./config/calibration/scenarios.yaml` (Create)

*   **Type / Scope**: Squad generation settings.
*   **Proposed Changes**:
    *   Scenario A, B-strong and B-weak attribute distributions (mean and
        sd for primary and secondary, as in §18), with a `frozen: true`
        flag and a `source` note.
    *   Default formation per side.
    *   Seed range.
*   **Why**: §18.

##### 19. `./config/commentary/pt-PT.yaml` (Create)

*   **Type / Scope**: Commentary templates.
*   **Proposed Changes**: for every event type, at least its
    `minVariations` template variations (item 14). Uses the token namespace
    from §16, including `{team.artDef}`, `{team.contractionDe}` and
    `{player.g:…|…}`. Build steps 1–7 use stubs with one template per type.
*   **Why**: G7.

##### 20. `./config/commentary/en-GB.yaml` (Create)

*   **Type / Scope**: Commentary templates.
*   **Proposed Changes**: the same keys and the same number of variations
    per type as pt-PT, using British football terms.
*   **Why**: G7.

##### 21. `./config/ui-strings/pt-PT.yaml` and `./config/ui-strings/en-GB.yaml` (Create)

*   **Type / Scope**: UI labels.
*   **Proposed Changes**: button, panel, prompt and error-code texts. That
    includes one message per `applyCommand` error code.
*   **Why**: keeps all user-visible text translatable.

##### 22. `./config/squads/sample-home.yaml` and `./config/squads/sample-away.yaml` (Create)

*   **Type / Scope**: Sample `MatchInput` data.
*   **Proposed Changes**:
    *   Team `id`, `name`, `gender`, and article tokens (`artDef`,
        `contractionDe`, `contractionEm`).
    *   `controlledBy: human | ai`.
    *   Formation.
    *   18 players: `players[0..10]` are starters with the goalkeeper at
        `players[0]`, `players[11..17]` the bench. Each player has `id`,
        `name`, `number`, `gender`, `role` and all 33 attributes from
        item 28.
*   **Why**: a playable default match for the app.

##### 23. `./config/schema/*.schema.json` (Create)

*   **Type / Scope**: JSON Schemas (draft 2020-12, with
    `"$schema": "https://json-schema.org/draft/2020-12/schema"`).
*   **Proposed Changes**: these exact files in `config/schema/`:
    `weights.schema.json`, `roles.schema.json`, `tactics.schema.json`,
    `injuries.schema.json`, `officiating.schema.json`,
    `ai_coach.schema.json`, `events.schema.json`, `xg.schema.json`,
    `playback.schema.json`, `targets.schema.json`, `scenarios.schema.json`,
    `commentary.schema.json` (both locales), `ui-strings.schema.json`
    (both locales), `squad.schema.json`.
    *   Record objects use `additionalProperties: false`.
    *   Map-shaped objects (keyed by event type or string key) use
        `propertyNames: {pattern: "^[A-Z_]+$"}` (or the key pattern for
        that map) plus `additionalProperties: <value schema>`.
*   **Why**: misspelled keys fail the build (CUJ 4).

#### Scripts

##### 24. `./scripts/build-config.mjs` (Create)

*   **Type / Scope**: Build tool (Node).
*   **Proposed Changes**:
    1.  Parse every YAML file with `parseDocument(src, {lineCounter,
        prettyErrors: true})` from `yaml`, and validate it with
        `new Ajv2020({allErrors: true, strict: true})` (from
        `ajv/dist/2020.js`).
    2.  Cross-check: every event type has templates in every locale; every
        template token, parsed with `Template.compile` (item 58), exists on
        its event type; every role a formation
        uses exists; every hard metric is defined. With `--strict-i18n`
        (on from build step 8), also check `minVariations` and equal
        variation counts across locales.
    3.  Emit `generated/config.js` (frozen object, with the event registry
        at `config.events`, plus `configHash`) and `generated/events.js`
        (type constants and metadata for non-engine code).
    4.  `configHash` is `sha256Hex(canonicalJson(config))` from
        `src/shared/canonicalJson.js` (item 26c); `configHash8` is its first
        8 hex characters.
    5.  On error, print file, line and column: turn Ajv's `instancePath`
        into a path array, resolve it with `doc.getIn(path, true)`, and map
        the node's `range[0]` through `lineCounter.linePos`. For
        `additionalProperties` errors, use the key node of the `Pair`
        named in `params.additionalProperty`. Exit non-zero.
    6.  Options `--config-dir <dir>` and `--out-dir <dir>` (defaults
        `config/` and `generated/`) for test fixtures. Schemas are always
        read from the repository's `config/schema/`.
    7.  Also emits `generated/squads/*.js` (ES modules, so Node needs no
        JSON import attributes) and `generated/golden.js` (a copy of
        `tests/golden/seeds.json` hashes for `#bench`, so test files stay
        out of the app bundle).
*   **Why**: §17, G8.

##### 25. `./scripts/repro.mjs` (Create)

*   **Type / Scope**: Debug tool (Node).
*   **Proposed Changes**: loads a repro record (§20) and checks that its
    `engineVersion` matches and its embedded config hashes to
    `configHash`. It calls `MatchEngine.replay(input, config, log, tick,
    {debug: true})` and compares `stateHash`. With `--tick N` it replays to
    tick N instead and writes `serialize()` at that tick as JSON. On an
    `engineVersion` mismatch it exits non-zero and prints the recorded
    version; check out the matching engine commit and rerun. Config
    differences need no checkout, because the config is embedded.
*   **Why**: CUJ 3.

##### 26. `./scripts/fit-xg.mjs` (Create)

*   **Type / Scope**: Offline fitting tool (Node).
*   **Proposed Changes**: uses `scripts/lib/statsbomb.mjs` (item 26b) to
    read shots from the 2015/16 allow-list, fits logistic coefficients by
    batch gradient descent (learning rate 0.05, 5,000 iterations, L2 0.001,
    standardised features), converts the coefficients back to raw feature
    scale, and prints YAML for `config/xg.yaml`. Penalties
    are excluded from the fit. It may use `Math.exp` (it is outside the
    engine); the engine evaluates the same formula with `fastExp`, whose
    maximum error is fixed in item 36 and tested by item 78. Not run by
    any build step.
*   **Why**: makes the xG model reproducible and independent of the engine
    (Alternative K).

##### 26a. `./scripts/build-reference.mjs` (Create)

*   **Type / Scope**: Offline reference extractor (Node).
*   **Proposed Changes**:
    *   Uses `scripts/lib/statsbomb.mjs` for the same allow-list, and
        imports `xg` from `src/engine/xg/ShotModels.js` with
        `config/xg.yaml`, so reference xG and engine xG are one
        implementation.
    *   For each team in each match computes the 8 hard metrics with these
        definitions:
        *   goals: shots with outcome `Goal`, plus `Own Goal For` events;
            period 5 (shoot-outs) excluded
        *   xG: `xg()` over each shot's features
        *   shots: all `Shot` events, including blocked
        *   shots on target: outcomes `Goal`, `Saved`, `Saved to Post`
            (`Saved Off Target` counts as off target)
        *   possession %: open-play pass share. An open-play pass is an
            event with `type.name === 'Pass'` whose `pass.type?.name` is not
            Corner, Free Kick, Goal Kick, Kick Off or Throw-in. Crosses,
            keeper distribution and passes typed Recovery or Interception
            are included, matching the engine's `PASS` rule (§13).
        *   passes: open-play passes attempted
        *   pass completion %: passes with no `pass.outcome` over passes
            attempted
        *   fouls committed: `Foul Committed` events
    *   Final 2015/16 standings come from `home_score`/`away_score` in
        `matches/`, with 3/1/0 points, then goal difference, then goals
        for. The Scenario B subset is every top-4 vs bottom-4 match
        in the same league. It also yields strong-side possession, xG share
        and win rate.
    *   Computes mean, p10 and p90 over all team rows (Scenario A) and over
        the subset split into `strong` and `weak` (Scenario B), plus a
        bootstrap 90% interval for every percentile (2,000 resamples,
        `sfc32` seeded with 1), reported for information. Percentiles use
        `src/shared/stats.js` (item 26d).
    *   Warns when a reference mean falls outside `bandA` for the same
        metric. That puts the band and the reference in conflict, so the
        author corrects the band before calibration starts.
    *   Writes only the `reference` fields of
        `config/calibration/targets.yaml`, using `parseDocument` and
        `doc.setIn(...)`, so comments and formatting survive.
    *   Prints row counts per competition so a missing download is
        visible. Not run by any build step (`npm run reference`).
*   **Why**: G3. Reference percentiles are reproducible from public data,
    and possession and xG share one definition with the engine.

##### 26b. `./scripts/lib/statsbomb.mjs` (Create)

*   **Type / Scope**: Shared StatsBomb reader (Node).
*   **Proposed Changes**:
    *   Layout: `data/competitions.json` → `data/matches/{competition_id}/{season_id}.json`
        → `data/events/{match_id}.json`. Event files carry no competition
        or season id, so filtering goes through `matches/`.
    *   Allow-list: 2015/16 (`season_id` 27) with Premier League 2, La
        Liga 11, Serie A 12, Bundesliga 9, Ligue 1 7. The script checks
        each pair exists in `competitions.json` and prints the names it
        found.
    *   Coordinates: StatsBomb uses a 120 × 80-yard pitch, oriented so the
        acting team attacks toward x = 120. Shot features are computed in
        metres relative to the goal centre (120, 40), at 0.9144 m per yard,
        not by scaling to 105 × 68 (which would shrink the goal).
    *   Features, defined once here and in item 50 with the same formulas:
        *   `distance`: metres from the shot location to the goal centre
        *   `angle`: the angle in radians subtended by the two posts,
            computed with `detmath.fastAtan2`
        *   `isHeader`: `shot.body_part` is Head
        *   `defendersInCone`: opponents (`teammate: false`) in
            `shot.freeze_frame` inside the triangle from the ball to both
            posts, keeper excluded
        *   `assistType` ∈ {`none`, `cross`, `through`, `cutback`,
            `setPiece`}. From StatsBomb's key pass: `pass.cross` → cross,
            `pass.through_ball` → through, `pass.cut_back` → cutback,
            a set-piece `pass.type` → setPiece, otherwise none. From the
            engine: `PASS` kind `CROSS` → cross, `THROUGH` → through, a
            restart → setPiece, otherwise none (v1 has no cutback).
    *   Covered by `tests/scripts/statsbomb.test.js` (item 82c).
*   **Why**: one reader for items 26 and 26a, so both use the same
    filtering and geometry.

##### 26c. `./src/shared/canonicalJson.js` (Create)

*   **Type / Scope**: Shared helper (Node and browser).
*   **Proposed Changes**: `canonicalJson(value)` stringifies with object
    keys sorted recursively. `sha256Hex(string)` uses `node:crypto`
    `createHash` in Node and `crypto.subtle.digest('SHA-256', …)` in the
    browser (async). Imported by `build-config.mjs`, `repro.mjs` and
    `Persistence`.
*   **Why**: the browser's config-hash check must produce the same bytes
    as the build.

##### 26d. `./src/shared/stats.js` (Create)

*   **Type / Scope**: Shared helper.
*   **Proposed Changes**: `mean`, and `percentile(sorted, p)` by linear
    interpolation between closest ranks (Hyndman–Fan type 7, the default
    in R and NumPy). Used by `report.js` and `build-reference.mjs`.
*   **Why**: the engine's percentiles and the reference percentiles use the
    same method.

#### Engine (`src/engine/`, pure, deterministic)

##### 27. `./src/engine/MatchEngine.js` (Create)

*   **Type / Scope**: Engine facade.
*   **Proposed Changes**: class `MatchEngine`. This is the canonical method
    list (G2 refers here).
    *   `static create(matchInput, config, {debug = false} = {})` and
        `static fromState(serialized, matchInput, config, {debug = false} = {})`.
        `create` builds the frozen per-tick view of the config (§3).
    *   `step(n)` returns `{ticksRun, events, stoppedFor: null |
        'FORCED_DECISION' | 'HALF_TIME' | 'FULL_TIME'}`. `events` is a new
        array on every call.
    *   `applyCommand(cmd)` returns `{ok, code}` (§12).
    *   `getSnapshot(out)` fills a caller-owned `Float64Array` of length
        `SNAP_LEN`, with this layout (offsets exported as constants):

        | Offset | Fields |
        | :-- | :-- |
        | 0–5 | `tick`, `scoreHome`, `scoreAway`, `clockSeconds`, `half`, `flags` (bit 0 `awaitingDecision`, bit 1 `deadBall`, bit 2 `fullTime`) |
        | 6–10 | ball: `prevX`, `prevY`, `x`, `y`, `height` |
        | 11 + 10·i | player `i` (0–35): `prevX`, `prevY`, `x`, `y`, `onPitch`, `team`, `card` (0 none, 1 yellow, 2 red), `injury` (0–3), `isKeeper`, `fitness` |

        `SNAP_LEN = 11 + 10 × 36 = 371`.
    *   `getStats()` (callers call it at most once per frame),
        `getResult()`, `serialize()`, `hash()`, `getCommandLog()`.
    *   `static replay(input, config, log, toTick, opts)` returns
        `{engine, events}`. It creates the engine, then loops: before
        stepping tick `t + 1`, it applies the log's `issuer: 'human'`
        entries stamped `t`, in `seq` order. When `step()` stops for
        `FORCED_DECISION`, it applies that tick's pending human entries and
        continues; `HALF_TIME` continues automatically. It stops at
        `toTick`. Used by resume, repro and tests.
    *   Build-step stub contract: subsystems not yet built (build order)
        are modules that export the same functions as no-ops, so
        `MatchEngine` runs its full tick order from step 2 on.
    *   It runs the fixed per-tick order from §3. It owns the subsystems
        below and passes them `MatchState`.
    *   `ENGINE_VERSION` constant.
*   **Why**: G2. Together with the `MatchInput` and `MatchResult`
    contracts (items 28–29), this is the whole engine surface callers use.

##### 28. `./src/engine/contracts/MatchInput.js` (Create)

*   **Type / Scope**: Contract and validation.
*   **Proposed Changes**: JSDoc typedef for `MatchInput {v: 1, seed,
    configHash, home, away}`, where each team is
    `{id, name, gender, artDef, contractionDe, contractionEm, controlledBy:
    'human' | 'ai', formationId, players[18]}`. `players[0..10]` are the
    starters with the goalkeeper at `players[0]`; `players[11..17]` are the
    bench. Each player is `{id, name, number, gender, role, attributes}`,
    with every attribute an integer 1–20:

    | Group | Attributes |
    | :-- | :-- |
    | Physical | pace, acceleration, stamina, strength, jumpingReach, agility, balance |
    | Technical | passing, crossing, dribbling, finishing, firstTouch, technique, tackling, marking, kicking, throwing |
    | Mental | decisions, positioning, composure, concentration, bravery, teamwork, workRate, vision, aggression, offTheBall, flair, determination |
    | Goalkeeping | reflexes, oneOnOnes, aerialReach, commandOfArea |

    v1 has no height field. Fitness slopes and injury multipliers apply by
    group (goalkeeping counts as physical). `validateMatchInput(input,
    config)` returns a list of errors: 18 players, `players[0]` is a GK,
    unique ids and numbers, all 33 attributes present and 1–20, known
    roles, valid `controlledBy`.
*   **Why**: G2; the career layer's entry point.

##### 29. `./src/engine/contracts/MatchResult.js` (Create)

*   **Type / Scope**: Contract.
*   **Proposed Changes**: JSDoc typedef and `buildMatchResult(state)`
    producing the fields listed in §12.
*   **Why**: G2; the career layer's exit point.

##### 30. `./src/engine/state/MatchState.js` (Create)

*   **Type / Scope**: Engine state.
*   **Proposed Changes**:
    *   Creates 36 `PlayerMatchState` objects (permanent indices, §3), the
        ball, and the scalar state from §4, once at engine creation.
    *   Keeps the ascending on-pitch index list.
    *   `serialize()` writes a plain object with `stateVersion`, fields in
        this fixed order: `stateVersion`, `tick`, `rng`, `clock`, `restart`,
        `ball`, `teams`, `players` (by index), `pendingSubs`, `stats`,
        `eventSeq`, `commandSeq`, `awaitingDecision`; `-0` normalised to `+0`, and throws on `NaN` or
        `Infinity`. `static restore(data)` reads it back.
    *   `hash()` runs FNV-1a over the canonical bytes of `serialize()`.
    *   `substitute(outIndex, inIndex)` flips the two `onPitch` flags,
        moves the formation slot, and updates the on-pitch list. A sent-off
        player's `onPitch` stays 0 and they never return.
*   **Why**: §4. All state restorable from one serialized object.

##### 31. `./src/engine/state/PlayerMatchState.js` (Create)

*   **Type / Scope**: Per-player state.
*   **Proposed Changes**:
    *   class `PlayerMatchState` with the per-player fields from §4 as
        plain properties, created once per player.
    *   `getEffectiveAttribute(player, attr)` (a module function) = base ×
        fitness factor × injury factor, clamped 1–20 (§6, §9a).
    *   `roleRating(player, roles)`.
*   **Why**: §6.

##### 32. `./src/engine/state/TeamState.js` and `./src/engine/state/BallState.js` (Create)

*   **Type / Scope**: State classes.
*   **Proposed Changes**:
    *   `TeamState`: score, side, current formation, reduced-shape flag,
        `controlledBy`, substitutions used, pending queue, forced-decision
        flag, AI rules already fired.
    *   `BallState`: position, velocity, owner, flight descriptor, and
        `heightAt(tick)`.
*   **Why**: isolates team and ball fields so `serialize()` writes them in a
    fixed order.

##### 33. `./src/engine/stats/MatchStats.js` (Create)

*   **Type / Scope**: Statistics.
*   **Proposed Changes**:
    *   `onEvent(event)` updates per-team counters for every metric in
        `targets.yaml`, using the stat entries in the event registry.
    *   Possession % is derived from `PASS` events (pass share).
        `onTick(state)` only updates the soft `timeOnBallPct` counter.
    *   `toJSON()` adds distance and sprints from player state.
    *   Secondary metrics: PPDA, field tilt, PSxG total (definitions in
        §13).
*   **Why**: §13. Every metric in `targets.yaml` comes only from events, so
    calibration can recompute it; `timeOnBallPct`, distance and sprints
    are soft extras read from state.

##### 34. `./src/engine/events/MatchEvent.js` (Create)

*   **Type / Scope**: Event factory.
*   **Proposed Changes**: `makeEvent(state, type, fields)` assigns `v`,
    `seq` and `tick`, and computes `zone` from x, y and the attacking
    side (§2). When the engine was created with `{debug: true}` it
    validates against `config.events`.
*   **Why**: §13. One place that builds events.

##### 35. `./src/engine/rng/sfc32.js` and `./src/engine/rng/streams.js` (Create)

*   **Type / Scope**: Random numbers.
*   **Proposed Changes**:
    *   `sfc32` works on any 4-word `Uint32Array` (the engine's lives in
        `MatchState`; commentary, squadgen and the bootstrap use their own).
        It provides `nextUint32`, `nextFloat` (top 24 bits × 2^−24),
        `range(lo, hi)` = `lo + floor(nextFloat() · (hi − lo))` (excludes
        `hi`), and `chance(p)` = `nextFloat() < p`.
    *   `splitmix32` is used for seeding.
    *   `streams.js` exports `seedSfc32(out, seed)`, which fills the four
        words from a `splitmix32` chain seeded with `seed` and then
        discards the first 16 sfc32 outputs, and `commentarySeed(matchSeed, seq)` =
        `matchSeed ^ Math.imul(seq + 1, 0x9E3779B9)`.
*   **Why**: §5; Alternative E.

##### 36. `./src/engine/math/detmath.js` (Create)

*   **Type / Scope**: Deterministic math.
*   **Proposed Changes**:
    *   `fastAtan2`: polynomial with octant handling.
    *   `fastExp`: range reduction by powers of 2 plus a polynomial.
    *   `sigmoid(z) = 1 / (1 + fastExp(−z))`.
    *   `PI` constant.
    *   Error targets, tested by item 78: `fastExp` relative error ≤ 1e-6
        on [−20, 20], with inputs clamped to that range (so `sigmoid` never
        overflows); `fastAtan2` absolute error ≤ 1e-5 rad.
    *   All use only `+ - * /` and the `Math` members allowed in §5.
*   **Why**: §5; Alternative F.

##### 37. `./src/engine/math/geom.js` (Create)

*   **Type / Scope**: Geometry helpers.
*   **Proposed Changes**: write-into-output functions with no allocation:
    *   `closestPointOnSegment`
    *   `distSqPointSegment`
    *   `normalize`
    *   `angleToPosts` (computed from vectors via `fastAtan2`)
    *   `inCone`
*   **Why**: swept checks and xG features.

##### 38. `./src/engine/math/hash.js` (Create)

*   **Type / Scope**: Hashing.
*   **Proposed Changes**: FNV-1a 32-bit over the tagged byte encoding in
    §4 (tags 0–6; numbers as float64 little-endian after `-0` → `+0`;
    strings as uint32 length plus UTF-8).
*   **Why**: state hash for determinism tests and repro bundles.

##### 39. `./src/engine/tactics/Formation.js` (Create)

*   **Type / Scope**: Tactics.
*   **Proposed Changes**:
    *   `setFormation(team, id)` assigns slots to on-pitch players by role
        fit, with ties broken by index.
    *   `reduce(team)` picks the reduced variant.
    *   `computeAnchors(state, team)` fills the target-anchor arrays from
        ball position, phase and follow coefficients.
*   **Why**: §7.

##### 40. `./src/engine/movement/Movement.js` (Create)

*   **Type / Scope**: Movement.
*   **Proposed Changes**: `updateMovement(state, dt)` steers every on-pitch
    player toward their target. Top speed and acceleration come from
    effective Pace and Acceleration. It updates prev/current position,
    velocity, distance and sprint state, using the §9b movement rules.
    Fitness drain belongs to item 47 (tick step 7).
*   **Why**: §6–7.

##### 41. `./src/engine/ball/BallPhysics.js` (Create)

*   **Type / Scope**: Ball.
*   **Proposed Changes**:
    *   `launchGround(...)` and `launchLofted(...)` set the flight
        descriptor.
    *   `updateBall(state, dt)` applies rolling resistance and lofted
        flight, and detects out of play and goal-line crossing.
    *   `sweptContests(state, out)` lists players who may contest the
        ball this tick, with contact point and `heightAt`.
*   **Why**: §8.

##### 42. `./src/engine/decisions/CarrierDecision.js` and `OffBallDecision.js` (Create)

*   **Type / Scope**: AI decisions.
*   **Proposed Changes**:
    *   Carrier: on the staggered schedule or an interrupt, score pass
        candidates (each team-mate × pass type), dribble directions,
        shot, cross and hold, using the features and noise in §9a, and
        choose.
    *   Off-ball: the press / intercept / mark / hold rules in §9a for
        defenders, and support runs for attackers.
    *   No allocation: candidates go into a preallocated scratch array.
*   **Why**: §9.

##### 43. `./src/engine/resolve/passing.js`, `duels.js`, `shooting.js` (Create)

*   **Type / Scope**: Pure resolution functions.
*   **Proposed Changes**:
    *   `passing.js`: `passOutcome` and `firstTouch`.
    *   `duels.js`: `dribbleOutcome`, `tackleOutcome` and `aerialDuel`.
    *   `shooting.js`: `shotPlacement` and `saveOutcome`.

    Each implements the formula in §9a with the signature and output
    fields listed in §9 (for example `passOutcome(dist, laneThreat,
    receiverPressure, passing, technique, k, u, out)` writes
    `out.pComplete`, `out.errM`). It takes numbers, a coefficient object
    `k` and a uniform draw `u`, and writes into the caller-owned `out`.
*   **Why**: §9; unit-testable and tunable on their own.

##### 44. `./src/engine/officiating/Referee.js` (Create)

*   **Type / Scope**: Officiating.
*   **Proposed Changes**: `judgeContact(ctx)`, `judgeOffside(passCtx)` and
    `computeAddedTime(state)` as plain functions. They use `engineRng`.
    They issue cards with the §9b card and severity rules and turn a second
    yellow into a red. They apply advantage and choose direct or indirect
    free kicks as in §9b. Offside follows §10: intended receiver only,
    strictly ahead, no offside from a throw-in, goal kick or corner.
*   **Why**: §10.

##### 45. `./src/engine/restarts/RestartMachine.js` (Create)

*   **Type / Scope**: Restarts.
*   **Proposed Changes**:
    *   Owns the `IN_PLAY` / `DEAD_BALL` / `HALF_TIME` / `FULL_TIME`
        states, the restart kind, the taker (§9b rules), the
        `setPieceSeconds` hold, kick-off side, and set-piece
        repositioning.
    *   On entering `DEAD_BALL`, it applies queued substitutions.
    *   Emits restart events.
*   **Why**: §10. This is where "substitutions at the next dead ball" is
    enforced.

##### 46. `./src/engine/clock/MatchClock.js` (Create)

*   **Type / Scope**: Clock.
*   **Proposed Changes**: tracks the tick and the match minute, and keeps
    the added-time accumulator. It announces added time at 45:00 and 90:00
    and ends each half.
*   **Why**: §10.

##### 47. `./src/engine/fitness/Fitness.js` and `./src/engine/injuries/Injuries.js` (Create)

*   **Type / Scope**: Status.
*   **Proposed Changes**:
    *   Fitness: the only owner of fitness drain and recovery, at tick
        step 7, by speed band with Stamina and Work Rate scaling (§9a).
    *   Injuries: roll on contact events and high fatigue using
        `engineRng` (contact events and fatigue rule in §9b), apply the
        level, emit events, and for level `HIGH` set `awaitingDecision`,
        unless the team has no substitutes left (§12).
*   **Why**: §6, §11.

##### 48. `./src/engine/commands/Commands.js` (Create)

*   **Type / Scope**: Commands.
*   **Proposed Changes**:
    *   `applyCommand` validates in the order and with the conditions in
        the §12 table.
    *   It assigns `seq` and stamps `tick` (the last completed tick); the
        command takes effect at step 1 of the next tick.
    *   `SET_FORMATION` applies on the next tick; `SUBSTITUTE` is queued to
        the next dead ball; `RESOLVE_FORCED {inIndex | null, outIndex |
        null}` applies on the next tick and counts toward the 5.
    *   Accepted commands, human and AI, go into the engine-owned command
        log. Only human entries are re-applied by `MatchEngine.replay`
        (item 27).
*   **Why**: §12.

##### 49. `./src/engine/ai/AiCoach.js` (Create)

*   **Type / Scope**: Opponent AI.
*   **Proposed Changes**: `evaluate(state, team)` runs when
    `tick % evalIntervalTicks === 0` (20, from `ai_coach.yaml`) for each
    team with `controlledBy: 'ai'`, and applies the rules. Forced
    decisions are resolved immediately at tick step 7, outside the interval
    (§12). It resolves forced decisions for its
    team on the same tick, and issues commands with `issuer: 'ai'`.
*   **Why**: §12, G5.

##### 50. `./src/engine/xg/ShotModels.js` (Create)

*   **Type / Scope**: Shot quality models.
*   **Proposed Changes**: `xg(features, coeffs)` (logistic via
    `sigmoid`), with `features = {distance, angle, isHeader,
    defendersInCone, assistType}` defined exactly as in item 26b, and
    `penaltyXg` for penalties; and `psxg(xg, goalY, goalZ, vShot, coeffs)`. Called when a shot event
    is built. Never used by shot resolution.
*   **Why**: §13; Alternative K.

##### 51. `./src/engine/debug/invariants.js` (Create)

*   **Type / Scope**: Debug checks.
*   **Proposed Changes**: `checkInvariants(state)` runs each tick when the
    engine was created with `{debug: true}`. It throws with tick and details if any of
    these fail:
    *   at most 11 on the pitch per side
    *   at most one ball owner
    *   positions within the pitch plus 5 m
    *   substitutions at most 5
    *   event ticks never decreasing
    *   a sent-off player never returns
*   **Why**: catches state corruption at the tick it happens.

#### Runtime (`src/runtime/`, browser)

##### 52. `./src/runtime/MatchController.js` (Create)

*   **Type / Scope**: Playback controller.
*   **Proposed Changes**:
    *   Constructor: `new MatchController({input, config, mode = 'full',
        now = () => performance.now(), schedule = requestAnimationFrame})`.
        Tests pass a fake clock and scheduler. `mode: 'debug'` (build
        step 6) runs Full Match only, with no persistence and no Best
        Moments.
    *   Keeps the full event array for the match; the ring stores index
        ranges into it.
    *   Owns the live engine, the `RenderRing` and the playback state
        machine from §14.
    *   `tickFrame(frameSeconds)` runs one loop iteration (the rAF callback
        calls it; tests call it directly): clamps `frameSeconds` to
        `maxFrameSeconds`, adds to the budget, steps at most
        `maxTicksPerFrame`, clamps the budget to at most 1, and counts
        dropped budget.
    *   Gives views `frame = {renderSnapshot, alpha, newEvents, stats,
        playbackState}`, with `alpha = clamp(budget, 0, 1)` and `stats`
        from one `getStats()` call per frame.
    *   Exposes `setSpeed`, `setMode`, `queueCommand` (rejected during
        `REPLAY`), `continue` (also resumes from `HALF_TIME`) and
        `copyRepro`.
*   **Why**: §14.

##### 53. `./src/runtime/BestMoments.js` (Create)

*   **Type / Scope**: Highlight logic.
*   **Proposed Changes**:
    *   Fast-forward: `step(1)` in a loop, checking `now()` after each
        call, until 8 ms pass or `ffMaxTicksPerFrame` ticks run.
    *   Trigger detection from registry flags and thresholds.
    *   Post-roll extension, capped at `firstTriggerTick + 160`.
    *   Cut short at a forced decision, then `PAUSED_FORCED`.
    *   Replay: plays ring frames from `triggerTick − 300` (or the first
        recorded tick) to `replayEndTick` at replay speed, releasing each
        tick's events.
    *   Countdown and the replay cap.
*   **Why**: §14, G6.

##### 54. `./src/runtime/RenderRing.js` (Create)

*   **Type / Scope**: Replay frames.
*   **Proposed Changes**: a preallocated ring of 500 `RenderSnapshot`
    frames (`SNAP_LEN` each) plus each frame's event index range.
    `push(snapshot, eventStart, eventEnd)`, `frameAt(tick)`, `oldestTick()`.
    `eventStart`/`eventEnd` index into the controller's full event array.
*   **Why**: §14; replaces the keyframe store and replay engine
    (Alternative H).

##### 54a. `./src/runtime/storage.js` (Create)

*   **Type / Scope**: Storage adapters.
*   **Proposed Changes**: `capacitorStorage` (async `get`, `set`,
    `remove` over `@capacitor/preferences`, which falls back to
    `localStorage` on the web) and `memoryStorage()` for tests. `main.js`
    constructs one and injects it into items 55 and 57.
*   **Why**: keeps `@capacitor/*` out of the Node runtime tests and
    coverage.

##### 55. `./src/runtime/Persistence.js` (Create)

*   **Type / Scope**: Lifecycle.
*   **Proposed Changes**: as in §20.
    *   Constructor `new Persistence({storage, app})`, with `storage` from
        item 54a. `app` is `@capacitor/app` or a fake event source.
    *   Saves the record on each accepted command and on `pause` /
        `visibilitychange` (hidden), skipping if `tick` is unchanged, with
        the save call started synchronously in the handler.
    *   Back button: "Leave" saves then `App.minimizeApp()`; "Stay" does
        nothing.
    *   Resume: version checks; then `sha256Hex(canonicalJson(config))`
        (item 26c) must equal the stored `configHash`; then
        `MatchEngine.replay(...)` to `tick` behind a progress callback;
        then `hash()` must equal `stateHash`; then restore the playback
        state (`PAUSED_HIGHLIGHT` resumes as `PAUSED`).
    *   Discards the record with a reason code for the UI on a
        `schemaVersion` mismatch, an `engineVersion` mismatch, an embedded
        config whose hash differs from the stored `configHash`, or a
        `stateHash` mismatch. Deletes the record at full time.
*   **Why**: §20.

##### 56. `./src/runtime/ReproBundle.js` (Create)

*   **Type / Scope**: Debug export.
*   **Proposed Changes**: `buildRepro(controller)` returns the current save
    record (§20) as JSON. `copyRepro()` calls `copyText` (item 70a). On
    desktop it also offers a Blob download through `URL.createObjectURL`
    and an `<a download>` link. The button sits in the ControlsView
    overflow menu.
*   **Why**: CUJ 3. Downloads do nothing in a Capacitor Android WebView
    without a native download handler, and `navigator.clipboard` can be
    refused there, so the native path uses `@capacitor/clipboard`.

#### i18n (`src/i18n/`)

##### 57. `./src/i18n/Locale.js` (Create)

*   **Type / Scope**: Locale state.
*   **Proposed Changes**: `pt-PT` (the default on first launch) and
    `en-GB`. `getLocale`/`setLocale` with change listeners, and `t(key, vars)` for UI strings. The last
    choice is saved through the same `storage` wrapper as item 55.
*   **Why**: G7.

##### 58. `./src/i18n/Template.js` (Create)

*   **Type / Scope**: Template rendering.
*   **Proposed Changes**: `Template.compile(src, {strict = false})`
    precompiles a template into a token list. It renders the §16 token
    namespace and the `{player.g:masc|fem}` gender choice. Unknown tokens
    render as `?`; with `strict: true` (set by tests) they throw.
*   **Why**: §16.

##### 59. `./src/i18n/Commentator.js` (Create)

*   **Type / Scope**: Commentary.
*   **Proposed Changes**: `lineFor(event, locale, ctx)` picks a variation
    with its own `sfc32`, seeded by `seedSfc32(out,
    commentarySeed(matchSeed, event.seq))` (item 35), picks variation
    `nextUint32() % count`, and renders it. It
    never touches `engineRng`.
*   **Why**: §16. Switching language never changes the match.

#### UI (`src/ui/`)

##### 60. `./src/ui/index.html` (Create)

*   **Type / Scope**: App shell.
*   **Proposed Changes**: viewport meta (`width=device-width`,
    `viewport-fit=cover`), a portrait container, and one mount point per
    view. Loads `main.js` as a module.
*   **Why**: §15.

##### 61. `./src/ui/main.js` (Create)

*   **Type / Scope**: Bootstrap.
*   **Proposed Changes**:
    *   Loads `#generated/config.js` and the sample squads.
    *   Checks `Persistence` for a saved match.
    *   Creates `MatchController` and mounts the views.
    *   The match seed comes from `crypto.getRandomValues`;
        `MatchInput.configHash` is the compiled `configHash`.
    *   Imports the stylesheets from item 70.
    *   Hash routing: `#bench` mounts `BenchView`; `#seed=<n>&scenario=<A|B>`
        builds both squads with `src/shared/squadgen.js` (home seed
        `n ^ 0xA5A5A5A5`, away seed `n ^ 0x5A5A5A5A`) and opens the
        controller in `mode: 'debug'`.
*   **Why**: the single place that wires config, storage, controller and
    views together.

##### 62. `./src/ui/views/View.js` and `./src/ui/views/Drawer.js` (Create)

*   **Type / Scope**: UI base.
*   **Proposed Changes**:
    *   `View`: `mount(root)` injects the partial, `update(frame)` (the
        item 52 frame object), `destroy()`.
    *   `Drawer`: bottom-sheet open/close with touch drag, used by Stats
        and Manager.
*   **Why**: gives every view the same `mount`/`update`/`destroy`
    interface.

##### 63. `./src/ui/views/ScoreboardView.js` + `./src/ui/partials/scoreboard.html` (Create)

*   **Type / Scope**: View.
*   **Proposed Changes**: team names, score, clock, half, added-time badge,
    PT/EN toggle.
*   **Why**: §15.

##### 64. `./src/ui/views/PitchCanvasView.js` + `./src/ui/partials/pitch.html` (Create)

*   **Type / Scope**: View.
*   **Proposed Changes**:
    *   Canvas sized by `devicePixelRatio`; static pitch drawn to an
        offscreen canvas.
    *   Engine x/y rotated to portrait.
    *   Positions interpolated with `alpha`.
    *   Player dots with numbers, fitness rings, and badges for yellow,
        red, injury level and stand-in keeper.
    *   The ball drawn larger when its height is above 1 m.
    *   During fast-forward, draws only the score, clock and the ball's
        zone; player dots are not drawn.
*   **Why**: §15.

##### 65. `./src/ui/views/ControlsView.js` + `./src/ui/partials/controls.html` (Create)

*   **Type / Scope**: View.
*   **Proposed Changes**: a touch slider 0–60x with snap points at 0, 1, 2,
    5, 10, 30 and 60. Full Match / Best Moments toggle. A Continue button
    and countdown in `PAUSED_HIGHLIGHT`.
*   **Why**: §14–15.

##### 66. `./src/ui/views/CommentaryView.js` + `./src/ui/partials/commentary.html` (Create)

*   **Type / Scope**: View.
*   **Proposed Changes**: a scrolling feed, newest first. It re-renders the
    whole feed on locale change, and caps the DOM at the last
    `commentaryDomCap` (200) lines while keeping all events in memory.
*   **Why**: §15–16.

##### 67. `./src/ui/views/StatsView.js` + `./src/ui/partials/stats.html` (Create)

*   **Type / Scope**: View.
*   **Proposed Changes**: comparison bars for possession, shots, shots on
    target, xG, passes, completion, fouls, cards, corners and distance.
    Opens as a drawer.
*   **Why**: §15.

##### 68. `./src/ui/views/ManagerView.js` + `./src/ui/partials/manager.html` (Create)

*   **Type / Scope**: View.
*   **Proposed Changes**:
    *   Formation buttons.
    *   On-pitch list with fitness and badges; bench list.
    *   Tap-out then tap-in to queue a substitution; pending list with
        cancel.
    *   Substitutions remaining.
    *   A forced-decision prompt that the user cannot dismiss.
    *   Error-code messages via `t()`, one per code in §12.
    *   Disabled while the playback state is `REPLAY`.
*   **Why**: §15, G5.

##### 68a. `./src/ui/views/DialogView.js` + `./src/ui/partials/dialog.html` + `./src/ui/styles/dialog.css` (Create)

*   **Type / Scope**: View.
*   **Proposed Changes**: modal dialogs, each with text from `t()`:
    *   "Resume match?" (Resume / Discard)
    *   a re-simulation progress overlay
    *   the discard reason
    *   "Leave match?" (Leave / Stay)
    *   half-time (Continue)
    *   full-time result
    *   the repro JSON in a selectable `<textarea>` when the clipboard
        copy fails
*   **Why**: §14, §20; every lifecycle flow needs a screen.

##### 69. `./src/ui/views/BenchView.js` + `./src/ui/partials/bench.html` (Create)

*   **Type / Scope**: View.
*   **Proposed Changes**: runs a full match at 20 ticks per frame plus
    drawing. It shows:
    *   mean and p95 ms of engine work per 20 ticks, and of drawing
    *   pass/fail: p95 engine ms < 2.0, p95 frame time ≤ 16.7 ms,
        full-match re-simulation < 12 s, and golden hash equal to
        `generated/golden.js`
    *   full-match re-simulation time (the resume cost)
    *   dropped tick budget
    Results can be copied with `copyText` (item 70a) as JSON, to measure the
    phone/Node slowdown factor (Open Questions).
*   **Why**: G4.

##### 70. `./src/ui/styles/base.css` plus one sheet per view (Create)

*   **Type / Scope**: Styles.
*   **Proposed Changes**:
    *   `base.css`: CSS variables, portrait container with safe-area
        insets, 9:16 to 9:19.5 layout, touch targets of at least 44 px.
    *   `src/ui/styles/scoreboard.css`, `src/ui/styles/pitch.css`,
        `src/ui/styles/controls.css`, `src/ui/styles/commentary.css`,
        `src/ui/styles/stats.css`, `src/ui/styles/manager.css`,
        `src/ui/styles/bench.css`.
*   **Why**: §15.

#### Calibration and benchmarks (`src/calibration/`, Node only)

##### 70a. `./src/ui/copyText.js` (Create)

*   **Type / Scope**: UI helper.
*   **Proposed Changes**: `copyText(text)`: on native, `Clipboard.write({
    string: text})` from `@capacitor/clipboard`; on the web,
    `navigator.clipboard.writeText`. On any failure it opens the
    DialogView `<textarea>` fallback.
*   **Why**: one clipboard path for the repro record and `#bench`.

##### 71. `./src/shared/squadgen.js` (Create)

*   **Type / Scope**: Squad generator.
*   **Proposed Changes**: `generateSquad(scenarioSide, seed, config)`
    returns a valid `MatchInput` team. Attributes are drawn from the frozen
    normal distributions in `scenarios.yaml` using `sfc32` (item 35) and an
    Irwin–Hall approximation (`z = sum of 12 nextFloat() − 6`, only `+` and
    `-`), clamped 1–20 and rounded, so squads are byte-identical across
    Node versions. It uses no Node or DOM globals, because both the
    calibration runner and the `#seed` debug route use it. Seeds are as in
    item 61.
*   **Why**: §18.

##### 72. `./src/calibration/run.js` and `./src/calibration/worker.js` (Create)

*   **Type / Scope**: Calibration runner.
*   **Proposed Changes**:
    *   `run.js` parses flags and splits the seed range across a
        `worker_threads` pool of `os.availableParallelism()` workers, each
        created with `new Worker(new URL('./worker.js', import.meta.url))`.
    *   It merges per-match metric rows, calls `report.js`, and sets the
        exit code.
    *   `worker.js` plays assigned matches headless (both teams under the
        AI coach) and returns metric rows.
*   **Why**: §18, CUJ 4.

##### 73. `./src/calibration/metrics.js` and `./src/calibration/report.js` (Create)

*   **Type / Scope**: Metrics and reporting.
*   **Proposed Changes**:
    *   `metrics.js` is the only module with metric formulas (every id in
        `targets.yaml`, the derived percentages, and the soft extras).
        `MatchStats` (item 33) calls it, so the engine and calibration share
        one implementation.
    *   `report.js` computes mean, p10 and p90, and applies the hard checks
        from §18: Scenario A mean in band plus p10/p90 within
        `max(tolerance × |ref|, toleranceAbs)`; Scenario B strong-side
        possession, xG share and win rate.
    *   It writes `reports/calibration-<YYYY-MM-DD>-<configHash8>.json` and
        `.md`, grouped by layers L1–L4, with the 3 worst seeds per failing
        metric.
*   **Why**: G3.

##### 74. `./src/calibration/bench.js` (Create)

*   **Type / Scope**: Node benchmark.
*   **Proposed Changes**: runs 20 matches and reports the mean engine ms
    per 20-tick window across all 20 matches, and the mean time to
    re-simulate a full match. It exits non-zero only when the mean is above
    1.0 ms per 20 ticks.
*   **Why**: G4. The 1.0 ms CI ceiling is about 3× the 0.33 ms estimate
    and fails only on large regressions; the on-device `#bench`
    thresholds (item 69) are the release gate.

#### Tests

##### 75. `./tests/engine/determinism.test.js` + `./tests/golden/seeds.json` (Create)

*   **Type / Scope**: Golden test.
*   **Proposed Changes**: `seeds.json` holds 5 seeds (1, 2, 3, 42,
    20260101), the two sample squads, and a fixed human command log,
    empty until build step 4: at 60', home sub out 9 → in 12 and away sub
    out 27 → in 30; at 70', home `SET_FORMATION 4-4-2`. Both teams are
    `controlledBy: 'human'` so only this log acts. The test checks the
    hash every 1,000 ticks and the final hash. `UPDATE_GOLDEN=1 npm test`
    rewrites the file; regenerate it at the end of each build step that
    changes engine behaviour. This is the one place the rule is stated.
*   **Why**: G1.

##### 76. `./tests/engine/serialize.test.js` (Create)

*   **Type / Scope**: Restore and re-simulation test.
*   **Proposed Changes**:
    *   Run to T1, `serialize()`, round-trip through
        `JSON.parse(JSON.stringify(s))`, restore, run to T2. The hash must
        equal an uninterrupted run. Repeated at a dead ball, during a
        lofted pass, with a pending substitution, and with a velocity
        component of `-0`.
    *   Re-simulation: `MatchEngine.replay` to tick T gives the same hash and
        the same event list as the original run.
    *   AI replay: with both teams `controlledBy: 'ai'`, a run whose log
        contains AI substitutions replays to the same hash (AI entries are
        not re-applied).
    *   Cases are added per build step: hash-at-T only in step 2; lofted
        pass in step 3; dead ball and pending substitution in step 4.
*   **Why**: §4, §20; the base for resume and repro.

##### 77. (Removed)

Reserved; the number is kept for cross-references. Allocation is a
code-review rule (§4); its effect shows only indirectly in
`npm run bench` timings.

##### 78. `./tests/engine/rng.test.js`, `detmath.test.js`, `geom.test.js` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    *   `rng.test.js`: known-answer vectors for `sfc32`/`splitmix32`,
        generated once from PractRand's reference `sfc32` C source (not
        from the code under test) and committed;
        `seedSfc32` gives distinct states for seeds 0–9,999;
        `commentarySeed` gives distinct seeds across `seq` values.
    *   `detmath.test.js`: the item 36 error targets against `Math.*` over
        a grid.
    *   `geom.test.js`: segment-distance cases.
*   **Why**: §5, §8.

##### 79. `./tests/engine/resolve.test.js` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: monotonic checks on the §9a formulas. Better
    passing and less pressure must never lower pass success. A higher
    Finishing must never widen placement spread. A faster shot, or one
    placed nearer a corner, must never raise the save chance.
*   **Why**: §9; guards tuning mistakes.

##### 80. `./tests/engine/ball.test.js` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    *   A 30 m/s ground pass past a defender standing on its path is
        contested.
    *   A lofted cross over a defender is contested only where
        `heightAt` is under reach.
    *   Out of play and goal detection.
*   **Why**: §8; detects regressions to tunnelling or to every cross being
    intercepted.

##### 81. `./tests/engine/rules.test.js` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    *   Offside geometry cases, including level (onside) and the
        throw-in, goal kick and corner exceptions.
    *   A second yellow becomes a red.
    *   Queued substitutions apply only at the first dead-ball tick.
    *   A forced decision stops `step()`.
    *   Each command error code is returned in its own case.
    *   `RESOLVE_FORCED` for a GK red card with a bench keeper requires
        `outIndex` (`OUT_REQUIRED` otherwise); forced subs count toward
        the 5.
    *   No subs left leads to a reduced shape and no forced decision. A GK
        red card with no goalkeeper on the bench, or no substitutions left,
        puts the outfield player with the highest Reflexes + Positioning in
        goal.
    *   Each error code's condition and the check order from §12.
    *   Formation changes take effect on the tick after they are issued.
    *   Added time equals the sum of the `officiating.yaml` seconds for the
        goals, substitutions, cards and injuries recorded in the half.
    *   Tired substitutions fire no earlier than 55'; the losing-late
        formation switch fires at 70'; AI forced decisions resolve on the
        same tick without stopping `step()`.
*   **Why**: §10–12, G5.

##### 82. `./tests/runtime/bestmoments.test.js` and `persistence.test.js` (Create)

*   **Type / Scope**: Runtime tests (Node, controller driven through
    `tickFrame` with a fake clock that advances 0.01 ms per `now()` call,
    and a fake scheduler).
*   **Proposed Changes**:
    *   Best Moments:
        *   The replay leaves the live engine's hash unchanged.
        *   Lead-up is 300 ticks (or back to the first recorded tick).
        *   Fast-forward stops at `ffMaxTicksPerFrame` under the fake clock.
        *   A second trigger inside the post-roll extends the replay, never
            past `firstTriggerTick + 160`.
        *   A forced decision inside the window cuts the replay short and
            ends in `PAUSED_FORCED`.
        *   Commands are rejected during `REPLAY`.
        *   The live engine is at `replayEndTick` when paused.
        *   The replay cap is respected.
    *   Loop: a 0.5 s frame at 60x steps 20 ticks and leaves the budget at
        most 1; `alpha` stays in [0, 1].
    *   Persistence (`memoryStorage`):
        *   A save and resume round trip gives the same hash, score, clock
            and full event list.
        *   A `schemaVersion` mismatch, an `engineVersion` mismatch and a
            `stateHash` mismatch each discard the save with its own reason.
        *   A changed bundled config does not discard the save.
        *   Two lifecycle events at the same tick save once.
*   **Why**: G6, §14, §20.

##### 82a. `./tests/calibration/report.test.js` and `metrics.test.js` (Create)

*   **Type / Scope**: Unit tests for the calibration gate.
*   **Proposed Changes**:
    *   `report.test.js`: in band, out of band, a percentile outside
        tolerance, `ref = 0` using `toleranceAbs`, each Scenario B hard
        check, and the exit code.
    *   `metrics.test.js`: a hand-built event log gives the expected
        possession, pass completion and shots on target; restarts are not
        counted as passes.
*   **Why**: G3; the build gate itself needs tests.

##### 82b. `./tests/engine/movement.test.js` and `./tests/i18n/template.test.js` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    *   `movement.test.js`: anchors follow the ball by their coefficients
        and are clamped; players do not exceed top speed; formation switch
        reassigns slots by role.
    *   `template.test.js`: unknown tokens render `?`, and throw with
        `strict: true`; gender choice picks the right form.
*   **Why**: §7, §16.

##### 82c. `./tests/scripts/statsbomb.test.js` + `./tests/scripts/fixtures/statsbomb/` (Create)

*   **Type / Scope**: Unit tests for the reference pipeline.
*   **Proposed Changes**: a one-match fixture in the StatsBomb layout
    (`data/competitions.json`, `matches/`, `events/`). It asserts the
    yard-to-metre geometry, an own goal credited to the right team, the
    exclusion of period 5, the open-play pass filter (a cross and a
    Recovery pass counted, a throw-in not), and each xG feature value.
*   **Why**: the release gate's reference numbers come from this code.

##### 83. `./tests/i18n/commentary.test.js` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    *   Every event type renders in both locales with no unknown tokens.
    *   Gender choice works for a masculine and a feminine team and
        player.
    *   The variation index is the same across locales.
    *   Switching locale leaves the engine hash unchanged.
*   **Why**: G7.

##### 84. `./tests/config/build.test.js` (Create)

*   **Type / Scope**: Build tests.
*   **Proposed Changes**: fixtures in `tests/config/fixtures/`:
    `valid/` is a full copy of `config/` (YAML files only; schemas always
    come from `config/schema/`), and each other case is `valid/` with one
    file changed. The test runs `build-config.mjs --config-dir
    tests/config/fixtures/<case> --out-dir <tmp>` for each case:
    *   `bad-key/weights.yaml` (misspelled key) fails with file, line and
        column.
    *   `missing-template/` fails.
    *   `valid/` built twice gives the same `configHash`.
    *   `few-variations/` passes without `--strict-i18n` and fails with it.
*   **Why**: G8.

##### 85. `./tests/e2e/cross-engine.spec.js` + `./playwright.config.js` (Create)

*   **Type / Scope**: Cross-engine test.
*   **Proposed Changes**:
    *   Uses the page from item 85b.
    *   `playwright.config.js`: `testDir: 'tests/e2e'`, `timeout: 120000`,
        `webServer: {command: 'npx vite --strictPort', url:
        'http://localhost:5173/e2e/determinism.html', reuseExistingServer:
        !process.env.CI}`, one Chromium project.
    *   `tests/e2e/cross-engine.spec.js` opens the page, calls
        `runGolden`, and compares with `tests/golden/seeds.json`.
*   **Why**: G1 between the pinned Node and Chromium versions. It runs
    desktop Chromium's V8, not the Android System WebView; the device side
    is covered by the `#bench` golden hash and the resume hash check.

##### 85b. `./src/ui/e2e/determinism.html` + `./src/ui/e2e/determinism.js` (Create)

*   **Type / Scope**: Dev-only test page (not in the build input).
*   **Proposed Changes**: imports `src/engine/MatchEngine.js` and
    `#generated/config.js` and exposes `window.runGolden(seeds)`, which
    returns the hash streams.
*   **Why**: item 85 runs the engine in Chromium through this page.

##### 85a. `./.github/workflows/ci.yml` (Create)

*   **Type / Scope**: CI.
*   **Proposed Changes**: on push and pull request, on `ubuntu-latest`
    with Node from `.nvmrc`: `npm ci`, `npx playwright install --with-deps
    chromium`, `npm run lint`, `npm run typecheck`, `npm run build`,
    `npm run test:coverage`, `npm run test:e2e`, `npm run bench`.
    `calibrate` is not run in CI because 1,000 matches take several
    minutes; the author runs it locally. CI needs no StatsBomb download,
    because the references are committed in `targets.yaml`.
*   **Why**: G1, G4 and the coverage requirement need one place where they
    run.

#### Generated (not hand-edited)

##### 86. `./generated/config.js`, `./generated/events.js`, `./generated/squads/*.json` (Generated)

*   **Type / Scope**: Build output of `build-config.mjs`.
*   **Why**: the single compiled config used by app, tests and calibration.

##### 87. `./android/` (Generated)

*   **Type / Scope**: Capacitor Android project, created once by
    `npx cap add android`.
*   **Proposed Changes**: committed except `android/app/build/`. The only
    hand edit: add `android:screenOrientation="portrait"` to the
    `<activity android:name=".MainActivity">` element in
    `android/app/src/main/AndroidManifest.xml`, after `npx cap add
    android`.
*   **Why**: Capacitor cannot set the portrait lock from
    `capacitor.config.json`.

### Build order

Each step ends with its tests passing. Golden hashes follow the rule in
item 75. Subsystems not yet built are no-op modules (item 27).

1.  **Setup and config:** items 1–24, 26c, 58 (`build-config` reuses
    `Template.compile`), 84, 86. Commentary files (19–21) start as stubs
    with one template per event type; `--strict-i18n` is off.
2.  **Engine core:** items 35–38, then 27–34, 45 (kick-off and half-time
    only), 46, 51, and a minimal 48 (`SET_FORMATION` only); tests 75 (empty
    log), 76 (hash-at-T cases), 78.
3.  **Formations, movement, ball and fitness:** items 39–41, 47, and
    `metrics.js` from item 73; tests 80, 82b (movement); test 76 gains the
    lofted-pass case. Exit check: over 50 Scenario A matches, `distanceKm`
    and `sprints` fall inside their soft bands in `targets.yaml`.
4.  **Decisions, resolution, rules and AI coach:** items 42–50, finishing
    45 and 48; tests 79, 81; test 76 gains the dead-ball and
    pending-substitution cases; item 75 gains its command log.
5.  **Calibration:** download StatsBomb Open Data (README), run items 26b,
    26, 26a, then items 26d, 71–74 and tests 82a, 82c, until the release
    gate (item 17) passes.
6.  **Debug viewer (can run alongside step 5):** items 52 (`mode:
    'debug'`), 54, 60, 61 (with the `#seed` route), 62, 64.
7.  **Full UI and runtime:** items 25, 53, 54a, 55–57, 59 (with stub
    templates), 63, 65–70a, 68a; tests 82, 85, 85b, 85a.
8.  **Languages:** items 19–21 filled in; `--strict-i18n` on; tests 83,
    82b (template).
9.  **Android:** item 87 and the on-device checks.

The release gate (item 17) gates release, not the start of UI work.

### Verification Plan

*   **Compilation/Build**: `npm run build:config`, `npm run build`,
    `npm run typecheck`, `npm run android` (then build the APK in Android
    Studio).
*   **Unit Tests**: `npm test`, including the golden, restore and
    re-simulation, rules, runtime, calibration-gate and i18n tests.
*   **Static Analysis & Linting**: `npm run lint`. It fails on any banned
    `Math` function or import across the engine boundary.
*   **Test Coverage Requirement**: 85% line coverage for `src/engine/` and
    `src/runtime/`, enforced by `npm run test:coverage`
    (`--test-coverage-lines=85`). The UI is covered by manual checks.
*   **E2E/Integration**:
    *   `npm run test:e2e`: Node and Chromium hash streams match.
    *   `npm run calibrate`: exit 0 (the release gate in item 17 passes),
        with 500 matches per scenario.
    *   `npm run bench`: mean under 1.0 ms per 20 ticks (reported against
        the 0.33 ms estimate).
*   **On device**:
    *   `#bench` on the reference device (Snapdragon 680): p95 engine work
        under 2.0 ms per 20 ticks, p95 frame time at or under 16.7 ms,
        golden hash matches, full-match re-simulation under 12 s.
    *   Manual run of CUJ 1 and CUJ 2.
    *   Background the app mid-match, force-stop it, relaunch, and resume to
        the same score, clock and commentary feed.
    *   Copy a repro record on the reference device, paste it into a file,
        and run `npm run repro` on it: the state hash must match.

--------------------------------------------------------------------------------

*Drafted with EGM*

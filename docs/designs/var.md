# VAR (Video Assistant Referee)

VAR reviews four kinds of incident: a goal, a penalty given on the field, a box challenge that play went on
after, and a yellow card for a severe foul. A review is a two-beat reveal: `VAR_CHECK` (play held, a `VAR CHECK`
banner over the pitch, commentary), then `VAR_DECISION` (the call, the ruling, added time, a morale swing for
both squads and the key player, and on an overturn the green / red reaction rings of the coach shouts).

Config: `config/var.yaml` (schema `config/schema/var.schema.json`). Engine: `src/engine/officiating/VarSystem.js`.
UI: `src/ui/views/VarHudView.js` (banner), commentary pools in `config/commentary/<locale>.yaml`, banner strings
in `config/ui-strings/<locale>.yaml` (`var`).

## Hard constraints

- **Zero regression.** VAR runs only in a match whose input has `var: true` (the app sets it) while
  `config.var.enabled` is true. Otherwise `state.var` is null: no hook runs, no RNG number is drawn, nothing is
  serialized. Golden inputs and calibration cohorts never set it, so `tests/golden/seeds.json` and the default
  calibration are bit-identical. `npm run calibrate -- --var` plays the cohorts with VAR.
- **Determinism.** VAR draws from the match RNG only in a VAR match: one draw when an incident may be checked,
  two when a review is decided (the call, the added seconds). Reviews are plain state (`state.var.review`), so
  save / restore and replays carry them exactly.
- **Strict i18n.** `build:config -- --strict-i18n` requires, per locale, every `var.*` banner string
  (`VAR_STRING_KEYS`) and a commentary pool for every incident (`VAR_CHECK`) and outcome (`VAR_DECISION`), with
  the same number of variations in each locale.

## Incidents

| Incident | When | Check | Overturned | Stands |
| :--- | :--- | :--- | :--- | :--- |
| `GOAL` | a goal of a kind in `goalCheck.kinds` (open play, direct free kick) | `tight` when a forward pass of the scoring side's move (within `windowTicks`) was received less than `offsideMarginM` onside; else `routine` | `goalDisallowed`: score reverted, free kick to the defence (indirect at the offside spot for a tight call) | `goalConfirmed` |
| `PENALTY` | a penalty given on the field | `penaltyCheck.given` | `penaltyOverturned`: drop ball for the defending side | `penaltyConfirmed` |
| `POSSIBLE_PENALTY` | a defender's tackle in their own box that was not a foul | `penaltyCheck.missed`; play is stopped at once (drop ball) | `penaltyAwarded`: the penalty (`PENALTY_AWARDED` follows the decision) | `noPenalty`: the drop ball |
| `RED_CARD` | a yellow (not a second yellow) for a foul of severity `minSeverity` or more | `redCardCheck` | `redCardUpgraded`: straight red (`RED_CARD` follows), the yellow is rescinded | `yellowStands` |

Only one review runs at a time; an incident during a review is not checked.

## The review

1. The incident: one draw against `checkP`. A check opens `state.var.review`, which holds play: the restart
   waits (`advanceRestart`), and the half cannot end until the review is decided (`advanceClock`).
2. `checkDelayTicks` later (the goal celebration plays first): `VAR_CHECK {incident}`, actor the scorer / fouler
   / booked player, `secondaryIndices` the assister or the fouled player.
3. `reviewTicks` later: one draw against `overturnP` (`awardP`, `upgradeP`) and one for the added seconds
   (`addedSeconds` min..max, uniform), which go onto the half at once (onto the time still to play if the added
   time was already announced). The ruling is applied, the morale swing too, then `VAR_DECISION {incident,
   outcome, overturned, addedSeconds, positive, negative, assist}`. Play resumes at least `resumeTicks` later.

## Morale

Each outcome has `benefiting`, `penalized` (squad momentum, `Morale.shiftMorale`) and `individual` (the key player's
personal morale). An overturn costs the side that loses the decision more than the other gains: a disallowed
goal is +3 / −5 and −8 for the scorer; a VAR penalty +3 / −4 and −4 for the fouler. A red card's and a penalty's
own morale effects still apply through their events.

## Stats and ratings

A disallowed goal comes off the team's `goals` counter (registry stat on `VAR_DECISION`), the scorer's goals, the
assister's assists and their ratings, and the conceding side's conceded-goal rating points are given back. An
upgrade rescinds the yellow in the card count. A cancelled penalty gives back the fouler's penalty-conceded points.

## Presentation

- **Banner** (`VarHudView`): `VAR CHECK` and the incident (`Checking goal`, `Checking penalty`, `Possible
  penalty`, `Possible red card`); then an overturn's headline (`GOAL DISALLOWED`, `NO PENALTY`, `PENALTY`, `RED
  CARD`) over `Decision overturned`, or `CHECK COMPLETE` over the call that stands. Cyan while checking, amber for
  an overturn, green when the call stands. It clears once play resumes (shown at least 1.8 s, at most 6 s), on a
  reset or seek, and is not shown in replays. It is driven by the frame's released events, so it never runs
  ahead of the picture.
- **Reactions**: an overturn's `secondaryIndices` (the favoured side first, `meta.positive` of them) become the
  coach shouts' `SHOUT` ring cue: green ring and ▲ for the favoured side, red ring and ▼ for the other.
- **Commentary**: `VAR_CHECK` has a pool per incident and `VAR_DECISION` per outcome (`commentaryBy` in the event
  registry; `i18n/Commentator.js` picks the pool).
- **Auto Highlights**: `VAR_CHECK` is a crucial moment (`isHighlightTrigger`), so fast-forward drops to 1x on its
  tick with the 7 s pre-roll. A review on screen keeps play live (`isDangerousTick`), so the decision is reached
  at 1x and nothing (the decision, a reverted score) is shown before its tick.

## Rates

Tuned on the even cohort (200 matches, `var: true`): about 0.3 goal checks per match with 0.05-0.09 goals
disallowed, 0.07 penalty checks (0.02-0.04 overturned), 0.1 box-challenge checks with 0.06 penalties awarded,
and 0.04 red-card checks with about 0.015 upgrades. With VAR every cohort event frequency, result curve and morale
edge stays in its band (`npm run calibrate -- --var`), except that the morale cohort's "goals per shot on target
(high − low)" check sometimes lands just under its 0.000 floor. That is random-stream noise, not VAR: over 600
matches it reads +0.032 without VAR, −0.003 with VAR, and −0.008 with VAR on but every check off (no VAR effect,
only a different random stream). The release gate (no VAR) is unchanged.

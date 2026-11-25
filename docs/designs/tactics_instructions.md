# freefoot Tactics Panel and Engine Instructions

*   **Author:** bytemania
*   **Status:** Approved
*   **Date:** 2026-11-25

--------------------------------------------------------------------------------

## Overview

The match viewer gets a **Tactics** (`Tática`) button next to the existing
Coach button. It opens a two-tab panel of nine team instructions:

| Tab | Instruction | Options (default in bold) |
| :-- | :-- | :-- |
| In possession (`Com Bola`) | Tempo | Slow · **Standard** · Fast |
| | Passing directness | Short · **Mixed** · Direct |
| | Attacking corridor (`attackFocus`) | Wings · **Mixed** · Centre |
| | Attacking transition | Hold shape · **Balanced** · Counter |
| | Time-wasting | **Never** · Sometimes · Always |
| Out of possession (`Sem Bola`) | Defensive line | Low · **Standard** · High |
| | Marking | **Zonal** · Man-to-man |
| | Defensive transition | Regroup · **Balanced** · Counter-press |
| | Tackling | Stay on feet · **Normal** · Get stuck in |

The Coach button (squad, formation, substitutions) is unchanged, and its label
becomes "Squad & substitutions" so the two buttons are not confused.

## Hard constraints

1.  **Zero regression on defaults.** Every default option is an exact no-op:
    `tests/golden/seeds.json` and the four calibration cohorts (Even,
    Moderate, Heavy, Morale) are bit-for-bit unchanged.
2.  **Real trade-offs.** Every non-default option has an upside and a downside.
    No option is a free win.
3.  **Full i18n** in `en-GB` and `pt-PT`, checked by
    `npm run build:config -- --strict-i18n`.
4.  **Testable in isolation.** Deterministic tests show that each instruction
    changes the mechanism it targets. A calibration cohort shows each one
    changes match behaviour in the declared direction.

## Engine architecture: options become numbers in one place

The engine never mentions an option name. Code that applies an instruction
only checks the game situation (leading? transition phase? own restart?) and
reads a number, a **knob**.

### Knob catalogue (`src/engine/tactics/Instructions.js`)

`KNOBS` lists every knob with its identity value and how values from several
instructions combine:

| Compose | Identity | Meaning |
| :-- | :-- | :-- |
| `mul` | 1 | the values multiply |
| `add` | 0 | the values add |
| `min` | +∞ (written as a large number) | the smallest value wins (a "from minute" threshold) |

The catalogue is code, not config (`KNOBS` in `Instructions.js`, not a `knobs:`
block in `tactics.yaml`). The identity value is part of the engine's contract,
not something to tune. `build-config` imports the catalogue and
rejects any option that names an unknown knob.

### Options (`config/tactics.yaml`, `instructions`)

```yaml
instructions:
  tempo:
    group: inPossession
    default: standard
    options:
      slow:
        knobs: {settleMul: 1.4, holdAdd: 0.15, noiseMul: 0.92, drainMul: 0.97}
        upside: {metric: passCompletion, dir: up}
        downside: {metric: shots, dir: down}
      standard: {}
      fast:
        knobs: {settleMul: 0.6, holdAdd: -0.15, noiseMul: 1.12, drainMul: 1.04}
        upside: {metric: shots, dir: up}
        downside: {metric: fitness, dir: down}
```

*   The default option must be `{}`. `build-config` fails on any key inside it,
    so a default cannot drift away from a no-op.
*   Each non-default option declares the `upside` and `downside` that the
    calibration cohort checks: a metric and the direction it must move.

### Resolution

`resolveKnobs(cfg, instructions)` starts from the identity of every knob and
folds in the chosen option of each instruction. The result is a frozen flat
object kept on `TeamState.knobs`. It is never serialized: it is rebuilt from
`TeamState.instructions` on construction and on `restore()`. All-default
teams share one frozen `IDENTITY` object.

### Why the defaults are bit-identical

*   `x * 1 === x` and `x + 0 === x` hold exactly in IEEE-754 (apart from
    `-0 + 0`, which `serialize()` already normalizes to `0`). A knob at its
    identity can sit anywhere in an existing expression without changing a
    bit. Hot paths that would otherwise do extra work skip it with a guard on
    the knob value (`if (k.lineBackM !== 0)`), never on an option name.
*   No new random draws on the default path. The only new draw (the
    time-wasting booking) happens behind `minute >= k.wasteFromMinute`, and
    the identity for that knob is never reached.
*   `serialize()` writes a team's `instructions` only when at least one differs
    from its default, so the canonical bytes, and the state hash, of an
    all-default match are unchanged. `stateVersion` is not bumped; `restore()`
    reads a missing `instructions` as all defaults.
*   `configHash` changes (the config gained keys). The golden test compares
    state hashes only, and repro records embed their config, so nothing
    breaks.

### Where each knob is read

| Instruction | Read in | Knobs |
| :-- | :-- | :-- |
| Tempo | `Actions.giveBall` (settle time), `decideCarrier` (hold score), `noise()`, `passScore`, `Fitness` | `settleMul`, `holdAdd`, `noiseMul`, `progressMul`, `throughPassAdd`, `drainMul` |
| Directness | `passScore` | `progressMul`, `shortPassAdd`, `longPassAdd`, `throughPassAdd` |
| Attacking corridor | `passScore` (target more than 20 m from the centre line: wide; within 12 m: central), `computeAnchors` (in-possession width of wingers and full-backs) | `widePassBias`, `centerPassBias`, `widthMul` |
| Attacking transition | `Phase.updatePhases` (length of `TRANSITION_ATT`), `computeAnchors` (forward push), `passScore` | `transitionAttMul`, `transitionPushAdd`, `transitionMfPushAdd`, `transitionProgressMul` |
| Time-wasting | `RestartMachine.startRestart` (own throw-ins, goal kicks and free kicks while leading) | `wasteFromMinute`, `wasteHoldMul`, `wasteCardP`, `wasteAddedShare` |
| Defensive line | `computeAnchors` (out-of-possession base depth of the back and midfield lines), the opponent's `passScore` | `lineBackM`, `lineMidM`, `invitesThroughAdd` |
| Marking | `OffBallDecision.defend` (who to mark), `applyIntent` (marking gap), `screen()`, `dribbleOutcome` | `markZoneMul`, `markFromSelf`, `markStick`, `markGapMul`, `screenMul`, `dribbledLogit` |
| Defensive transition | `giveBall` (counter-press trigger), `defend()`, `computeAnchors` (`TRANSITION_DEF` drop) | `cpTicksMul`, `cpFromAdd`, `cpCountAdd`, `cpZoneMul`, `transitionDropM` |
| Tackling | `contacts.tackle` (attempt chance), `tackleOutcome` (win and foul logits), `Referee.judgeContact` (severity) | `tackleAttemptMul`, `tackleWinLogit`, `tackleFoulLogit`, `severityAdd` |

`drainMul` is shared: tempo, marking and defensive transition all contribute,
and the values multiply.

### Trade-offs

Where possible a knob moves geometry or a decision weight, not an outcome
probability, so the downside comes from the models the engine already has.
Two downsides needed an explicit mechanism, because the emergent one was too
weak:

*   **High line:** `invitesThroughAdd`, read by the *opponent's* `passScore`,
    makes a ball in behind more attractive against it (less attractive against
    a low line).
*   **Man-to-man:** `dribbledLogit`, read in `dribbleOutcome`, makes a tight
    marker easier to turn.

The values below are the tuned ones in `config/tactics.yaml`. The upside and
downside columns are the metrics the calibration cohort gates (option side
minus default side; `opp*` metrics are what the opponent does).

| Option | Knobs | Upside | Downside |
| :-- | :-- | :-- | :-- |
| Tempo: Slow | `settleMul 1.3, holdAdd 0.1, progressMul 0.95, noiseMul 0.95, drainMul 0.96` | interceptionsSuffered down | shots down |
| Tempo: Fast | `settleMul 0.85, holdAdd -0.1, progressMul 1.15, throughPassAdd 0.03, noiseMul 1.05, drainMul 1.04` | progressivePasses up | interceptionsSuffered up |
| Passing: Short | `progressMul 0.93, shortPassAdd 0.045, longPassAdd -0.08, throughPassAdd -0.04` | passCompletion up | progressivePasses down |
| Passing: Direct | `progressMul 1.15, shortPassAdd -0.04, longPassAdd 0.1, throughPassAdd 0.08` | progressivePasses up | interceptionsSuffered up |
| Attacking corridor: Wings | `widePassBias 0.08, widthMul 1.08` | widePassShare up | centralPassShare down |
| Attacking corridor: Centre | `centerPassBias 0.035, throughPassAdd 0.1, widthMul 0.96` | centralPassShare up | interceptionsSuffered up |
| Attacking transition: Hold shape | `transitionAttMul 0.7, transitionPushAdd -2, transitionMfPushAdd -3, transitionProgressMul 0.9` | passCompletion up | progressivePasses down |
| Attacking transition: Counter | `transitionAttMul 1.5, transitionPushAdd 4, transitionMfPushAdd 4, transitionProgressMul 1.3` | progressivePasses up | passCompletion down |
| Time-wasting: Sometimes | `wasteFromMinute 75, wasteHoldMul 3, wasteCardP 0.25, wasteAddedShare 0.6` | deadBallLeading up | yellowCards up |
| Time-wasting: Always | `wasteFromMinute 0, wasteHoldMul 2.5, wasteCardP 0.15, wasteAddedShare 0.6` | deadBallLeading up | yellowCards up |
| Defensive line: Low | `lineBackM -1.75, lineMidM -0.75, invitesThroughAdd -0.15` | oppThroughCompleted down | oppShots up |
| Defensive line: High | `lineBackM 2.5, lineMidM 1.5, invitesThroughAdd 0.2, drainMul 1.03` | offsidesWon up | oppThroughCompleted up |
| Marking: Man-to-man | `markZoneMul 1.4, markFromSelf 1, markStick 1, markGapMul 0.8, screenMul 0, dribbledLogit 0.25, drainMul 1.08` | oppThroughCompleted down | oppDribblesWon up |
| Defensive transition: Regroup | `cpTicksMul 0, transitionDropM 4, drainMul 0.95` | fitness up | progressivePasses down |
| Defensive transition: Counter-press | `cpTicksMul 2, cpFromAdd -10, cpCountAdd 1, cpZoneMul 1.3, drainMul 1.02` | highRegains up | fitness down |
| Tackling: Stay on feet | `tackleAttemptMul 0.92, tackleWinLogit -0.03, tackleFoulLogit -0.5, severityAdd -0.1` | fouls down | tacklesWon down |
| Tackling: Get stuck in | `tackleAttemptMul 1.1, tackleWinLogit 0.05, tackleFoulLogit 0.4, severityAdd 0.2` | tacklesWon up | fouls up |

### Time-wasting

Applies only while the team leads; never when level or behind.

*   **Sometimes:** leading, from the 75th minute.
*   **Always:** whenever leading.

On its own throw-ins, goal kicks and free kicks the hold is multiplied by
`wasteHoldMul`. `wasteAddedShare` of the extra seconds goes into the half's
added time, and the taker (when not already booked) is booked for delaying the
restart with probability `wasteCardP`.

## Commands and when changes apply

`SET_INSTRUCTIONS {instructions: {tempo, directness, attackFocus, ...}}` carries
all nine values in one payload (missing ones take their default), so one Confirm makes one log entry and one Pending
item. The engine validates every key and option against the config
(`UNKNOWN_INSTRUCTION`, `UNKNOWN_OPTION`).

Changes apply at the **next stoppage**, like substitutions:

*   This removes micro-management exploits without cooldown state. Opening
    the panel only slows play to 1x, so live changes would invite flipping
    the counter-press or the line on every turnover.
*   It reuses `executeAtStoppage` (a change confirmed while the ball is dead
    applies at once) and the unified Pending list.
*   Dead balls come about once a minute, so the latency is small.
*   Parameters never change halfway through a press or a transition.

Internally the command stays in `pendingCommands` (already serialized) until
a stoppage. A newer `SET_INSTRUCTIONS` for the same team replaces an older
pending one. Replays re-apply human commands at their ticks, as before.

A `MatchInput` team may also carry `instructions` (for example the
calibration cohort's starting instructions). All-default input instructions
give a hash stream identical to omitting them.

## AI manager

The AI stays on defaults in v1. `ai_coach.yaml` gets a rule table in the same
style as `losingLate`:

*   **chasing** (behind, from 70'): Fast, Direct, High line, Counter-press.
*   **protecting** (ahead, from 80'): Slow, Low line, Regroup, Time-wasting
    Sometimes.

It ships with `instructions.enabled: false`. The goldens are human v human and
cannot be affected, but calibration is AI v AI and would move, so enabling it
is a separate change, made after `npm run calibrate`.

## UI

*   **Controls bar:** Stats, **Tactics** (new icon), Coach, then Play on the
    right.
*   The Tactics panel uses the same drawer component as the Manager panel.
    Opening one closes the others, play slows to 1x as for the Manager, and it
    is disabled during replays.
*   **Layout:**
    *   Two tabs (`Com Bola` / `Sem Bola`); a dot marks a tab with non-default
        values.
    *   One row per instruction: a label, then a two- or three-way segmented
        control.
    *   A one-line hint under each row for the selected option, naming its
        upside and downside.
*   **Footer:** a "Reset" button (back to the defaults) and "Confirm". After a
    confirm, a status line reads "Applies at the next stoppage". The change
    also shows in the Manager's Pending list, without locking the Manager.
*   **Strings:** a `tactics` group in `config/ui-strings/<locale>.yaml`:
    *   `<instruction>` for the label;
    *   `<instruction><Option>` for each option;
    *   `<instruction><Option>Hint` for each option's hint.

    `build-config` derives the required keys from `instructions` in
    `tactics.yaml`, so adding an option without its strings fails the build in
    both locales.
*   No commentary event in v1.

## Verification

1.  **Golden:** `tests/golden/seeds.json` unchanged, plus a test that explicit
    all-default `instructions` give the same hash stream.
2.  **Mechanism tests:** each instruction on a fixed state changes the targeted
    quantity: anchor depth, settle time, pass score, attempt and foul chance,
    counter-press length, restart hold, mark target.
3.  **Directional match tests:** a small fixed set of seeds, with assertions on
    the sign of the effect (for example High line gives more opponent
    offsides).
4.  **Instructions calibration cohort** (`npm run calibrate:instructions`):
    *   80 v 80 OVR. For each non-default option, every seed is played twice,
        with the option on the home side and then on the away side, against a
        default side. Swapping sides cancels squad differences.
    *   300 seeds by default, so 600 matches per option. Goal difference has
        a standard deviation of about 1.6 per match, so the mean's standard
        error is about 0.065; options are tuned to a true effect well inside
        the cap so that no option fails on noise alone.
    *   **Gate 1:** the mean goal difference (option side minus default side)
        is within **±0.15** per match.
    *   **Gate 2:** the declared upside metric and downside metric each move
        in the declared direction, with a paired z ≥ 2.
    *   The report lists every option's effect on goals, xG, shots, pass
        completion, progressive passes, offsides, fouls, cards, tackles, high
        regains and fitness at full time.

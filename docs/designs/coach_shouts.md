# Coach shouts

A **Shouts** (`Gritos`) button in the match control bar opens a drawer with ten touchline shouts. A shout is a
short, temporary nudge: it moves the morale and focus of the players who hear and accept it, and for some
shouts it adds a tactical effect for about nine match minutes. Who reacts depends on the player's role, where
they are on the pitch, their morale, the scoreline and how often the manager has been shouting. Staying quiet
for too long and shouting too often both cost the team. On the pitch, each player who reacted gets a green
(accepted) or red (rejected) ring and arrow.

Config: `config/shouts.yaml` (schema `config/schema/shouts.schema.json`). Engine: `src/engine/tactics/Shouts.js`.
UI: `src/ui/views/ShoutsView.js`. Pitch: `src/runtime/animationCues.js`, `src/ui/pitchAnimations.js`,
`src/ui/views/PitchCanvasView.js`.

## Hard constraints

- **Zero regression.** A team that never shouts keeps `team.shout === null`: nothing is serialized, no RNG
  number is drawn and no per-tick work runs. Player `focus` stays 0 and is serialized only when non-zero; its two
  read sites are skipped at 0. The silence clock runs only for a team whose match input has `shouts: true` (the
  app sets it for the human side; golden inputs and calibration cohorts never do). `tests/golden/seeds.json`
  and the AI-v-AI calibration therefore stay bit-identical.
- **Determinism.** The only RNG draws are inside ISSUE_SHOUT: one `nextFloat` per player evaluated (in
  `onPitchList` order). ISSUE_SHOUT is a logged human command, so `MatchEngine.replay` and seeks rebuild the
  same draws.
- **Strict i18n.** `build:config -- --strict-i18n` requires, per locale, every `shouts.<id>` label and
  `shouts.<id>Hint` hint, plus the panel, receptiveness and error strings.

## The ten shouts

| Shout | Who (roles) | Where | Tactical effect (scaled by the accepted share) | Morale rules |
| :--- | :--- | :--- | :--- | :--- |
| `focus` Focus | everyone | any | calmer decisions (`noiseMul` 0.93), a touch more patience | broadly accepted |
| `pushForward` Push forward | FB, MF, W, ST | opponent's half | lines up (+1.5 m / +2 m), more forward runs and progression, more tiring, more space in behind | welcomed when trailing, resisted when leading |
| `tightenUp` Tighten up | GK, CB, FB, MF | own half | lines drop (-1.5 m), tighter marking, less progression | welcomed when leading |
| `encourage` Encourage | everyone | any | none | low-morale players accept (+3 morale); confident ones shrug |
| `demandMore` Demand more | outfield | any | more tackles and running, more tiring | confident players respond; low-morale ones often take it badly (-2.5) |
| `fireUp` Fire up | outfield | any | win more tackles, but foul harder and more often | strong morale lift, slight loss of composure |
| `calmDown` Calm down | outfield (booked or ≥2 fouls first) | own half | fewer and milder fouls, fewer tackles | focus up; others count at 0.35 weight |
| `praise` Praise | everyone | any | none | lifts a winning side; backfires when trailing (complacency); confident players need it less |
| `getCreative` Get creative | MF, W, ST | opponent's half | more through balls and risk, noisier decisions | — |
| `berate` Berate | everyone | any | more tackles, a little more running | rarely accepted; backfires hard when leading or on low morale (-4) |

Numbers are in `config/shouts.yaml`. Tactical knobs are the knob catalogue of `tactics/Instructions.js`
(mul or add only; checked by `build:config`).

## How a shout resolves

For each on-pitch player of the team:

1. **Role and zone.** The player's current slot role must be in `roles`, and their position, measured in the
   team's own attacking direction (so home and away, first and second half all agree), must be in `pitchZone`:
   `defensive` = own half, `offensive` = the opponent's half, `any` = anywhere. A player outside either is
   `neutral` (no draw, no animation). With `prefer: discipline` (`calmDown`), players who are not booked and
   have fewer than `preferFouls` fouls are evaluated at `otherWeight`.
2. **Acceptance.** `pAccept = sigmoid(base + morale × moraleLevel + context + booked + spamAcceptLogit ×
   overload)`, with `context` the shout's `leading`, `level` or `trailing` logit.
3. **Outcome** (one `nextFloat`): below `pAccept` → **positive** (the `positive` morale and focus, scaled by
   weight × effectiveness); else, with probability `backfire + spamBackfire × overload`, **negative** (the
   `negative` morale and focus); else **neutral**.

The **tactical effect** is the shout's knobs scaled by `share = accepted weight / weight of everyone in roles
× effectiveness`: a multiplier `m` becomes `1 + (m − 1) × share`, an offset `a` becomes `a × share`. It is
composed over the instruction knobs (`team.knobs`) until `durationTicks` have passed. Only a shout with knobs
replaces the effect running, so `encourage` does not cancel a `pushForward`. The same shout then waits
`cooldownTicks`.

Morale changes go into the player's personal morale shift (`morale/Morale.js`) and decay with it. **Focus** is a
new per-player level in −1..1 that decays toward 0 (half-life 6 minutes); at focus 1 decision noise is cut by
`focus.noise` and the pass completion logit gains `focus.passLogit`.

One `SHOUT_REACTION` event per shout lists the players who reacted: `secondaryIndices` holds the positive ones
first (`meta.positive` of them), then the negative ones; `meta.shout` names the shout.

## Cadence: silence and spam

- **Silence** (`shouts: true` only): after `silenceThresholdTicks` (28 minutes) without a shout, counted from
  kick-off or the last shout, every minute each on-pitch player loses 0.6 personal morale points and 0.04 focus
  (not below −0.5), until the next shout. The panel shows the side as **Quiet**.
- **Spam:** each shout adds 1 to the team's shout load, 1 more within 2 minutes of the previous shout. The load
  falls with a 10-minute half-life. Above `spamThreshold` (3.5) the **overload** lowers acceptance, raises
  backfires, cuts every effect to `1 / (1 + overload)` and costs every on-pitch player `1.5 × overload` morale
  points (they show as negative reactions). The panel shows **Overwhelmed**; otherwise **Engaged**.

## Commands and state

`ISSUE_SHOUT {shout}` is refused with `UNKNOWN_SHOUT`, `SHOUT_COOLDOWN` (that shout is still cooling down) or
`SHOUT_PENDING` (one is already waiting for the next tick). Like formation changes, it is carried out at step 1
of the next tick, or at once while the ball is dead.

`team.shout` is `null` until the first shout (or from kick-off with `shouts: true`), then
`{lastTick, count, load, active: {id, untilTick, share} | null, cooldowns}`; it is serialized only when not
null. `team.instrKnobs` (from the instructions) and `team.shoutKnobs` (the running shout) are derived and never
serialized; `team.knobs` composes them.

## Pitch animation

The runtime turns each `SHOUT_REACTION` into a `SHOUT` animation cue. The pitch canvas draws, for about 2.3 s,
an expanding, fading ring around each reacting player's token and a small floating arrow above it: green `▲` for
positive, red/amber `▼` for negative. The ring follows the token as the player moves. Neutral players get
nothing. Cues are skipped while fast-forwarding and in replays, and the running ones are cleared when the
match is reset or seeked (the frame's tick goes backwards).

## UI

The Shouts button sits between Tactics and Coach. The drawer lists the ten shouts in a two-column grid with
one-line hints, the running shout and its minutes left, each shout's cooldown, and the side's receptiveness
(Quiet / Engaged / Overwhelmed). Opening it slows play to 1x like the other panels; it is disabled during
REPLAY. A tap sends ISSUE_SHOUT at once (no confirm step: shouts are immediate).

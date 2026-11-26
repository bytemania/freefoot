# Design Documents

| Design | Status | Date | Author | Components | Description |
| --- | --- | --- | --- | --- | --- |
| [freefoot Match Engine and v1 Single-Match Viewer](./freefoot_match_engine.md) | Approved | 2026-11-22 | bytemania | engine, runtime, ui, i18n, config, calibration | Deterministic 20 Hz 2D match engine with a serialisable API, portrait Canvas viewer with Best Moments, pt-PT/en-GB commentary, and a headless calibration runner. |
| [VAR (Video Assistant Referee)](./var.md) | Implemented | 2026-11-25 | bytemania | engine, runtime, ui, i18n, config, calibration | Goal, penalty and red-card checks with a two-beat VAR_CHECK / VAR_DECISION reveal, added time, asymmetric morale swings, a HUD banner, PT/EN commentary pools and Auto Highlights integration. |
| [Football Manager Matchday Loop (Phase 1)](./matchday_loop_phase1.md) | Approved | 2026-11-25 | bytemania | config, i18n, engine, runtime, shared, ui, calibration | Pre-Match setup (10 default tactics, 7 new formations, Plan A/B slots, Starting XI + bench), 60/40 tactical familiarity with `<65` Fluid cap, live `SWITCH_TACTIC_PLAN`/`CANCEL_TACTIC_PLAN`, and Post-Match Report (`MatchReport`) -> Next Match loop. |

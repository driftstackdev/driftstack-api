# 2026-06-10 — Behavioral-model ownership decision (ORCHESTRATOR queue #2)

**Decision owner:** Agent-2 (founder-delegated this wave). Resolves the long-open
"divergent-touch-model risk" (ORCHESTRATOR-STATE A2 queue #2): who owns the
behavioral model — the harness Swift executor, or the driftstack-api TS
`behavioural-simulation` generator?

## The finding (why this needed deciding)

There are **two complete, divergent behavioral models**:

|                   | Canonical shared `driftstack/shared/behavior/personas.json`                                                                          | TS lib `behavioural-simulation/profiles.ts` `PROFILE_CATALOGUE`                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| casual `base_wpm` | **28**                                                                                                                               | **38**                                                                                                         |
| shape             | rich: typing/motor/scroll/reading/navigation distributions (tap_precision, momentum_decay, wpm_reading, post_load_orientation_ms, …) | simplified 5-param (meanKeyDelayMs, meanMouseSpeedPxPerMs, meanScrollPxPerTick, pauseProbability, meanPauseMs) |
| wired?            | **YES** — the harness executes it (Swift↔JSON parity guard, A3 W386)                                                                 | **NO** — dormant; nothing consumes its parameter values server-side                                            |

They disagree on both values and shape. No LIVE bug today (the TS lib is unwired,
so only the harness/shared-JSON model runs), but it's a latent trap: "wiring the
TS lib" as the behavioral source — the instinct the queue item invited — would
make the prod behavior diverge from the harness's (casual 38 vs 28 WPM, etc.).

## Decision

1. **The harness, executing the canonical `driftstack/shared/behavior/personas.json`
   (rich, file-05-spec'd), is the single owner of the behavioral MODEL +
   EXECUTION.** It samples at runtime with live page context — the right place
   for execution. The shared JSON is the source-of-truth.
2. **The TS `behavioural-simulation` lib is NOT a second behavioral model.** Its
   legitimate role is the **persona catalogue** — the ids (`casual` / `regular` /
   `power_user`) + labels/descriptions that the dashboard selector, the SDK
   persona-selection, and session-create validation use. Plus a server-side
   reference/test implementation.
3. **Its `PROFILE_CATALOGUE` parameter VALUES are a simplified, divergent set and
   MUST NOT be wired as the production behavioral source.** Doing so re-introduces
   the divergent-touch-model risk. (Marked non-canonical in `profiles.ts`.)
4. **SessionAssign keeps `behaviorProfile` = the persona NAME** (string). The
   harness resolves the name against the canonical shared JSON. No restructure;
   no ship-parameters-on-assign needed for v1.0.
5. **Tier-2 ML (file 132):** Agent-1's trained models update the canonical shared
   `personas.json` → the harness picks them up via its parity path. The TS lib
   does not need the ML params (it's the catalogue, not the executor).

This eliminates the divergence by having ONE behavioral model (shared JSON +
harness), not by wiring the second one.

## Cross-agent (A3) confirmation needed

- Confirm the shared `personas.json` is the canonical behavioral source and the
  harness's W386 parity is value-level against it (not just shape).
- The persona id set `{casual, regular, power_user}` is the file-05 canonical 3;
  the TS catalogue + the shared JSON keys must agree on the id LIST (the selection
  contract) — value/shape of params intentionally differ (TS = reference only).

## A2 follow-ups (in scope, non-gated)

- `profiles.ts` comment marking `PROFILE_CATALOGUE` non-canonical (done this wave).
- If a server-side behavioral need ever arises, align the TS lib TO the shared
  JSON shape (don't fork a third model) — not needed for v1.0.

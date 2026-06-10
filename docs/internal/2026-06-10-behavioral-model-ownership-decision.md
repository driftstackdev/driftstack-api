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

## Cross-agent (A3) confirmation — ✅ RECEIVED (bus W782/W784)

- **Stronger than parity (W782):** `shared/behavior/personas.json` IS the harness's
  SOLE canonical source — `BehavioralSimulator.swift` is its Codable MIRROR and the
  harness LOADS + EXECUTES the JSON's actual values at runtime (`PersonaSetLoader`).
  There is no independent value-model to diverge. A3 verified casual/regular/
  power_user `base_wpm` = **28/38/52** (the shared-JSON values, not the TS lib's
  casual=38). W386 was the shape + load verification.
- **Id list agrees (W782):** `{casual, regular, power_user}` = the file-05 canonical
  3 both sides. The selection contract (SessionAssign.behaviorProfile = persona NAME
  → harness resolves vs the shared JSON) is what A3 relies on; TS param VALUES
  differing is fine (reference/catalogue, correctly marked non-canonical).
- A3 never expected the TS lib to feed the harness. **Divergence resolved by design.**
  This session's A3 behavioral builds (idle-activity planner, persona-drift) all
  operate on the shared-JSON `Persona`, consistent with the one-model decision.

## Speed-modifier axis (fast/balanced/careful) — queued v1.1 (founder product-call)

The shared `persona-schema.json` requires `profile_speed_modifiers`
{fast/balanced/careful} "layered on top of persona"; the harness `resolvePersona`
supports a speed-key (case-2, currently applied to a hardcoded `regular` base). But
the API exposes only the persona (no field for the speed layer), and the single
`behaviorProfile` field carries persona OR speed — they can't combine.

- **Persona-only = the v1.0 cut** (working, wired, tested end-to-end via harness
  case-1). No gap for v1.0.
- **Full persona×speed matrix = well-scoped, LOW-RISK v1.1** (A2 + A3 agree, bus
  W432/W784): A2 adds a 2nd `speed_profile` field on CreateSessionRequest +
  SessionAssign; A3 extends `resolvePersona` to 2-arg `(persona, speedKey)` →
  `applyProfileModifier(chosen-persona, mod)` — **the apply-fn already exists +
  is tested** (just pass the chosen persona instead of the hardcoded base).
  - 🙋 **FOUNDER product-call:** do v1.0 customers need the speed layer on top of
    persona? Both A2 + A3 recommend **v1.1** (persona-only covers the common case;
    speed is a power-user refinement).
- **Naming:** api-types `behavioral_profile`/`BehavioralProfileSchema` = the PERSONA
  enum; the harness/shared-schema `BehaviorProfile` = the SPEED axis. A3 fixed their
  stale comment (W784). When the speed axis is exposed (v1.1), name the new field/
  type `SpeedProfile` to end the collision cleanly.

## A2 follow-ups (in scope, non-gated)

- `profiles.ts` comment marking `PROFILE_CATALOGUE` non-canonical (done this wave).
- If a server-side behavioral need ever arises, align the TS lib TO the shared
  JSON shape (don't fork a third model) — not needed for v1.0.

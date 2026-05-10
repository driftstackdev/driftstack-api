# V-530-534 batch verification — Track B real-implementation state

**Date:** 2026-05-11
**Wave:** 22
**Status:** VERIFICATION — consolidates Track B real-implementation
slices across V-530, V-531, V-532, V-533 (V-534 not yet started).

## Purpose

V-530 / V-531 / V-532 / V-533 each moved one Phase-3 package from
stub-mock state into real-implementation state across Waves 15-21.
This doc verifies the cumulative state + flags remaining sub-slices

- confirms tests + interfaces are stable.

## Slice state matrix

| V-NNN   | Package                | Sub-slice landed                                              | Status                        | Tests added |
| ------- | ---------------------- | ------------------------------------------------------------- | ----------------------------- | ----------: |
| V-530.A | behavioural-simulation | touch event distributions (Wave 15)                           | ✅ LANDED                     |          15 |
| V-530.B | behavioural-simulation | scroll velocity profiles (Wave 16)                            | ✅ LANDED                     |          19 |
| V-530.C | behavioural-simulation | dwell + region-aware click position (Wave 19)                 | ✅ LANDED                     |          18 |
| V-530.D | behavioural-simulation | idle-period jitter + multi-touch sequencing                   | ⏳ DEFERRED                   |           — |
| V-531.A | webrtc-streaming       | FrameSource + EncodePipeline + cross-agent contract (Wave 17) | ✅ LANDED                     |          14 |
| V-531.B | webrtc-streaming       | real codec (libvpx / openh264) wiring                         | ⏳ DEFERRED (cross-agent dep) |           — |
| V-532.A | recipe-library         | navigation flows: search + paginated listing (Wave 18)        | ✅ LANDED                     |          11 |
| V-532.B | recipe-library         | login + fill-form builders (Wave 21)                          | ✅ LANDED                     |          10 |
| V-532.C | recipe-library         | infinite-scroll + cart + checkout                             | ⏳ DEFERRED                   |           — |
| V-532.D | recipe-library         | multi-step wizard with branch-on-state                        | ⏳ DEFERRED                   |           — |
| V-533.A | recapture-automation   | matrix runner + dedup + cross-agent contract (Wave 20)        | ✅ LANDED                     |          17 |
| V-533.B | recapture-automation   | atlas builder service API                                     | ⏳ DEFERRED                   |           — |
| V-533.C | recapture-automation   | admin routes + HTTP transport                                 | ⏳ DEFERRED                   |           — |
| V-534   | gui-client             | Tauri scaffold deepen                                         | ⏳ NOT STARTED                |           — |

**Tests added across V-530-533:** 15 + 19 + 18 + 14 + 11 + 10 + 17 = **104**.
Suite was 1325 (baseline at Wave 14 close) → 1429 at Wave 21 close. The
+104 from V-530-533 fully accounts for the suite growth across Waves
15-21; all other slices were docs / branches / hooks / scripts.

## Per-package state

### behavioural-simulation (V-530)

Status: **3 of 4 sub-slices landed**. The package now ships:

- 7 element classes with per-class touch event distributions
  (V-530.A).
- Per-class scroll velocity profiles with exponential decay
  (V-530.B).
- 3 dwell-time shapes + 1-2 click-regions per class with weighted
  sampling (V-530.C).

Stable interface: `BehaviouralSimulator` interface unchanged since
V-530.A added `generateTouchEvent`; V-530.B added
`generateScrollVelocityProfile`; V-530.C added
`generateRegionAwareTouchEvent` (and types). All deterministic +
seeded; no `Math.random()` in any module.

Cross-package consumers: none yet (other packages don't import
behavioural-simulation directly; consumers are GUI client +
recipe-runner integration in later waves).

### webrtc-streaming (V-531)

Status: **1 of 2 sub-slices landed**. The package ships:

- `FrameSource` interface + `MockFrameSource` reference impl
  (V-531.A).
- `EncodePipeline` with pass-through "raw" codec; production codec
  wiring deferred.
- Cross-agent contract published — Agent 1 implements
  `WkWebViewFrameSource` against the interface; the contract doc
  defines the IPC envelope shape.

V-531.B blocked on Agent 1's WkWebViewFrameSource impl + a real codec
dependency decision (libvpx vs openh264; the FrameSource interface is
codec-agnostic so the swap is non-breaking).

### recipe-library (V-532)

Status: **2 of 4 sub-slices landed**. The package ships:

- V-532.A navigation flow recipes (search + paginated-listing) + 3
  builder helpers (`navigateAndWait`, `tapAndWait`, `typeInto`).
- V-532.B form-interaction recipes (login + fill-form builders) + 2
  reference recipes.

Stable interface: `Recipe` / `RecipeStep` types unchanged since V-127
mock landed. All new recipes compose existing step kinds (navigate /
wait / tap / type / capture). No interface changes needed for V-532.C
or V-532.D either — the existing step types cover the recipe set.

### recapture-automation (V-533)

Status: **1 of 3 sub-slices landed**. The package ships:

- V-179 per-run + per-comparison primitives (pre-existing).
- V-533.A matrix orchestration: `expandCaptureMatrix` +
  `dedupComparisons` + `groupComparisonsByCategory` +
  `summarizeComparisons`.
- Cross-agent contract published — Agent 1's WebKit fork worker
  consumes queued runs.

V-533.B atlas builder + V-533.C admin routes deferred.

### gui-client (V-534)

Status: **not started**. Existing scaffolding at `apps/gui-client/`
is Tauri-based per CLAUDE.md spec. V-534 was queued for Wave 21 per
the original directive but deferred when V-542 took its P-track slot.
V-534.A (deep-link handler shell OR license-validation stub) remains
a high-value Track B slice for a future wave.

## Test-suite coverage

`npx vitest run` returns **1429/1429 pass across 131 test files** as of
HEAD `8f5fa5e` (Wave 21). Breakdown of Track B package contributions
this overnight window:

- `packages/behavioural-simulation/tests/`: 7 mock + 15 V-530.A + 19
  V-530.B + 18 V-530.C = **59 tests** (was 7 at Wave 14 close).
- `packages/webrtc-streaming/tests/`: 9 mock + 14 V-531.A = **23
  tests** (was 9 at Wave 14 close).
- `packages/recipe-library/tests/`: 8 mock + 11 V-532.A + 10 V-532.B =
  **29 tests** (was 8 at Wave 14 close).
- `packages/recapture-automation/tests/`: 9 mock + 17 V-533.A = **26
  tests** (was 9 at Wave 14 close).

Track B test-count delta: 104 new tests across 4 packages.

## Interface stability

Every interface extension across V-530-533 was additive — no breaking
changes to existing surfaces. Existing mocks remain implementing every
interface they previously implemented; new methods were added with
real implementations + maintained mock parity.

Verified by `grep -r "implements (BehaviouralSimulator|WebRtcStreamingService|RecipeRunner|RecipeRegistry|RecaptureService)" packages/` — only the package's own MockX class implements each interface, and each MockX gained the new method when an interface added one.

## Cross-agent dependencies outstanding

| Slice   | Repo                 | Agent 1 work needed                                                                                                            |
| ------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| V-531.B | webrtc-streaming     | Real `WkWebViewFrameSource` in webkit-driftstack implementing the V-531 contract.                                              |
| V-533.C | recapture-automation | Fork-side capture worker that consumes `RecaptureService.listRuns({status: 'queued'})` + calls `recordComparison` per surface. |

Both are documented at:

- `docs/internal/v531-cross-agent-contract.md`
- `docs/internal/v533-cross-agent-contract.md`

Agent 1 picks these up in coordination with the contract docs.

## Verification

- `npx vitest run` — 1429/1429 pass (Wave 21 close).
- `npx tsc --build` — clean across workspace.
- Per-package tests cross-checked by running each package's
  `tsconfig.json` build individually + the matching vitest filter.
- Interface-stability claim verified by grep across `packages/`.
- This document committed to docs/internal/ — internal-private cluster
  per V-524, will not reach public-visible scope until V-526.B sweep +
  V-528 privatization land.

## What's queued for next waves

- **V-530.D** — idle-period jitter + multi-touch gesture sequencing
  (closes V-530 series).
- **V-531.B** — real codec wiring (blocked on Agent 1).
- **V-532.C / V-532.D** — cart/checkout + multi-step wizard recipes.
- **V-533.B / V-533.C** — atlas builder + admin routes.
- **V-534.A** — gui-client deep-link handler shell (the only Phase-3
  package that hasn't started real implementation this overnight
  window).

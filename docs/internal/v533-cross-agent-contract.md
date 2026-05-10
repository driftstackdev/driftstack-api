# V-533 — cross-agent contract: recapture orchestration

**Date:** 2026-05-10
**Wave:** 20
**Status:** STAGED — orchestration primitives in
`packages/recapture-automation/src/matrix.ts`; fork-side capture worker is
Agent 1's scope.

## Purpose

V-179 shipped the per-run + per-comparison primitives
(`RecaptureService`, `RecaptureRun`, `FingerprintComparison`). V-533
adds the matrix-level orchestration: fan out a multi-archetype recapture
across (archetype × ios-version × surface) tuples, dedup, and (in
V-533.B) aggregate completed runs into a per-archetype atlas.

The actual capture work — opening a WKWebView, navigating to each file-
121 surface URL, extracting the fingerprint value — lives on Agent 1's
side in the webkit-driftstack fork. This repo provides the
**orchestration service Agent 1 calls into**, never the capture code
itself.

## Cross-agent scope

| Agent | Repo                              | Responsibility                                                                                                                                                                                                                                          |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | `driftstack-api` (this repo)      | Orchestration: `RecaptureService` (V-179) + matrix runner (V-533.A) + atlas builder (V-533.B). Maintains per-run state, dedups comparisons, aggregates atlases for admin-panel display.                                                                 |
| 1     | `webkit-driftstack` (sister repo) | Fork-side capture worker: consumes queued runs from `RecaptureService.listRuns({status: 'queued'})`, walks file-121 surfaces against each archetype, calls `RecaptureService.recordComparison()` for each surface, calls `finalizeRun()` on completion. |

Per Rule G, this repo (Agent 2) does NOT touch the webkit-driftstack
repo. Agent 1 picks up the worker implementation in coordination with
this contract.

## Call protocol

```
                                       ┌─────────────────────────────┐
                                       │  Agent 2: driftstack-api    │
                                       │                             │
                                       │  RecaptureService           │
                                       │  + matrix runner            │
                                       │  + atlas builder            │
                                       └──────────┬──────────────────┘
                                                  │
                       (1) admin triggers a matrix recapture
                                                  │
                       expandCaptureMatrix(spec)  │
                          → N TriggerRecaptureOpts│
                       ↓                          │
                       N × triggerRecapture()     │
                                                  │
                                                  ↓
              ┌──── status='queued' runs queryable via listRuns() ────┐
              │                                                       │
   (2) Agent 1 worker polls listRuns({status: 'queued'}) periodically │
              │                                                       │
              ↓                                                       │
   ┌──────────────────────────────┐                                   │
   │ Agent 1: webkit-driftstack   │                                   │
   │                              │                                   │
   │  for each queued run:        │                                   │
   │    open WKWebView            │                                   │
   │    for each surface in       │                                   │
   │      file-121 catalogue:     │                                   │
   │      capture value           │                                   │
   │      → recordComparison()    │ ─── HTTP/IPC ──→ Agent 2          │
   │    finalizeRun(completed)    │ ─── HTTP/IPC ──→ Agent 2          │
   └──────────────────────────────┘                                   │
                                                                      ↓
                                       (3) admin reviews atlas
```

## Transport

Today, the `MockRecaptureService` lives in-process for tests. Production
transport between Agent 1's fork worker and Agent 2's control-plane
`RecaptureService` impl is HTTP via the admin API surface — `/v1/admin/
recapture/runs/*` endpoints (NOT YET IMPLEMENTED; deferred to V-533.C).

Until those endpoints land, the matrix runner ships as a library Agent
2 can call from a one-off script that drives the existing mock service.
Agent 1's worker stays a manual operator process. Both layers will swap
to the HTTP transport when V-533.C ships the admin routes.

## Matrix runner contract

`expandCaptureMatrix(spec)` produces a deterministic, order-preserving
list of `TriggerRecaptureOpts`:

```ts
const spec: CaptureMatrixSpec = {
  archetypeIds: ['iphone16pro_ios18_7_safari26_4' /* … */],
  baselineVersion: { iosVersion: '18.7', safariVersion: '26.4' },
  targetVersion: { iosVersion: '18.8', safariVersion: '26.5' },
  trigger: 'ios_version_bump',
  reason: 'Apple release notes 2026-08-01 announced iOS 18.8',
};

const optsList = expandCaptureMatrix(spec);
for (const opts of optsList) {
  await recaptureService.triggerRecapture(opts);
}
```

After fan-out, the N runs queue in status `'queued'`. Agent 1's worker
consumes them.

## Dedup contract

`dedupComparisons(comparisons)`: when the atlas builder (V-533.B) merges
per-run comparison lists into a per-archetype reference set, duplicate
`(surfaceId, outcome, baselineValue, recapturedValue)` tuples collapse
to a single entry. The first occurrence wins; subsequent are dropped.
`notes` field is NOT part of the dedup key — two runs with identical
semantic outcomes but different operator notes collapse to one.

This matters because:

- The atlas builder may combine baseline-run + verification-run
  comparison lists into a single atlas — without dedup, surfaces that
  legitimately matched twice appear duplicated.
- Operator-triggered manual reruns produce a second comparison record
  per surface; dedup keeps the atlas correct.

## Summary / grouping helpers

- `summarizeComparisons(list)` → counts per outcome type. Used by the
  admin-panel pivot table.
- `groupComparisonsByCategory(list)` → splits by file-121 category
  prefix (everything before the first dot in `surfaceId`). Used to
  produce per-category match/diff/error tables for the admin atlas
  view.

## Sub-slices

- **V-533.A (THIS WAVE):** matrix runner + dedup + summary/grouping +
  cross-agent contract (this doc).
- **V-533.B (later):** atlas builder service API. Aggregates completed
  runs across an archetype × ios-version-axis into a single readable
  atlas. Likely lives as `AtlasBuilder` class + `buildAtlas(opts)` →
  `ArchetypeAtlas` type.
- **V-533.C (later):** admin routes — `/v1/admin/recapture/runs` GET +
  POST + `/v1/admin/recapture/atlas/{archetypeId}` GET. Production HTTP
  transport between Agent 1 worker + Agent 2 service.

## Change-management protocol

ANY change to the orchestration surface that affects how Agent 1's
worker calls in (e.g. renaming `recordComparison` or changing its
shape) requires a coordinated commit pair — one in this repo, one in
webkit-driftstack — referencing the same V-533-update slice.

The matrix runner + dedup are internal to this repo — Agent 1 never
touches them, so changes to those primitives don't trigger the
coordination protocol.

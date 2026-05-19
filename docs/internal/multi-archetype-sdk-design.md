# Multi-archetype SDK design — read-ahead prep

**Date staged:** 2026-05-17 (post-orchestrator-disengage paste)
**Trigger:** Agent 1 Wave 29-360 Item 1 LANDED (Navigator UA
env-route via `DRIFTSTACK_ARCHETYPE_UA_FULL`); items 2-5 incoming.
**Scope:** customer-facing SDK + activation-gate surface for
multi-archetype `session.create({archetype: ...})`. This doc is
the read-ahead — when items 2-5 land, the implementation slots
in same-wave with minimal coordination delay.

**Status:** DESIGN ONLY. No code committed per orchestrator
"do NOT commit yet" directive. The implementation waits on
Agent 1's full items 2-5 set so the archetype IDs + env-var
contract are stable across the agent boundary before customer
code depends on them.

## Archetype IDs (per Wave 29-358 verdict + orchestrator paste)

Three launch archetypes:

| Archetype ID                     | Family | Launch role                        |
| -------------------------------- | ------ | ---------------------------------- |
| `iphone16pro_ios18_6_safari18_6` | A      | iOS 18.6 / Safari 18.6 reference   |
| `iphone16pro_ios18_7_safari26_4` | B      | LAUNCH DEFAULT (current reference) |
| `iphone17_ios18_7_safari26_4`    | B      | iPhone 17 variant                  |

Default when the customer doesn't pass `archetype`:
`iphone16pro_ios18_7_safari26_4`.

Family A is production-viable per Wave 29-356.1 — no
experimental gate needed (per orchestrator paste). Both families
ship at v1.0.

### Contingent 4th archetype — `iphone17_ios18_7_safari26_5`

Per orchestrator Wave 29-367 paste 2026-05-17 ~19:30Z, if Agent
1's BS-pool diagnostic confirms Safari 26.5 shipped mid-May and
the BS host pool rolled past 26.4 entirely, Safari 26.5 becomes
a launch-blocking concern that supersedes the Family-B-only
V-583K rebuild plan. In that scenario the launch family grows
to 4 archetypes:

- `iphone16pro_ios18_6_safari18_6` (Family A)
- `iphone16pro_ios18_7_safari26_4` (Family B launch default)
- `iphone17_ios18_7_safari26_4` (Family B iPhone 17)
- `iphone17_ios18_7_safari26_5` (Family B iPhone 17, Safari 26.5)

The SDK union + dashboard selector + cross-SDK enum parity test
should be sized for 4 entries when the implementation fires, so
adding the 4th literal is a one-line diff if Agent 1's diagnostic
returns scenario 1. DON'T pre-emptively add the 4th literal —
wait for Agent 1's diagnostic finding.

The marketing M.6 Path A copy currently names "Safari 26.4 and
Safari 26.5 as it rolls out" so the customer-facing copy is
already forward-compatible with the 4-archetype family. No
marketing follow-up if the 4th archetype lands.

## SDK shape across TS / Python / Go

### TypeScript

```ts
// In packages/sdk-typescript/src/resources/sessions.ts:

export type Archetype =
  | 'iphone16pro_ios18_6_safari18_6'
  | 'iphone16pro_ios18_7_safari26_4'
  | 'iphone17_ios18_7_safari26_4';

export interface CreateSessionRequest {
  // ... existing fields ...
  /**
   * Device archetype the session emulates. Default
   * `iphone16pro_ios18_7_safari26_4` (Family B launch
   * archetype). Family A (`iphone16pro_ios18_6_safari18_6`)
   * is also production-viable per Wave 29-356.1.
   */
  archetype?: Archetype;
}
```

Export `Archetype` from `src/index.ts` barrel.

### Python

```python
# In packages/sdk-python/src/driftstack/resources/sessions.py:

from typing import Literal

Archetype = Literal[
    "iphone16pro_ios18_6_safari18_6",
    "iphone16pro_ios18_7_safari26_4",
    "iphone17_ios18_7_safari26_4",
]
```

Both `SessionsResource.create()` and `AsyncSessionsResource.create()`
accept `archetype: Archetype | None = None` and pass it through
when not None. Default applied server-side.

### Go

```go
// In packages/sdk-go/sessions.go:

type Archetype string

const (
    ArchetypeIphone16ProIos18_6Safari18_6 Archetype = "iphone16pro_ios18_6_safari18_6"
    ArchetypeIphone16ProIos18_7Safari26_4 Archetype = "iphone16pro_ios18_7_safari26_4"
    ArchetypeIphone17Ios18_7Safari26_4    Archetype = "iphone17_ios18_7_safari26_4"
)

type CreateSessionRequest struct {
    // ... existing fields ...
    Archetype Archetype `json:"archetype,omitempty"`
}
```

Go uses an enum-like string type with named constants so
customers get autocomplete + compile-time safety.

## Cross-SDK invariant test extension

Extend `sdk-client-constructor-cross-sdk-parity.test.ts` or
create a NEW test
`apps/server/tests/unit/sdk-archetype-enum-cross-sdk-parity.test.ts`:

- Read the 3 archetype IDs from a canonical source-of-truth
  constant (server-side `packages/api-types/src/archetypes.ts`)
- Assert each ID appears in:
  - TypeScript: `packages/sdk-typescript/src/resources/sessions.ts`
    `export type Archetype = ...`
  - Python: `packages/sdk-python/src/driftstack/resources/sessions.py`
    `Archetype = Literal[...]`
  - Go: `packages/sdk-go/sessions.go` `Archetype` const block

The canonical constant lives in `@driftstack/api-types` so the
server-side route validator + 3 SDKs all reference the same
list. Drift on any SDK fails the test at CI time.

## Server-side preflight (when Agent 1 items 2-5 land)

Before the SDK lift, the server needs:

1. **`packages/api-types/src/archetypes.ts`** — Zod enum + TS
   union export for the 3 archetype IDs.
2. **`apps/server/src/services/sessions.ts`** — validate the
   request body's `archetype` field against the Zod enum;
   default to `iphone16pro_ios18_7_safari26_4` when absent.
3. **Driver-side env-var threading** — `SessionsService.create`
   passes the resolved archetype id through to the driver's
   `createSession()`. The driver maps archetype → env vars
   (`DRIFTSTACK_ARCHETYPE_UA_FULL` for Item 1, plus items 2-5
   when they land). Mock driver returns the value verbatim so
   integration tests can assert it.
4. **Session record persistence** — the existing
   `apps/server/src/db/schema.ts` `sessions` table needs an
   `archetype` column (text NOT NULL, defaulted to the launch
   archetype id). New migration `0045_session_archetype.sql`.

## Dashboard archetype-selector (deferred per Option D)

The customer-dashboard wire (UI selector in the session-create
flow) is a separate slice from the SDK lift. Outline below
captures it as Option D from the orchestrator paste:

- Dropdown selector populated from the SDK's exported
  `Archetype` union.
- Default highlights `iphone16pro_ios18_7_safari26_4` (launch
  default).
- Inline tooltip explains the family difference (A = iOS 18.6
  reference; B = iOS 18.7 + Safari 26.4 launch family).
- No "experimental" badge on Family A per Wave 29-356.1
  verdict.
- Per-session selection persists in the session record (not
  per-account default — customers may legitimately want to run
  different archetypes per session).

## Coordination contract with Agent 1

The bridge between Agent 2 (server config) and Agent 1 (WebKit
fork) is a set of `DRIFTSTACK_ARCHETYPE_*` env vars that the
driver passes to the WebKit child process. Item 1 landed
`DRIFTSTACK_ARCHETYPE_UA_FULL` (Navigator UA string per
archetype). Items 2-5 will likely cover:

- Screen / WebGL / canvas / audio context — the other
  Phase 2 / Phase 3 / Runtime signal paths per file 105.

Agent 2's SDK + server-side validator should NOT know the
internal env-var contract beyond "the archetype ID is a stable
discriminator". When the customer passes `archetype: 'X'`, the
driver maps `X` → the env-var set; the SDK never sees the env-
var names directly.

This keeps the cross-agent contract narrow: archetype IDs are
the shared vocabulary, not the env-var names.

## Implementation gate

Implementation fires when:

- Agent 1 commits Items 2-5 of Wave 29-360.
- The full env-var contract per archetype is documented in
  `docs/internal/cross-agent-control-plane-contract.md`.
- The 3 archetype IDs in this doc match Agent 1's actual
  archetype IDs in the WebKit fork (verify before committing
  the SDK lift — pre-narrowing risks customer-code breakage).

Once items 2-5 land, the implementation order:

1. Server-side: migration 0045 + Zod enum in api-types +
   SessionsService validation + driver env-var mapping (~150 LOC).
2. SDK cross-lift: TS + Python + Go in lockstep (~120 LOC each
   = ~360 total, following the Q.5.d pattern).
3. Cross-SDK archetype-enum parity test.
4. CHANGELOG entries across 3 SDKs.
5. OpenAPI: add `archetype` to the CreateSessionRequest schema.
6. Dashboard archetype-selector UI (Option D follow-up).
7. Marketing copy already shipped via M.6 Path A — verify
   per Option B no warm-up framing leaked through.

Estimated wall-clock from "Agent 1 items 2-5 land" to "SDK
shipped + tested + documented": ~3-4 hours.

## References

- Wave 29-358 verdict + multi-archetype scope: orchestrator
  AUTO #3 paste 2026-05-17 + Wave 29-360 Item 1 landing paste
  2026-05-17 18:38 UTC
- Agent 1 STATE.md: `04bb2f79` (V-405 22.9× breakthrough
  context that drove the v1.0 multi-archetype scope expansion)
- M.6 Path A marketing copy: commit `df0883fe` (multi-archetype
  framing across index.astro + comparison.astro + roadmap.astro
  - trust/cumulative-rig.astro)
- Cross-SDK lift pattern reference: commit `2499970a` (Q.5.d
  RecipesResource lift) + `eb1c3f8e` (Q.5.e cross-SDK tests)
- v2 warm-up arc PARKED: memory `project_v2_warmup_parked.md`
- Q.5.d archetype-enum parity precedent: the existing
  `LOCKED_ARCHETYPE_ID = 'iphone16pro_ios18_7_safari26_4'`
  constant in the comparison-page parity test.

## 2026-05-20 status update — Agent 1 progress

Quick check on Agent 1's `/Users/john/code/driftstack` repo
since this design was staged 2026-05-17:

- Wave 29-402 §11 (commit `27e080da`) — **iPhone 17 archetype
  data LOCKED + BS capture PASS**. The third archetype's data
  pack is live + BrowserStack validation green; the data shape
  the SDK union needs is now stable.
- Wave 29-399 §6.A + §6.B + §7 — auto-learn pipeline closed
  end-to-end; not directly multi-archetype but unblocks the
  shared atlas-priority storage all 3 archetypes will share.

What's still pending fork-side before the SDK union ships
(items 2-5 referenced above):

- iPhone 17 archetype WebKit-fork integration (env-route +
  JSC patch parameter pass).
- iPhone 16 Pro iOS 18.6 / Safari 18.6 archetype (Family A
  reference) WebKit-fork integration.
- Per-archetype canvas atlas v3 / v4 build pipeline (running
  for archetype B; needs replication for archetype A + iPhone
  17 archetype).
- Driver env-var per-archetype routing (`DRIFTSTACK_ARCHETYPE`
  branch in MockDriver + WebKitDriver).

When Agent 1 lands all of those, this SDK union slice fires
without further coordination — the design doc above is the
complete spec.

Agent 2 side already in place:

- api-types `archetype` field type stub ready to extend with
  the 3-value union literal.
- SessionsService accepts an arbitrary archetype ID today (no
  Zod enum gate yet — gate lands with the SDK union).
- Dashboard archetype selector UI placeholder slots into the
  /agent-sessions/[id].astro mode toggle's neighbouring header
  (sub-slice 8.5 already wires `mode: 'manual'|'ai'|'pair'`
  with the same shape).
- Marketing copy multi-archetype framing already shipped
  (M.6 Path A, commit `df0883fe`).

Coordination memory updated:
`project_multi_archetype_coordination_queued.md` reflects the
2026-05-20 status — Agent 1 ~50-70% through items 2-5; SDK
slice still gated.

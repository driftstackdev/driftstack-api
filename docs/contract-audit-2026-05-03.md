# Public-surface contract audit — 2026-05-03

Triggered by V-032 drift (coordinate primitives in `InteractActionSchema`).
Founder direction: read every public schema + every customer-facing
SDK method across TS / Python / Go before paying customers exist;
flag intent-vs-mechanic violations, required-vs-optional correctness,
deprecation paths, version-bump rule clarity, marshalling round-trip
test coverage.

Audit method: full read of `packages/api-types/src/*.ts`, the three
language SDKs' public surfaces, and their existing test coverage.

## Findings

### CRITICAL — fixed in this pass

1. **Go SDK `WaitCondition.Kind` shipped as `"time_ms"`** but the
   Zod schema (and TS / Python SDKs) use `"time"`. Every Go customer
   call to `client.Wait(NewTimeCondition(...))` would have been
   silently rejected by the server's discriminated-union parser
   with a 400. **Fix landed:** `packages/sdk-go/types.go:261` →
   `Kind: "time"`. Comment on line 242 also corrected.

2. **Go SDK `NavigateRequest` was missing `timeout_ms`.** The Zod
   schema accepts an optional `timeout_ms` in the 1000–120000 range
   (`packages/api-types/src/sessions.ts:61`). TS / Python SDKs both
   expose it; Go customers had no way to set it. **Fix landed:**
   `packages/sdk-go/types.go:178` → added `TimeoutMS int
   \`json:"timeout_ms,omitempty"\``.

Both fixes ride out as `Go SDK 0.1.3` (tag `packages/sdk-go/v0.1.3`).
Same shape as V-032's silent-noop scroll fix — pre-1.0, zero
customers, breaking is fine.

### CRITICAL — test-coverage gap (closed in this pass)

3. **TS and Python SDKs had no marshalling round-trip tests.** Go
   shipped `types_test.go` in V-032; TS and Python had no equivalent.
   Both bugs above would have been caught instantly by a wire-shape
   test that asserted `kind: "time"` (not `"time_ms"`) and that
   `NavigateRequest` round-trips with `timeout_ms`. **Fix landed:**
   - `packages/sdk-typescript/tests/unit/wire-shape.test.ts` (13
     tests covering InteractAction × 5 variants, WaitCondition × 4
     variants, NavigateRequest, plus L-001 rejection assertions for
     `tap_at` / `type_focused`).
   - `packages/sdk-python/tests/test_wire_shape.py` (10 tests,
     same coverage).
   - `packages/sdk-go/types_test.go` extended with `WaitCondition`
     constructor tests and a `NavigateRequest` round-trip test.

   **All three SDKs now lock in the canonical wire shape against
   regression.** A typo in any future schema change fails fast
   in the SDK's own test suite, not silently in the customer's
   production traffic.

### MEDIUM — surface to founder

4. **`InteractAction.tap.offset` is a borderline mechanic.** The
   `offset: { x, y }` field on the tap variant
   (`packages/api-types/src/sessions.ts:88-89`) lets the customer
   shift the tap by N pixels relative to the element's center. It's
   intent-adjacent ("I want to tap the lower-right of this element")
   but also coordinate-adjacent ("click at this exact pixel"). At
   high `offset` values it functionally becomes `tap_at` with extra
   steps. **Recommendation:** Decide before any customer ships. Two
   options:
   - **Keep** — document `offset` as bounded (e.g. cap at ±50px,
     reject larger offsets at validation). Genuine intent-only
     positioning ("upper-right corner of the button").
   - **Remove** — fold positional intent into selectors instead
     (`button.primary > .icon-arrow`). Tighter L-001 alignment.
   No fix today; flagged for founder decision.

5. **TypeScript SDK has no CHANGELOG / version-bump documentation.**
   Python and Go both have `CHANGELOG.md` files declaring
   "Keep a Changelog + SemVer". TS SDK has neither. **Recommendation:**
   add `packages/sdk-typescript/CHANGELOG.md` mirroring the Python
   shape. Cheap, clarity-preserving. No fix today (would be one-shot;
   raise during the next packaging-related session).

### LOW — defer

6. **`packages/api-types/src/admin.ts:82` — `ListDlqQuerySchema.limit`
   is `.coerce.number()` without explicit `.optional()`,** relying
   on `.default(50)` for absence. Works today; would silently break
   if a future change removes the default. Pure code-smell, not a
   correctness issue. Leave.

7. **`drizzle-kit@0.30.6` blocks auto-generation of migrations.**
   Wrote `0004_gui_input_event_type.sql` + snapshot/journal by hand
   in V-036 because `npx drizzle-kit generate` errored out
   (`Please install latest version of drizzle-orm`). Bump
   drizzle-kit when there's a clean window. Not blocking.

### NEGATIVE FINDINGS — clean

- **No L-001 violations on the customer-facing surface** beyond the
  V-032 drift (already re-cut in V-036).
- **Required-vs-optional fields look correct** across api-types
  schemas. Nothing flagged where an optional field's absence would
  make a request meaningless.
- **No deprecation candidates** in the current 0.1.x surfaces.
  Every existing endpoint is load-bearing.

## L-001 enforcement check

Walk through every `*Schema` in `packages/api-types/src/`:

- `accounts.ts` — Account, AccountTier, AccountStatus. Pure
  metadata; no mechanics. ✓
- `admin.ts` — admin endpoints. Internal; gated behind admin scope. ✓
- `api-keys.ts` — ApiKey, CreateApiKeyRequest. Scopes are now
  `read | write | admin | gui_control` — see V-036 follow-up note
  about gating gui_control on enterprise tier. ✓
- `common.ts` — IDs, Iso8601, ApiKeyScope, AccountTier. ✓
- `problem.ts` — RFC 7807 error shapes. ✓
- `sessions.ts` — InteractAction (intent-only ✓ post-V-036),
  NavigateRequest (intent: "go to URL, wait until load"),
  WaitCondition (intent: "wait until element appears"),
  CaptureRequest (intent: "screenshot / DOM / PDF"). ✓
- `usage.ts` — period summaries, usage counters. ✓
- `webhooks.ts` — webhook endpoints, deliveries, signatures. ✓

No mechanic-level primitives on the customer-facing surface.
`offset` on `InteractAction.tap` flagged as borderline above.

## Marshalling round-trip test coverage — final state

| SDK     | File                                              | Variants covered | Status post-audit |
|---------|---------------------------------------------------|------------------|-------------------|
| TS      | `tests/unit/wire-shape.test.ts`                   | InteractAction × 5, WaitCondition × 4, NavigateRequest, L-001 reject × 2 | ✅ landed today |
| Python  | `tests/test_wire_shape.py`                        | InteractAction × 5, WaitCondition × 3, NavigateRequest + bounds, L-001 reject × 2 | ✅ landed today |
| Go      | `types_test.go`                                   | InteractAction × 4, WaitCondition × 4, NavigateRequest | ✅ extended today |

## Top 3 to surface to founder

1. **Two Go SDK silent-noop bugs fixed in this pass.** WaitCondition
   `time_ms` → `time` (every wait call rejected); NavigateRequest
   missing `timeout_ms` (no way to override server default).
   Republished as Go 0.1.3 (tag `packages/sdk-go/v0.1.3`). Same
   class as V-032's scroll bug; pre-1.0, zero customers.

2. **`tap.offset` decision needed.** Keep with bounds, or remove?
   Borderline L-001 case. No fix today.

3. **TypeScript SDK needs a CHANGELOG.** Python and Go have one;
   TS doesn't. Cheap follow-up.

## Status

Contract audit done. All public surfaces match the L-001 lock and
the canonical wire shape. The class of bug that produced V-032's
scroll silent-noop and the Go `time_ms` silent-noop is now caught
locally in all three SDKs by wire-shape tests.

Next: entity-org transition prep (KvK 2026-05-21).

# Slice 6 — LK.6.d cross-surface progress note (2026-05-20)

**Status:** PARTIAL — modifier vocabulary aligned across both
surfaces (gui-client + customer-dashboard); coordinate-scaling
unification deferred until customer-dashboard has a live
`<video>` element to scale against.

## What landed today (commit `21e0639a`)

`apps/gui-client/src/lib/livekit-input-capture.ts:modifiersFromEvent`
previously emitted DOM-standard names (`Shift / Control / Alt /
Meta`); `apps/customer-dashboard/src/pages/agent-sessions/
[id].astro` inline `modifiersFromEvent` emitted Mac-native
(`cmd / ctrl / shift / option`). Server `InputEventSchema`
accepts both — `modifiers: z.array(z.string())` — so neither
failed validation; but the Mac harness decoder downstream would
have to recognize both forms.

Locked on `cmd / ctrl / shift / option` (1:1 Quartz CGEventFlags
on the harness side) since customer-dashboard already used it.
Cross-surface parity test
(`apps/server/tests/unit/lk6-modifier-vocabulary-cross-surface-
parity.test.ts`) negatively guards against either surface
drifting back to the DOM-standard names.

## What's still ahead

### 1. Coordinate-scaling unification (deferred)

`apps/gui-client/src/lib/livekit-input-capture.ts:
pointerToViewport` scales pointer coords by `videoWidth /
rect.width` so the Mac side receives video-intrinsic logical
px. The customer-dashboard inline `viewportCoords` returns raw
rect coords (no scaling) because there's no `<video>` element
to scale against yet — the overlay is a transparent
click-capture div positioned where a video will eventually
mount.

**When LiveKit JS SDK injects the video element** (intent per
the page comment "LiveKit JS SDK wire-up follows in Slice 4"
— Slice 4 has shipped but the JS-side LiveKit wire is still
pending the harness end-to-end work):

1. customer-dashboard needs to find the video element + scale
   coordinates by `videoWidth / rect.width` (matching
   gui-client's form).
2. The parity test should extend to assert both surfaces do
   the same scaling math.

This change is bounded but gated on the LiveKit video element
actually existing — that's the harness end-to-end Agent 1 work
(6-9wks per founder verdict 2026-05-19).

### 2. Lifting helpers into a shared package

The 3 helpers (`pointerToViewport / modifiersFromEvent /
mouseButton`) total ~40 LOC. Lifting into a shared package
(`packages/livekit-helpers/` or extending an existing
package) avoids the copy-paste between gui-client + customer-
dashboard. The blocker: customer-dashboard is Astro
client-side `<script>` inline JS — it can't directly import
from a workspace TS package without an Astro-side build
config change to expose the package as a browser bundle.

Lowest-impact path: keep both as inline copies for now;
enforce vocabulary parity via the cross-surface test (done
today). Lift when the customer-dashboard gains a real TS
client bundle entry point (post-launch infrastructure work).

### 3. Recipe-integration scope

The original Slice 6 directive called out "cross-SDK + recipe
integration." Recipes (file 56) are pre-recorded navigation
flows; "integration" likely means a recipe step can include
a "manual override window" where the customer takes over via
the manual-control overlay. Concrete design needed before
implementation — defer until the recipe storage backend +
runtime executor are in scope (currently 503-stub per the
egress card contradiction pattern).

## Where this lives

- `apps/gui-client/src/lib/livekit-input-capture.ts` — TS
  helpers + React hook.
- `apps/customer-dashboard/src/pages/agent-sessions/[id].astro`
  — inline JS copy (Astro `<script>` block).
- `apps/server/tests/unit/lk6-modifier-vocabulary-cross-
surface-parity.test.ts` — drift guard.
- `apps/gui-client/tests/unit/livekit-input-capture-pure.test.tsx`
  — gui-client pure-helper tests (updated for Mac-native
  vocabulary).
- `packages/api-types/src/agent-input-event.ts` — server-side
  schema (vocabulary-agnostic; modifiers stays
  `z.array(z.string())`).

## References

- `docs/internal/2026-05-19-slice-4-input-event-design.md` —
  Slice 4 design doc; calls out Slice 6 as the cross-SDK +
  recipe-integration follow-up.
- Commit `21e0639a` — modifier vocabulary alignment.
- Commit `36e60493` — Slice 4 InputEvent api-types lift.

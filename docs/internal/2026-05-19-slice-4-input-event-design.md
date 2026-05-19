# Slice 4 — POST /v1/agent-sessions/:id/input-event design surface

**Status:** DESIGN (Wave 29-NNN ARC 3 Slice 4 prep). Implementation
queued sequential after Slice 3 (`c18bab90`).

**Verdict locks:**

- A/C/A/A/A founder verdicts on `docs/internal/ai-chat-manual-side-by-side-design.md`
- Q1 = A: SSE transcript + POST `/message` for customer input; POST
  `/input-event` is the parallel channel for raw screen coords from
  ManualControlOverlay (NOT the message composer).
- LK.6.d helpers (`pointerToViewport`, `modifiersFromEvent`,
  `mouseButton`) exist in `apps/gui-client/src/lib/livekit-input-capture.ts`
  — they are pure functions, lift them into a shared package OR
  copy verbatim.

## Surface

```
POST /v1/agent-sessions/:id/input-event
Content-Type: application/json
Authorization: Bearer <api-key OR ds_web_session_token>

{ event: <LK.6 InputEvent> }
```

Where `LK.6 InputEvent` is the 7-variant discriminated union pinned
in `apps/gui-client/src/lib/livekit.ts:23-30`:

- `mouseMove` — `x, y`
- `mouseDown` — `x, y, button: 0 | 1 | 2`
- `mouseUp` — `x, y, button: 0 | 1 | 2`
- `keyDown` — `key, modifiers?: readonly string[]`
- `keyUp` — `key, modifiers?: readonly string[]`
- `wheel` — `x, y, deltaX, deltaY`
- `ping` — `timestamp`

Response shape: `{ ok: true, duration_ms: number }` — mirrors
`/gui-input` for symmetry; the duration measures server-side
dispatch latency only, NOT round-trip to the harness.

## Server-side behaviour

1. **Auth**: `app.requireAuth`; account scoping; the agent-session
   must belong to the calling account.
2. **Status check**: session must be `active`. Closed → 409 Conflict
   `agent-session-not-active`.
3. **Mode check**: `mode ∈ {manual, pair}` required. AI-only mode
   rejects with a typed 409 `mode-rejects-input-event` — the
   directive's "Server-side validation: mode in {manual, pair}".
4. **Rate-limit**: dedicated bucket `agent_sessions:input_event`
   (NOT the generic `global` bucket). Per founder
   verdict-implicit-from-directive client-side cap of ≤120Hz; the
   server bucket should allow ~150 requests/second per session
   (sustained) with burst of 300. Tier-derived cap lands when B3 ships.
5. **Dispatch**: forward the event to the harness via LiveKit
   DataChannel (server-side LiveKit JWT mint + publishData). If the
   session has no `livekit` info (pre-LK Mac fleet OR harness
   end-to-end not wired yet — Tier-3 verdict 2026-05-19 says 6-9wks
   Agent 1 work), return **503 FeatureUnavailable** with detail
   pointing at the harness activation path.
6. **Pair-mode lock interaction**: input-event in pair mode is a
   takeover trigger. If `pair_mode_state.kind === 'ai-driving'`,
   the route MUST fire `takeover-request-queued` (matches the
   sub-slice 8.11 mid-decompose queueing semantics — the route
   knows whether AgentRuntime is mid-flight via the same
   `decompose_in_flight` flag the takeover/handback routes consult).
7. **Audit**: `agent_session.input_event` audit row per request OR
   per-batch (decide at impl time — 120Hz audit-per-request is
   expensive; bucket per 1s).

## Dashboard wiring (`apps/customer-dashboard/src/pages/agent-sessions/[id].astro`)

The existing scaffold from Slice 2 has `ManualControlOverlay` as
a transparent click-capture div over the LiveKit preview area.
Slice 4 expands it:

1. **Lift LK.6.d helpers** into a shared package (proposal:
   `packages/livekit-helpers/`) OR inline-copy verbatim into the
   dashboard's `src/lib/livekit-input-capture.ts`. Inline-copy is
   the safer Slice 4 scope; lifting into a shared package is a
   follow-up refactor under Slice 6 (cross-SDK + recipe
   integration).
2. **Wire pointer events**: `mousemove` / `mousedown` / `mouseup` /
   `wheel` on the overlay → `pointerToViewport` → POST. Throttle
   `mousemove` to ≤120Hz client-side (16.6ms window with leading
   edge fire).
3. **Wire keyboard events**: `keydown` / `keyup` on `document`
   (not just the overlay, since keyboard targets focused element
   not the canvas). Active only when `mode ∈ {manual, pair}` —
   gated by the same condition that toggles `overlay-enabled`.
4. **Optimistic UX**: no client-side success indication; let the
   server's response come back. On 503 (harness not wired), surface
   a one-time toast "Live input requires a Mac fleet node — using
   text-only mode" and silently drop subsequent events.

## Cross-SDK helper signatures

Each SDK gets a 1-method addition mirroring Slice 3's `setMode`:

```typescript
// TS
agentSessions.sendInputEvent(id: string, event: InputEvent): Promise<{ ok: true; duration_ms: number }>
```

```python
# Python
agent_sessions.send_input_event(agent_session_id: str, event: dict) -> dict
```

```go
// Go
SendInputEvent(ctx context.Context, agentSessionID string, event map[string]any) (*InputEventResponse, error)
```

The `InputEvent` type itself moves into `@driftstack/api-types`
(or its Python / Go equivalents) so all three SDKs share the
discriminated-union surface. Today the type lives in the
gui-client; Slice 4 promotes it into the shared types package.

## Tests

### Unit (5+)

1. SetModeRequestSchema validation: 7 valid variants accepted.
2. Invalid variant kind: 400.
3. Invalid mouseDown.button (3) rejected.
4. Wheel deltaX bounded.
5. Keyboard event with too-long key rejected.

### Integration (4+)

1. Manual mode + valid mouseMove → 200; audit row written.
2. AI mode + valid mouseMove → 409 mode-rejects-input-event.
3. Closed session → 409 agent-session-not-active.
4. Pair mode `ai-driving` + valid mouseDown → 200 + state
   transitioned to `takeover-pending` (OR `takeover-queued` if
   runtime mid-decompose).
5. Pre-LK deployment / no livekit field → 503 FeatureUnavailable.
6. Cross-account session → 404.

### Drift guard (1)

The `InputEvent` type union in `packages/api-types/src/agent-input-event.ts`
(new file) must stay in lock-step with the gui-client's local copy
in `apps/gui-client/src/lib/livekit.ts`. Pin via content-parity test
(`apps/server/tests/unit/agent-input-event-cross-surface-parity.test.ts`).

## Scope NOT in Slice 4

- Lifting LK.6.d helpers into a shared `packages/livekit-helpers/`
  package — defer to Slice 6 (cross-SDK + recipe integration).
- Harness-side decoder changes — Agent 1 scope, post §10/§11+EG-WK.
- Server-side LiveKit DataChannel publish — likely a thin wrapper
  over `livekit-server-sdk` Node's `RoomService.sendData()`. If
  that's not available, fall back to 503 with detail pointing at
  harness activation.

## Estimated effort

2-3 days Agent 2 (per the directive). Sequential after Slice 3.

## References

- `docs/internal/ai-chat-manual-side-by-side-design.md` — design doc
  with founder verdicts.
- `apps/gui-client/src/lib/livekit.ts` — LK.6 InputEvent type union.
- `apps/gui-client/src/lib/livekit-input-capture.ts` — LK.6.d
  pure helpers (pointerToViewport / modifiersFromEvent / mouseButton).
- `apps/server/src/schemas/gui-input.ts` — existing /gui-input route
  shape (reference; NOT reused — distinct concern: gui-input is the
  legacy enterprise self-hosted GUI path; input-event is the
  customer-dashboard live-overlay path).
- `services/agent-pair-mode-state.ts` — state machine + transition
  validator (where input-event-as-takeover-trigger plugs in).

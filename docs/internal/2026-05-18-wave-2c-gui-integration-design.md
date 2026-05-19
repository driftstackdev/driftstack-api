# Wave 2.C GUI integration design — 2026-05-18 (v2-#8 sub-slice 8.23)

## Scope

Customer-facing dashboard UI for the v2-#8 AI chat + manual side-by-
side feature. Load-bearing for v1.0 launch differentiator per
founder verdict 2026-05-17 (strategic directives, primary
differentiator + Marketing M.6 Path A).

The server-side surface is fully wired:

- Mode `ai` / `manual` / `pair` on the session (8.5)
- `POST /v1/agent-sessions/{id}/message` (8.6) with mode-aware
  routing (decompose+execute for `ai`, pass-through for `manual`,
  state-machine-gated for `pair`)
- Pair-mode state machine (8.7) + lock (8.8) + takeover/handback
  routes (8.9 / 8.16) + queue edge cases (8.11 / 8.12) +
  heartbeat timeout (8.13b/c/d) + audit (8.20) + metrics (8.18) +
  docs (8.20.d)
- Bundled-LLM consent + soft-cap (6.5/6.7/6.8) + metrics (8.19)
- BYOK Anthropic key path (Q.1.c, v2-#21 TTL)

Wave 2.C wires the customer-visible surface that exercises all of
the above through the dashboard.

## Component inventory

Five new components + one updated layout. All under
`apps/customer-dashboard/src/components/agent-session/`:

### 1. `AgentSessionPanel.astro` (8.24)

Top-level panel rendered on a new page `apps/customer-dashboard/
src/pages/agent-sessions.astro`. Wraps the four sub-components,
manages the active agent-session id state (URL hash
`#agent-session=agt_<id>`), and orchestrates the SSE transcript
stream connection.

Wire surface:

- `GET /v1/agent-sessions` to list the customer's active +
  recent agent-sessions (read-side endpoint exists today; the
  panel lists the most recent 25).
- `POST /v1/agent-sessions` with `{ mode }` to create a new
  one. Defaults to `mode: 'pair'` for the v1.0 differentiator
  pitch (AI drives + customer can take over interactively).

### 2. `ModeSelector.astro` (8.25)

Three-way radio: AI / Manual / Pair. Wired to the POST
agent-sessions request body's `mode` field. Lives at the top of
`AgentSessionPanel`. Customer chooses mode at session-create time
and cannot change it mid-session (the route validates `mode` on
each subsequent message).

Copy:

- **AI** — "Driftstack writes a plan + executes it."
- **Manual** — "You drive every action via the GUI."
- **Pair** — "AI by default; take over with one click." (default)

### 3. `TakeoverHandbackButtons.astro` (8.26)

Pair-mode only — hidden when `mode !== 'pair'`. Two states:

- When `pair_mode_state.kind === 'ai-driving'` or `'takeover-queued'`:
  show "Take over" button. POSTs to /v1/agent-sessions/:id/takeover
  with `{ client_id }` derived from `localStorage.ds_web_session_token`.
  On 409 PairModeStateInvalidTransition, surface the typed error's
  `from` + `transition` to the customer via a toast.

- When `pair_mode_state.kind === 'human-driving'` or `'handback-queued'`:
  show "Hand back" button. POSTs to /v1/agent-sessions/:id/handback
  with empty body.

- When `pair_mode_state.kind === 'takeover-pending'` /
  `'handback-pending'`: show spinner + the queued state name as
  a read-only badge.

### 4. `TranscriptStream.astro` (8.27)

Live SSE consumer for `GET /v1/agent-sessions/:id/transcript`
(8.3). Renders transcript entries with role-specific styling:

- `role === 'user'` — customer's message, right-aligned bubble.
- `role === 'agent'` — plan summary + intents list, left-aligned
  - amber accent.
- `role === 'operator'` — manual-mode customer-driven action,
  left-aligned + slate accent.

Uses the v2-#19 `Last-Event-ID` header for resume after disconnect
(SSE spec; the route honors `Last-Event-ID` for cursor-resume).

### 5. `BundledLlmStatusPanel.astro` (8.28)

Right-rail sidebar rendering the customer's bundled-LLM consent +
cap state from `GET /v1/account/me/bundled-llm-status` (6.7). Shows:

- Consent state — checkbox wired to PATCH /v1/account/me/bundled-
  llm-settings (6.6).
- Monthly cap — number input with 100-cent ($1) step.
- Used this month / remaining this month — derived from the
  /status endpoint (6.7).
- Refused-count — count of bundled-llm-budget-exhausted 402s
  this month (per the v2-#6 wired delivery surface).

### 6. `MessageComposer.astro` (8.28.b — pulled into 8.28)

Bottom-of-panel input + send button. POSTs to
/v1/agent-sessions/:id/message with `{ user_message }`. On 200,
the response is added to the local transcript optimistically (the
SSE stream will also publish it; the optimistic add gives the
customer immediate echo). On 402 BundledLlmBudgetExhausted or 402
BundledLlmConsentRequired, the BundledLlmStatusPanel is highlighted

- the appropriate CTA (raise cap / opt in) is shown.

## Page layout (`agent-sessions.astro`)

```
┌─────────────────────────────────────────────────────────────────┐
│ DashboardLayout                                                 │
│ ┌──────────────────────────────┬──────────────────────────────┐ │
│ │ <AgentSessionPanel>          │ <BundledLlmStatusPanel>      │ │
│ │   <ModeSelector />           │                              │ │
│ │   <TakeoverHandbackButtons />│   consent + cap + used       │ │
│ │   <TranscriptStream />       │                              │ │
│ │   <MessageComposer />        │                              │ │
│ └──────────────────────────────┴──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

Right rail collapses on mobile to a top-of-page banner.

## State management

Single-page Astro + vanilla JS (matches the rest of the dashboard's
non-React posture). Mutable state lives on `document.querySelector(
'[data-page="agent-sessions"]')` as `data-*` attributes:

- `data-active-session-id` — current `agt_<uuid>` or empty
- `data-pair-mode-state` — current state kind discriminator
- `data-bundled-llm-consent` — `true` / `false`
- `data-budget-remaining-cents` — number

SSE EventSource is held in a module-scoped variable; cleanup on
`beforeunload` and on session-switch.

## Activation gate

Same posture as the rest of the v2-#8 surface: the dashboard page
renders the empty state with a "Feature not enabled in this
deployment" banner when:

- The session-create POST returns 503 FeatureUnavailable (server
  activation gate)
- OR `GET /v1/account/me/bundled-llm-status` returns 503 (bundled-
  llm not wired)

This matches the agent-sessions-routes activation pattern landed
in 8.20.h.

## Drift guards

Each component lands with a parity-test sibling under
`apps/server/tests/unit/`:

- `dashboard-agent-session-panel-content-parity.test.ts`
- `dashboard-mode-selector-content-parity.test.ts`
- `dashboard-takeover-handback-buttons-content-parity.test.ts`
- `dashboard-transcript-stream-content-parity.test.ts`
- `dashboard-bundled-llm-status-panel-content-parity.test.ts`

Each pins:

- The exact URL paths it POSTs/GETs to (drift to mismatched route
  would silently break the page)
- The wire-shape field names it reads (drift to renamed schema
  field would silently render blanks)
- The pair-mode state-machine kinds it branches on
- The error problem-type URIs it shows recovery CTAs for

## Out of scope (Wave 2.D + later)

- Cypress/Playwright end-to-end smoke (Wave 2.D)
- Customer dashboard for browse / inspect old agent-sessions
  (v1.1)
- Transcript export (v1.1)
- Recipe replay UI (v1.1, AI-B4)
- WebRTC-streamed session preview (v1.1, file 07)

## Implementation order

1. 8.23 (this doc)
2. 8.24 — AgentSessionPanel.astro (top-level wrapper)
3. 8.25 — ModeSelector.astro
4. 8.26 — TakeoverHandbackButtons.astro
5. 8.27 — TranscriptStream.astro (SSE consumer)
6. 8.28 — BundledLlmStatusPanel.astro + MessageComposer.astro
7. 8.29 — V-log

Each sub-slice is ~30-45 min including the parity-test drift guard.
Total Wave 2.C estimate: ~4-5h.

## Cross-agent dependency

Agent 1 just landed Phase H1 (harness end-to-end chain); Phase H2
StreamingBridge wire-up is in progress. By the time Phase H2
lands, Wave 2.C components should be ready so the end-to-end
Path A integration works without additional dashboard changes.

The dashboard reads only from the existing server-side wire
contract (POST /v1/agent-sessions, /message, /takeover, /handback,
SSE /transcript, /bundled-llm-status, /bundled-llm-settings) —
none of which require Phase H2 to function. Dashboard ships
independently.

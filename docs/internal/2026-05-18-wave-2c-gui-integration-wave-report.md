# Wave 2.C GUI integration wave report — 2026-05-18 (v2-#8 sub-slice 8.29)

## Scope

Closes Wave 2.C — customer-facing dashboard UI for the v2-#8
AI chat + manual side-by-side feature. The full layout +
state-machine-aware behavior lands in 4 commits across 7
sub-slices, all on a single page
`apps/customer-dashboard/src/pages/agent-sessions.astro` and a
single parity-test file with 18 drift-guard assertions.

## Shipped

| Sub-slice | Commit        | One-line                                                                                                                 |
| --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 8.23      | `64ab43be`    | Design doc — component inventory + page layout + state model + activation gate + drift guards plan                       |
| 8.24      | `83dc4e53`    | `agent-sessions.astro` page scaffold + activation-gate banners + 2-column grid                                           |
| 8.25      | `83dc4e53`    | ModeSelector — 3-way radio (ai / manual / pair, pair default) wired to POST /v1/agent-sessions                           |
| 8.26      | `2f98bfb5`    | TakeoverHandbackButtons — state-machine-aware visibility + click handlers for both POST routes                           |
| 8.27      | `f8fd91e1`    | TranscriptStream — EventSource against /transcript with ds_token fallback + per-role styled appends + beforeunload close |
| 8.28      | `f8fd91e1`    | BundledLlmStatusPanel — fetches /bundled-llm-status; renders consent / cap / used in right rail                          |
| 8.28.b    | `f8fd91e1`    | MessageComposer — POSTs /message; 402 highlights bundled-llm aside                                                       |
| 8.29      | (this commit) | V-log + integration smoke note                                                                                           |

## What landed end-to-end

The page exercises the FULL v2-#8 surface through the browser:

1. Customer lands on `/agent-sessions`. Probes
   `/v1/account/me/bundled-llm-status`; 503 → feature-unavailable
   banner. No token → unauthenticated banner.
2. Customer picks mode (defaults to pair) + clicks "Start agent
   session". POSTs `/v1/agent-sessions { mode }`. On 503 →
   feature banner.
3. On 201, the active-session block reveals + initializes the
   state badge to `ai-driving` (for pair mode). The EventSource
   opens against `/transcript?ds_token=…`. Buttons render per
   state machine.
4. Customer types a message + sends. POSTs
   `/v1/agent-sessions/:id/message`. On 200, SSE stream publishes
   the new entry; the local list appends it with role-styled
   li. On 402, the bundled-llm aside gets a ring-2 amber border
   so the customer sees the recovery CTA.
5. Customer clicks "Take over". POSTs `/takeover`; state badge
   updates; "Take over" hides + "Hand back" shows.
6. Customer clicks "Hand back". POSTs `/handback`; state badge
   updates back; buttons swap.

All driven by ~250 lines of inline `<script is:inline>` JS

- ~150 lines of Astro template. Matches the rest of the
  customer-dashboard's non-React posture; no Next.js framework
  bring-up needed.

## Test surface delta

| File                                                                          | Tests added |
| ----------------------------------------------------------------------------- | ----------: |
| `apps/server/tests/unit/dashboard-agent-sessions-page-content-parity.test.ts` |          18 |

The single parity-test file pins:

- Page exists at the expected path
- DashboardLayout import (consistent posture)
- 3 operational modes rendered, pair default-checked
- Every Wave 2.C sub-slice has its `data-*` hook (slot scaffolding)
- Both activation banners pre-rendered + hidden
- Bundled-llm-status probe URL pinned
- localStorage token key pinned
- data-page root attribute pinned
- All 4 active pair-mode state discriminators branched on
- Takeover/handback POST URLs + bodies pinned
- Create-session 503 → feature banner reveal pinned
- EventSource opens against `/transcript?ds_token=…`
- transcript.entry handler branches on role
- beforeunload closes EventSource (anti-leak)
- bundled-llm field names pinned (monthly_cap_usd_cents /
  used_this_month_cents)
- Message form 402 → bundled-llm panel highlight pinned

## Cross-agent posture

Wave 2.C reads only from the existing server-side wire contract:

- POST /v1/agent-sessions (with { mode })
- POST /v1/agent-sessions/:id/message (with { user_message })
- POST /v1/agent-sessions/:id/takeover (with { client_id })
- POST /v1/agent-sessions/:id/handback
- SSE GET /v1/agent-sessions/:id/transcript
- GET /v1/account/me/bundled-llm-status

None require Agent 1's Phase H2 to function. Dashboard ships
independently — when Phase H2 lands the StreamingBridge wire-up
ends-to-end without any dashboard changes.

## Out of scope (Wave 2.D + later)

- Cypress/Playwright end-to-end smoke against a live test app
  (Wave 2.D, ~6 sub-slices)
- 8.26.b toast-notification surface for typed 409
  PairModeStateInvalidTransitionError extensions (today swallowed
  silently — the typed error class still surfaces the `from` +
  `transition` for SDK-direct callers)
- Customer dashboard for browse / inspect old agent-sessions
  (v1.1)
- WebRTC-streamed session preview (v1.1, file 07)
- Mobile-collapsed right-rail (today the lg: breakpoint handles
  the column collapse; a top-of-page banner variant remains a
  v1.1 polish)

## Outstanding for v1.0 launch

- Wave 2.D Cypress/Playwright E2E smoke against the 3 modes
- 8.26.b toast surface (optional polish, ~30 min)

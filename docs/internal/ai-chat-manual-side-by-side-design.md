# AI chat + manual side-by-side live feature (v2-#8)

**Status:** DESIGN ONLY. Awaiting founder verdicts on the 5 open
questions in "Founder verdicts needed".

**Trigger:** Strategic directive 2026-05-17T19:15Z (3) — APPROVED
for v1.0 as the primary differentiator. "Highest moat per engineering
dollar; no competitor has it."

**Date staged:** 2026-05-18.

## The product

Dashboard split-screen on a session detail page:

- LEFT: live browser stream (LiveKit WebRTC; already wired in
  `apps/customer-dashboard` per file 07).
- RIGHT: AI chat panel (customer types in plain English; AI plans
  the next step via existing AgentRuntime; existing executor drives
  the session).

Three modes (per directive 3, "UX shape locked unless otherwise
noted"):

| Mode   | Driver                                  | AI behavior                                                                    |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------ |
| Manual | Human (mouse/touch on the live preview) | Observes + suggests but doesn't act                                            |
| AI     | AgentRuntime (LLM decompose → executor) | Acts autonomously                                                              |
| Pair   | Mixed                                   | Human can take control mid-session; AI pauses on takeover, resumes on handback |

Mode toggle persists per session (NOT per account — directive says
"customers may legitimately want to run different archetypes per
session"; same logic for the chat mode).

## Why this is the differentiator

No competitor offers it:

- Browserbase: cloud Chromium + Stagehand SDK; no live human-takeover
  UX. Customer scripts in code, sees screenshots after the fact.
- Browserless: API only; no dashboard, no human-takeover.
- Bright Data: anti-bot proxy; no agent layer.
- ScrapingBee: HTML scraping API; no browser session UI at all.

Driftstack already has the LiveKit live preview (LiveKit wire was
Q.5.h Wave 2A) AND the AgentRuntime decompose loop (AI-B1.b Q.1 Wave
2A landing). The product gap is the GUI that combines them.

## Engineering arc (4-7 weeks Agent 2)

Per directive 3:

1. **AI-B2.b real harness-wired executor** (Q.4 design doc shipped —
   `docs/internal/ai-b2b-harness-executor-design.md` — awaiting
   founder verdicts). 1-2 weeks post-verdict.
2. **Dashboard split-screen UI** (parallel; 2-3 weeks).
3. **Conflict resolution + state sync** (1-2 weeks).
4. **Cross-SDK + recipe integration** (1 week).

This doc focuses on phases 2-3. Phase 1 is Q.4. Phase 4 is mechanical
(SDK wires already cross-lifted for Q.5).

## Phase 2: split-screen UI

### Page route

`apps/customer-dashboard/src/pages/sessions/[id]/agent.astro`

(Existing session-detail at `[id].astro` stays as the read-only
session summary; the `/agent` sub-route is the live workbench.)

### Component shape

```astro
<SplitScreen>
  <LeftPanel>
    <LiveKitPreview sessionId={session.id} />
    <ManualControlOverlay enabled={mode === 'manual' || mode === 'pair'} />
  </LeftPanel>
  <RightPanel>
    <ChatHeader>
      <ModeToggle bind:mode />
      <AgentSessionStatus />
    </ChatHeader>
    <ChatTranscript transcript={agentSession.transcript} />
    <ChatInput onSubmit={runTurn} disabled={mode === 'manual'} />
  </RightPanel>
</SplitScreen>
```

LiveKit preview already exists at `apps/customer-dashboard/src/
components/LiveKitPreview.svelte` (Q.5.h Wave 2A landed).

`ChatTranscript` re-renders on every transcript update — driven by
SSE/WebSocket on `/v1/agent-sessions/:id/stream` (open question
#1: SSE vs WebSocket).

### Manual control overlay

In Manual + Pair modes the customer's mouse/touch on the LiveKit
video element generates GUI-input events sent to the session via
existing POST /v1/sessions/:id/gui-input. The dashboard does NOT
do click-to-element resolution; it just forwards screen coords. The
WebKit fork (Agent 1 V-820 fleet_nodes design) maps coords to the
underlying element.

Existing `gui_control` scope on the api-key is required. Open
question #2: should the dashboard auto-mint a `gui_control` key on
agent-session create, or require the customer to mint one explicitly
in API keys settings?

### AI mode

Same flow as today — customer types in the chat box, route hits
`POST /v1/agent-sessions/:id/message`, runs through the AgentRuntime
(decompose → executor). Existing `usage_records.metadata.cost_usd_cents`
captures cost per turn (v2-#4 landed); the chat-UI footer displays
"This turn cost: $0.0\_ via Anthropic" (open question #5: show actual
cost or hide).

### Pair mode

The hard one. Mode-toggle state machine:

```
state idle      { user.click → user_drives ;  ai.start → ai_drives }
state user_drives { ai.start → user_drives [reject] ;
                    user.handoff → ai_drives ;
                    timeout 30s no input → idle }
state ai_drives { user.click → ai_pause [emit PAUSE event] ;
                  ai.complete → idle }
state ai_pause { user.click → user_drives ;
                ai.resume → ai_drives ;
                user.handoff → user_drives }
```

The control plane stores the pair-mode state in
`agent_sessions.metadata.pair_mode_state` (extends the JSONB
transcript? OR new column — open question #3).

When the customer interacts with the live preview while AI is
driving, we EMIT a `pair_takeover` transcript entry + transition to
`ai_pause`. The AgentRuntime sees the pause signal next time it
goes to fire an intent and short-circuits to `clarify` ("paused by
user takeover; type 'resume' to continue or describe a new task").

## Phase 3: conflict resolution + state sync

The hard part. The session has TWO drivers (human + AI), both
mutating the same browser context. Three failure modes:

### Mode A: human + AI both fire input at same instant

User clicks during AI's "wait 500ms then type" intent. Both inputs
hit the WebKit fork at near-simultaneous time. Result depends on
WebKit's event loop ordering — non-deterministic from our side.

**Resolution:** Pair-mode requires AI emit ALL intents through the
existing /v1/sessions/:id/{navigate,interact,wait,capture} routes.
Routes serialize on a per-session lock (open question #4: lock at
route layer vs harness layer). When the user click hits gui-input
during a held lock, it queues; when AI's intent completes, the
queued user click fires.

Trade-off: AI sees lower throughput under contention (its intents
queue behind user clicks). Acceptable since pair-mode is by
definition human-in-the-loop.

### Mode B: AI plans against stale state

User clicks "next page" mid-AI-turn. AI's next intent ("interact
type=tap selector=#next") fires against a now-different DOM.

**Resolution:** Every AI intent re-fetches the current state from
the session right before firing (existing GET /v1/sessions/:id/state
returns url + title + cookies + localStorage). If the URL changed
since the AI decided its intent, the AI re-decomposes from the new
state (one extra Claude turn — costs $0.03ish per stale-state turn).

### Mode C: customer wants to abort AI

User clicks "Stop AI" button.

**Resolution:** Issue POST /v1/agent-sessions/:id/abort. AgentRuntime
holds an abort signal per agent-session; checks before each intent.
On abort signal, transcript gets `aborted` entry, agent-session
transitions to `paused` (NOT `closed` — customer can resume).

## Founder verdicts needed

### Question 1: SSE vs WebSocket for live transcript

Both work. SSE is simpler (one-way server→client, no protocol
upgrade); WebSocket allows duplex (customer-typed task can come
through the same connection).

- A. SSE for transcript; POST /v1/agent-sessions/:id/message for
  customer input. Two channels.
- B. WebSocket bidirectional. One channel.
- C. Long-poll fallback for hostile networks; SSE primary.

**Recommendation:** A. Matches the existing dashboard infrastructure
patterns (Stripe webhook UI uses SSE for live delivery status).

### Question 2: gui_control key auto-mint on agent-session create

Currently customers must explicitly mint a `gui_control` scope key
in /account/api-keys/new. For pair-mode to work, the dashboard
needs one.

- A. Auto-mint a single per-account gui_control key on first
  agent-session-create that needs it; store it server-side; reuse
  for all future agent sessions. Customer never sees the key.
- B. Require explicit minting by the customer (existing flow).
  Dashboard surfaces a banner on the agent-session page when the
  scope is missing.
- C. Mint a SHORT-LIVED (24h TTL) gui_control key per agent-session.
  Disposable; never visible to the customer.

**Recommendation:** C. Minimizes blast radius (24h TTL, single
session) without forcing customer toil.

### Question 3: pair_mode_state storage

- A. New JSONB column on `agent_sessions.pair_mode_state`.
- B. Embed in transcript as `[meta]` entries.
- C. Redis only (ephemeral; lost on Redis restart).

**Recommendation:** A. Auditable; survives Redis loss. Migration is
mechanical.

### Question 4: per-session lock location

When user input + AI input race, who serializes?

- A. Lock at the route layer (Redis-backed per-session lock).
  Cleaner; route layer owns the contention.
- B. Lock at the harness layer (WebKit fork queues inbound events).
  Closer to the action; possibly racier.
- C. NO lock — let WebKit handle ordering. Document as
  "non-deterministic; use AI-only mode if you need predictability".

**Recommendation:** A. We already have a Redis-backed rate-limit
infrastructure; per-session locks are a 50-LOC extension.

### Question 5: per-turn cost surfacing in the chat UI

Open question copied from v2-#6 (bundled-LLM design). The answer
here drives whether the chat UI footer shows actual cost or hides it.

- A. Hide actual cost (consistent with bundled-LLM verdict).
- B. Show actual cost in operator-only audit log (consistent with
  v2-#5 emit).
- C. Show actual cost in the chat footer per turn.

**Recommendation:** A (or B if the bundled-LLM verdict resolves to
"hide"). Don't compete on margin transparency.

## Out of scope

- Recording the pair-mode sessions as recipes — out of scope for
  v1.0 launch. v1.1 follow-up: "replay this pair session as a
  scripted recipe" is a natural extension once recipes can carry
  pair-mode transitions.
- Multi-user same-session (two humans + AI) — out of scope. Single
  human + AI is the v1.0 product.
- Voice input — out of scope. Text chat only.

## References

- LiveKit live preview wire: Q.5.h Wave 2A — commit (TBD; check
  marketing-site comparison page parity test for the locked link).
- AgentRuntime decompose loop: AI-B1.b Q.1 Wave 2A — commits
  `1fc40421` (bootstrap), `3b4cd9bd` (runtime error class),
  `c2ad507e` (route key chain + InMemoryByokKeyCache).
- Cost-tracking infra: v2-#4 commit `c48ff341`.
- Q.4 AI-B2.b harness executor design (PHASE 1 prerequisite):
  `docs/internal/ai-b2b-harness-executor-design.md`.
- Strategic directive 3: memory
  `project_strategic_directives_2026_05_17`.
- Multi-archetype SDK design (related — archetype selector lives in
  same /agent page):
  `docs/internal/multi-archetype-sdk-design.md`.

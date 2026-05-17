# AI-B2.b real harness-wired executor design

**Date:** 2026-05-17
**Slice:** Q.4 (orchestrator handoff #3)
**Status:** DESIGN — awaiting orchestrator + founder answers before
implementation fires.

## Background

`StubAgentExecutor` (apps/server/src/services/agent-executor.ts)
returns synthetic success for every intent today. The runtime +
decomposer + sessions repo all work end-to-end against the stub,
and the dashboard chat-UI can render a believable turn-by-turn
flow during pre-launch demos. AI-B2.b replaces the stub guts with
an in-process `SessionsService` dispatch so an agent plan actually
drives a real driftstack browser session.

This is NOT an HTTP-layer round-trip — the executor lives in the
same node process as the route handlers. Round-tripping through
`/v1/sessions/:id/{navigate,interact,wait,capture}` would double
the latency budget and lose typed-error context. AI-B2.b
dispatches against the `SessionsService` instance from AppDeps
directly.

## Sketch of the impl shape

```ts
export class HarnessWiredAgentExecutor implements AgentExecutor {
  constructor(
    private readonly sessions: SessionsService,
    private readonly captures: CapturesService,
  ) {}

  async execute(args: ExecuteArgs): Promise<ExecutorRunResult> {
    const results: IntentResult[] = [];
    let ok = true;
    for (const intent of args.plan.intents) {
      try {
        const result = await this.dispatch(args.sessionId, intent);
        results.push(result);
        if (result.kind === 'failure') {
          ok = false;
          break; // halt on first failure per interface contract
        }
      } catch (err) {
        // Lifecycle errors (session destroyed mid-plan, driver
        // unreachable) surface as a typed failure result.
        results.push(this.lifecycleFailure(intent, err));
        ok = false;
        break;
      }
    }
    return { results, ok };
  }

  private async dispatch(sessionId: string, intent: AgentIntent): Promise<IntentResult> {
    switch (intent.kind) {
      case 'navigate':
        // sessions.navigate(ctx, sessionId, { url, wait_until })
        // → { url, finalUrl, status, durationMs }
        ...
      case 'interact':
        // sessions.interact(ctx, sessionId, { action, selector?, value? })
        ...
      case 'wait':
        // sessions.wait(ctx, sessionId, { condition, selector?, timeout_ms? })
        ...
      case 'capture':
        // sessions.capture(ctx, sessionId, { capture })
        // → { capture_id, ... }
        ...
    }
  }
}
```

The dispatch needs an `AccountContext` to satisfy
`SessionsService.requireOwned()`. The agent runtime threads the
agent-session's `accountId` through, and the executor builds a
minimal `AccountContext` from it (NOT the original request's auth
context — the agent is acting on the customer's behalf, not as
the customer's bearer-token-authenticated request).

## Questions surfaced to orchestrator + founder

### Q.4.a — Halt-on-first-failure semantics across turns

The current `AgentExecutor` interface contract halts on first
failure within a turn. Question: across turns, does the agent
RESUME from the failed intent on the next turn, or DISCARD the
plan?

Candidate behaviors:

1. **Discard the plan; new turn, new decomposer call** — failure
   surfaces in transcript; agent's next decompose() reads the
   failure and synthesizes a new plan. Aligns with how a human
   debugs an automation failure ("the click failed; let me think
   about what to do next").
2. **Resume from failed intent** — transcript records "intent 3
   of 5 failed; remaining: [4, 5]"; next turn's plan can pick up
   from intent 3. Faster recovery but constrains the agent to the
   prior plan structure.
3. **Hybrid** — failure mode determines: transient (network blip,
   timeout) → resume; semantic (selector not found, navigation
   refused) → discard.

**Orchestrator-recommended:** option 1 for v1.0. Simpler
transcript shape, matches what the decomposer's `history` field
already exposes. Option 3 is a v1.1 optimization once we have
real failure-mode telemetry.

**Open**: should the transcript entry for a failed plan include
the intent index that failed (so the decomposer can reason
about "I was on step 3 of 5")? Or just the failure reason in
free text (less coupling, more decomposer-side parsing)?

### Q.4.b — Per-intent + total-plan latency budget

Today's `AgentExecutor` has no latency budget. The
`SessionsService` driver calls (navigate, wait, etc.) each have
their own timeouts, but the AGGREGATE plan can run for as long
as N intents × per-intent timeout.

Candidate behaviors:

1. **No executor-level budget** — rely on per-intent driver
   timeouts. Simple; long plans (e.g. 8 navigates + 8 waits)
   could take 4+ minutes total.
2. **Total-plan deadline** — `execute()` accepts a `deadlineMs`
   from caller; aborts current intent + halts plan when reached.
   Customer-facing UX: "agent ran out of time at step 5".
3. **Per-intent budget enforced by executor** — wraps each
   driver call in a Promise.race against a per-intent deadline.
   Stricter than driver-level timeouts (driver might wait for
   navigation completion; executor cuts the cord earlier).

**Orchestrator-recommended:** option 2 with a 90-second default
total-plan deadline. Matches the dashboard chat-UI's typical
poll interval; long-running plans surface as a "step timeout"
that the decomposer can re-plan from.

**Open**: should the deadline be tier-tiered? Higher-tier
customers (api_scale, agency) might want a 5-minute total
budget for complex multi-page scrapes. Plumbing implication:
deadline travels from billing-tier → AppDeps → runtime →
executor — adds coupling between two unrelated subsystems.

### Q.4.c — Capture aggregation shape in the response

An agent plan often emits multiple capture intents
(screenshot, dom_snapshot, pdf). The current `IntentResult.success`
shape has an optional `captureId?: string`. Question: does the
runtime AGGREGATE captures into a top-level result field, or are
they referenced individually inline?

Candidate behaviors:

1. **Inline-only** — each `IntentResult.success` has its own
   `captureId`; caller walks `results.filter(r => r.captureId)`.
   Simple, but requires the caller to know about capture
   semantics.
2. **Aggregated `captureIds: string[]`** added to
   `ExecutorRunResult` — runtime collects all captures from the
   plan into the top-level result. Caller can render "3 captures
   in this turn" without walking individual intents.
3. **Hybrid — both** — `IntentResult.success.captureId` AND
   `ExecutorRunResult.captures: Array<{intentIndex: number,
captureId: string}>`. Redundant but the aggregation gives
   the dashboard a clean "captures pane" surface.

**Orchestrator-recommended:** option 3. The redundancy is cheap
(captures arrays are short) and the aggregated form is what the
dashboard chat-UI wants to render in the "Export as SDK code"

- "view captures" affordances surfaced in the M.2 visual demo.

**Open**: should captures returned by the executor be
auto-cleaned-up when the agent session closes? Or do they
persist per the existing capture retention policy (the V-540
roadmap item that's deferred to a future slice)? If they
persist, an account's storage footprint grows linearly with
agent-session activity.

### Q.4.d — Cross-context with EGRESS Phase 1 503-stubs

Today's `SessionsService.navigate` calls the driver to navigate
to a URL. The session's egress is currently 503-stubbed at the
Agent-2 API layer (per the locked
`project_egress_card_contradiction` memory + W247.A drift-sweep
gate). When AI-B2.b lands, the agent plan invokes
`SessionsService.navigate` which dispatches to the driver. What
happens for navigate-without-configured-egress?

Candidate behaviors:

1. **Use driftstack-default egress** — the driver navigates via
   Driftstack's own EU network egress (the current pre-egress-
   feature posture). Agent plan succeeds; customer's session
   transits Driftstack-managed IPs. Acceptable until Q.0
   EG-API-1.6 propagation lands.
2. **Hard-fail with feature-unavailable** — agent plan halts on
   first navigate intent with reason "session has no configured
   egress; configure SOCKS5/WireGuard/OpenVPN at /v1/proxies
   first". Aligns with the W247.A gate's expectation that
   customers configure egress before using sessions.
3. **Plan-time refuse** — decomposer checks egress status before
   planning; refuses the whole task with "configure egress first"
   if the session doesn't have a proxy attached. Moves the gate
   one layer earlier.

**Orchestrator-recommended:** option 1 for v1.0 launch. The
W247.A gate is a MARKETING gate (don't claim "live" until the
API propagation lands), not a runtime gate (sessions actually
DO egress today via driftstack-default). The agent layer can
use the same egress path. Option 2 fires automatically when
Q.0 EG-API-1.6 lands (the API layer starts enforcing).

**Open**: does the cross-context test surface need to verify
that the agent layer dispatches AFTER any egress-config check
on the session? If a session was created with `proxy: {...}`
but the proxy backend isn't yet wired (current 503 state), does
the session creation 503 BEFORE the agent ever gets a chance to
dispatch?

### Q.4.e — Mid-plan session destruction handling

A customer might destroy their driftstack session out-of-band
(via `DELETE /v1/sessions/:id`) while an agent plan is mid-
execution. The current StubAgentExecutor doesn't model this;
the real executor needs a contract.

Candidate behaviors:

1. **Detect + halt + transcript** — executor catches the
   "session destroyed" error from `requireOwned()`, halts plan
   with `kind: 'failure', reason: 'session was destroyed
mid-plan'`. Agent session itself stays active so the
   customer can attach a fresh driftstack session.
2. **Detect + halt + close agent session** — same detection, but
   also calls `agentSessions.closeWithReason(agentSessionId,
'driftstack-session-destroyed')` so the agent session
   short-circuits on subsequent turns. Stricter; aligns with
   the Q.3 budget-exhausted close pattern.
3. **Don't detect — let the plan crash** — driver call throws;
   error propagates up; runtime returns `kind: 'failure'` with
   the raw error message. Simplest implementation but worst UX.

**Orchestrator-recommended:** option 1. The agent session is a
SEPARATE primitive from the driftstack session (per the AI-A
schema split). Destroying the driftstack session shouldn't
destroy the agent session — the customer might want to attach
a fresh driftstack session and resume the conversation. Option
2 conflates two unrelated lifecycles.

**Open**: when the executor detects a destroyed session, does
the agent session's `driftstack_session_id` field get nulled
out automatically (so the customer can re-attach via PATCH /v1/
agent-sessions/:id), or does it stay populated as historical
context (so the customer sees "you destroyed session ses_xxx
mid-plan; here's where you were")?

## Latency budget summary (assuming Q.4.b recommendation lands)

- Per-intent budget: defaults to driver-level timeout
  (navigate ~30s, wait ~configurable, interact ~5s, capture ~10s)
- Total-plan budget: 90s default
- Decomposer call: 30s (Claude API max with retry)
- Total turn budget: ~120s end-to-end (decomposer + executor)

Dashboard chat-UI poll interval is ~3s; a customer staring at
the spinner for 2 minutes is acceptable for complex plans, painful
for simple ones. Tier-tier override would let the UI display
"this is a long-running plan; we'll notify you when it finishes"
for >60s estimated runtime.

## Cross-context with the rest of the platform

- **AgentRuntime** (existing) — no changes needed; the executor
  is swapped via AppDeps wiring.
- **SessionsService** (existing) — no changes needed; the
  executor calls existing methods.
- **CapturesService** (existing) — referenced for capture
  retrieval (the agent plan emits capture_ids; the dashboard
  fetches blobs separately via /v1/sessions/:id/captures/:id).
- **EGRESS** (Q.0 deferred) — agent layer uses
  driftstack-default egress until Q.0 lands; no agent-side
  changes when Q.0 flips the gate.
- **Bundled-LLM billing** (v1.1) — agent plan costs accumulate
  into `usage_records` per the Q.1.e tracking design; bundled
  billing rolls them into invoices when that surface ships.

## Implementation gate

Implementation does NOT fire until orchestrator (or founder
direct) answers Q.4.a through Q.4.e. Q.4.a + Q.4.b are
load-bearing; Q.4.c + Q.4.e have safer defaults (recommended
options ship without explicit verdict).

The /loop 3m autopilot moves on past this slice without
blocking. Q.5 recipe writer fires next; Q.0 EG-API-1.6 last.

## References

- AgentExecutor interface + StubAgentExecutor:
  apps/server/src/services/agent-executor.ts
- SessionsService dispatch surface:
  apps/server/src/services/sessions.ts (navigate at L253,
  interact at L281, wait at L325, capture at L374)
- AgentRuntime composer:
  apps/server/src/services/agent-runtime.ts
- Q.3 close-on-end-state pattern: commit 70a633b3 (reference
  for Q.4.e option 2 considerations)
- planning 132 §"Phase 7" — AI agent layer v1.0 scope
- planning 133 — EGRESS Phase 1 cross-agent contract (relevant
  for Q.4.d)

# AI-B1.b activation design — open questions for orchestrator verdict

**Date:** 2026-05-17
**Slice:** Q.1 (orchestrator handoff #3)
**Status:** DESIGN — awaiting orchestrator + founder answers before
implementation fires.

## Why this slice needs a design doc first

The ClaudeAgentDecomposer wire shipped earlier this session
(11d7316a) as a drop-in behind the AgentDecomposer interface, but
the BOOTSTRAP flip — picking the Claude wire over the deterministic
stub in production — has five non-obvious choice points that each
have customer-visible UX consequences. Picking poorly on any one
of them creates either a customer-burning-founder-key path
(financial exposure), a customer-paying-for-deterministic-output
path (false advertising — they think they're getting LLM
intelligence but they're getting heuristics), or a confusing
mid-conversation engine-swap (Claude turn N succeeds, Claude turn
N+1 fails, deterministic fallback gives a different answer style).

The 5 questions below all have plausible answers in either
direction; the orchestrator/founder verdict on each pins the
bootstrap shape + route handler before we commit code.

## Questions surfaced to orchestrator + founder

### Q.1.a — Keying: bootstrap chooses Claude vs deterministic on which signal?

When bootstrap wires `appDeps.agentDecomposer`, what determines
whether it's `ClaudeAgentDecomposer` or `DeterministicAgentDecomposer`?

Candidate signals:

1. **Per-deployment env flag** (`DRIFTSTACK_AGENT_DECOMPOSER=claude` or
   `=deterministic`). Operator controls explicitly; safe-by-default
   (no flag = deterministic). Easy to flip in staging vs prod.
2. **Presence of BYOK fallback env var** (`BYOK_ANTHROPIC_FALLBACK_KEY`).
   Set the key, Claude wires; unset, deterministic. Matches the
   existing pattern for other services (Stripe, Postmark).
3. **Presence of `byokAnthropicService`** (per-customer key storage
   wired via `MFA_ENCRYPTION_KEY`). Same gate as the BYOK customer
   routes.
4. **Either #2 or #3** — Claude wires if EITHER path can resolve a
   key at runtime.

**Orchestrator-recommended:** option 4 (`fallback OR per-customer
storage available`). Matches the route's actual key-resolution
logic — Claude can serve customers via either path, so the
bootstrap should activate when either is reachable.

**Open**: does the operator want an explicit override env var
to FORCE deterministic even when keys are available? (Useful in
staging to test the deterministic path without unwiring config.)

### Q.1.b — Runtime fallthrough on Claude API failure

When ClaudeAgentDecomposer.decompose() throws (5xx after retry,
network error after retry, malformed response, missing API key),
what does AgentRuntime.runTurn() do?

Candidate behaviors:

1. **Hard-fail with 502** — propagate the exception; customer sees
   the route handler's 502 problem-type. Definitive but bad UX
   mid-conversation (turn 3 of 8 fails; customer's plan is half-
   executed).
2. **Fall back to deterministic decomposer for that turn** — wrap
   the decomposer call in try/catch; on failure, retry with
   DeterministicAgentDecomposer.decompose() and tag the result so
   the UI can render a "fell back to heuristics" indicator. Keeps
   the conversation going but the answer quality silently degrades.
3. **Refuse with a customer-facing reason** — convert the failure
   into a `kind: 'refuse', refuseReason: 'agent layer temporarily
unavailable; please retry'`. Doesn't expose internal errors;
   conversation stays alive but no plan executes.
4. **Hybrid** — 5xx + network → option 3 (refuse, retryable);
   credential / malformed → option 1 (502, configuration error).

**Orchestrator-recommended:** option 4. 5xx + network are
transient operational failures the customer can retry from;
credential/malformed errors are misconfigurations that need to
surface to the operator (502 + Sentry alert).

**Open**: when option 4 fires the refuse path, should it
`closeWithReason='agent-unavailable'` (so subsequent turns
short-circuit) or keep the session active (allowing the customer
to retry the same turn)? The Q.3 budget-exhausted close pattern
suggests close, but transient failures argue against — the
operator might fix the upstream and the customer's session
should still be usable.

### Q.1.c — Per-customer key resolution at the route layer

When a customer has stored a BYOK Anthropic key in their account
(via the /v1/account/me/byok-anthropic-key routes that landed in
the previous wave), does the agent-sessions route AUTO-RESOLVE
the key from byokAnthropicService, or does the customer still
need to send the `x-byok-anthropic-api-key` header per request?

Candidate behaviors:

1. **Header only** (current shape) — customer always sends the
   header; stored keys are display-only / management surface.
   Customer can decide per-request which key to use (e.g. test
   key vs production key).
2. **Stored-first, header overrides** — route looks up the
   customer's stored key from byokAnthropicService; if a request
   header is present, that wins. Default UX is "I configured my
   key once, don't have to send it every time."
3. **Stored-first, header forbidden** — once a customer has
   stored a key, sending a header throws 400. Forces single
   key-per-account semantics, simpler audit.

**Orchestrator-recommended:** option 2. Matches typical
API-key-management UX (stored as default, header for explicit
override). The pattern customers see in Stripe, Mailgun, etc.

**Open**: should the per-request resolution invalidate the
account-level encryption-at-rest properties? If we decrypt the
stored key on EVERY chat turn, the AES-GCM ciphertext is
unwrapped many times per session — that's an attack surface
expansion vs the management-only resolution (decrypt only when
the customer hits GET /v1/account/me/byok-anthropic-key).

### Q.1.d — Deployment-fallback consumption posture

When ClaudeAgentDecomposer is wired AND a customer doesn't send a
header AND doesn't have a stored BYOK key, what happens?

Candidate behaviors:

1. **Burn the deployment fallback** — `BYOK_ANTHROPIC_FALLBACK_KEY`
   is used. Founder's key gets consumed on every customer chat.
   Aligns with "demos + integration tests" framing in the config
   comment, but in practice means real customers can run their
   agent layer on the founder's nickel.
2. **Hard 502 — force BYOK** — route refuses with a problem-type
   indicating the customer needs to configure their own key.
   Aligns with the v1.0 "BYOK is the path" Tier-3 verdict;
   prevents the burn scenario.
3. **Per-account opt-in to fallback** — accounts have a
   `fallback_consent` boolean; default false; admin/founder can
   flip on for specific accounts (e.g. trial customers, design
   partners). Default UX matches option 2; consented customers
   get option 1.

**Orchestrator-recommended:** option 2 for v1.0 launch. The
fallback key is operationally for staging/IT tests, NOT for
serving production customers. Option 3 is a v1.1 expansion if
the customer-acquisition team wants to offer "frictionless trial
of the AI chat without BYOK setup".

**Open**: does the staging deployment use the fallback key as the
"default customer path" so demo flows work without BYOK setup?
If yes, staging diverges from prod here — config-wise that's
fine (separate env files) but operationally it means staging
behavior doesn't predict prod behavior on this specific UX path.

### Q.1.e — Cost-tracking on the fallback path (if option 1.d.1 ever lands)

Independent of Q.1.d's verdict: if the fallback IS ever used to
serve a real customer (founder demo, design-partner trial), do we
track the consumption as a per-customer cost line?

Candidate behaviors:

1. **No tracking** — fallback usage is operationally invisible.
   Simple but the founder can't tell which customer burned how
   much of their personal Anthropic spend.
2. **Tracked but unbilled** — every fallback turn logs an
   `agent_decomposer_cost` row with the customer's account id +
   the upstream Anthropic usage. Founder can run a query to see
   "who burned my key this month" without billing them.
3. **Tracked + billed at the bundled-LLM rate** — same logging,
   plus tier-tiered cost rolls into the customer's monthly
   invoice. Requires the bundled-LLM billing surface (currently
   deferred to v1.1) to be at least partially shipped.

**Orchestrator-recommended:** option 2 — instrument the fallback
path with cost-tracking from day one even if billing is deferred.
The data is needed for the v1.1 bundled-LLM design anyway.

**Open**: where does the usage row land? `usage_records` (the
existing table) extended with an `agent_decomposer` cost source?
Or a new dedicated `agent_session_costs` table that
denormalizes (account_id, agent_session_id, anthropic_input_tokens,
anthropic_output_tokens, anthropic_cost_usd_cents, at)?

## Implementation gate

Implementation does NOT fire until the orchestrator (or founder
direct verdict, whichever the chain dictates) answers all five.
Q.1.a + Q.1.b + Q.1.d are the load-bearing answers — Q.1.c +
Q.1.e have safer defaults that can ship even without explicit
verdicts.

The /loop 3m autopilot continues past this slice without
blocking — Q.4 design doc fires next, then Q.5 recipe writer,
then Q.0 EG-API-1.6 propagation. Q.1 implementation slots in
whenever the verdicts land.

## References

- ClaudeAgentDecomposer wire: commit 11d7316a
  (apps/server/src/services/agent-decomposer-claude.ts +
  tests/unit/agent-decomposer-claude.test.ts)
- DeterministicAgentDecomposer:
  apps/server/src/services/agent-decomposer-deterministic.ts
- AgentRuntime: apps/server/src/services/agent-runtime.ts
- BYOK Anthropic per-customer storage: commits e5523811 +
  994386cd (apps/server/src/services/byok-anthropic.ts +
  routes/account-byok-anthropic.ts)
- Q.3 budget-exhausted close pattern: commit 70a633b3
  (reference for the close-on-end-state design)
- agent-sessions route handler header-resolution:
  apps/server/src/routes/agent-sessions.ts (lines 117-140 of the
  current main HEAD — `x-byok-anthropic-api-key` header passthrough)

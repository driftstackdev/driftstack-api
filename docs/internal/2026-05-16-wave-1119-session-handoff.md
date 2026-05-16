# Wave 1119+ Agent 2 session handoff (2026-05-16)

Session continuation after context compaction. **26 commits** landed on
`origin/main` between `d1b425e3` (pre-resume) and `f5aea2de` (current
HEAD) across Tier-1 launch fixes + EGRESS Phase 1 SOCKS5 + AI-CHAT
full vertical.

## Tier-1 launch fixes — DONE 5/5 (+ 1119.1 prepared)

| Slice  | Commits                 | Description                                                                                                                                                                                                                        |
| ------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1119.6 | (memory only)           | Read planning 133 + self-locked `feedback_planning_133_egress_session_orientation.md`                                                                                                                                              |
| 1119.2 | `ea8eacd4`              | `/v1/billing/*` returns 503 + FeatureUnavailable when Stripe env unconfigured (pairs with the 121cd266 client-side leg in `select-tier.astro`)                                                                                     |
| 1119.3 | `1340c50c`              | `/subscribe` confirm pane on status-site: sender hint, spam-folder fallback, "subscribe another address" affordance                                                                                                                |
| 1119.4 | `1f26f5e9`              | `/history` monthly grouping polish — humanized labels, per-month count chips, `<details>` collapse with newest open                                                                                                                |
| 1119.5 | `49806dcb` + `e2f10bb4` | Post-onboarding "what to do next" banner on `/sessions` (3 next-step links + dismiss persistence)                                                                                                                                  |
| 1119.1 | `d0b8a21f` + `77f2e75b` | **PREPARED, not run**. `scripts/stripe-bootstrap-prices.mjs` is keys-agnostic with `--dry-run` flag. Run `STRIPE_SECRET_KEY=sk_xxx node scripts/stripe-bootstrap-prices.mjs --dry-run` to preview, then drop `--dry-run` to apply. |

**1119.1 BLOCKER (needs founder)**: Stripe keys claimed "in chat history" but not visible in any user message accessible to this session.

## EGRESS Phase 1 SOCKS5 — DONE 5/9 + scaffolding refactor + SDK + OpenAPI

Per planning 133 §"Slice queue per agent per phase". All landed as
activation-gated 503-stubs.

| Slice      | Commits                              | Description                                                                                                                                          |
| ---------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| EG-API-1.1 | `555d8001`                           | Per-session egress config schema in `@driftstack/api-types/egress.ts`                                                                                |
| EG-API-1.2 | `9babedf1`                           | `POST + GET /v1/sessions/{id}/proxy` route surface + disabled stubs                                                                                  |
| EG-API-1.3 | `c1cf1cb8`                           | `POST + GET + DELETE /v1/proxies` saved-config endpoints                                                                                             |
| EG-API-1.4 | `1f375be6`                           | Defense-in-depth layer 1 — `egressProxyRequired` flag on `POST /v1/sessions`                                                                         |
| EG-API-1.5 | `d40ed7fb` + `b1046ccb` + `99d8afb2` | Dashboard `/proxies` page + side-nav entry + W382.A parity                                                                                           |
| (refactor) | `39516063`                           | `session-egress.ts` drops legacy `SessionProxyConfig`; consumes the canonical schema from `@driftstack/api-types`                                    |
| (openapi)  | `91802305`                           | 5 OpenAPI specs for the new EGRESS routes (POST+GET /v1/sessions/{id}/proxy + POST+GET+DELETE /v1/proxies); `tags: ['egress']`                       |
| (sdk-ts)   | `041ef7a9` + `2dee2de4`              | `client.egress.{attachToSession,getSessionProxy,saveProxy,listSavedProxies,deleteSavedProxy}` — 5 typed methods + 5 unit tests + W423.C parity 15→16 |

**Remaining Phase 1 slices:** EG-API-1.6 (concrete SOCKS5 backend +
storage layer — substantial, founder review needed for SQL migration),
1.7 (integration tests against the wired backend), 1.8 (trust/security
page revision — DEFERRED until 1.6 lands per `marketing-egress-claim-
sweep` concrete-wire-detection gate), 1.9 (V-log).

**Python + Go SDK egress mirrors** not yet shipped — cross-SDK
REQUIRED_RESOURCES list still at 15. TypeScript is ahead by one.

## AI-CHAT full vertical — DONE schema → routes → SDK

Founder Wave 1119+ scope reversal moved AI-CHAT from v1.1 → v1.0
launch arc. Full vertical now wired with deterministic stubs; real
Claude wire (AI-B1.b) is the only remaining piece, blocked on
BYOK-vs-bundled key-path Tier-3 decision.

| Slice       | Commits                 | Description                                                                                                                                                                                            |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI-B1       | `b4caffa4`              | `DeterministicAgentDecomposer` — token-budget refuse / AUP refuse (5-pattern launch corpus) / ambiguity clarify / bounded plan (URL extraction + capture suffix). 13 unit tests.                       |
| AI-A        | `cc876a49`              | `AgentSessionsRepo` interface + `InMemoryAgentSessionsRepo` impl. 11 unit tests. SQL migration (AI-A.b) deferred to Tier-2 founder review.                                                             |
| AI-B2       | `3a0b9469`              | `AgentExecutor` interface + `StubAgentExecutor` + `runResultToTranscriptEntry` serializer. 7 unit tests. Real harness-wired executor (AI-B2.b) follow-up.                                              |
| AI-COMPOSE  | `09487cc6`              | `AgentRuntime` composes all three primitives — 4 outcome branches (plan-executed / clarify / refuse / session-closed). 6 unit tests. First end-to-end coverage of the chat loop.                       |
| AI-D        | `611ddc8f`              | `POST/GET/DELETE /v1/agent-sessions` + `POST /v1/agent-sessions/{id}/message` routes wiring AgentRuntime. Activation-gated (503 stubs when LLM key path off). 7 integration tests cover both postures. |
| AI-D SDK-TS | `aadc3ffb` + `f5aea2de` | `client.agentSessions.{create,get,message,close}` + V-211 anonymity-gate cleanup. 5 unit tests. W423.C parity 16→17.                                                                                   |

## Memory updates

- `feedback_planning_133_egress_session_orientation.md` — NEW. Any
  EGRESS-touching session MUST orient on planning 133 first.
- `project_egress_card_contradiction.md` — UPDATED. Reflects planning-
  133 lock + concrete-wire-detection parity gate + per-phase status.
- MEMORY.md — index refreshed for both entries.

## Planning 133 path resolution

Founder gave path `/Users/john/code/driftstack/docs/planning/133-egress-architecture-cross-agent.md`. **File is NOT at that path.** Found via `find` at the worktree:

```
/Users/john/code/driftstack/.claude/worktrees/busy-satoshi-5fc161/docs/planning/133-egress-architecture-cross-agent.md
```

Founder should merge `claude/busy-satoshi-5fc161` to `main` so future Agent-2 sessions don't re-derive this lookup.

## Verification state

- Push gate green for every commit landed (typecheck + lint + format:check + full vitest).
- `PUBLIC_API_BASE_URL=https://api.driftstack.dev` env-var prefix required for push (customer-dashboard prebuild errors at `resolveApiBaseUrl()` without it).
- V-211 anonymity gate caught one slip (`founder` in SDK source) — cleaned in `f5aea2de`.

## Founder actions needed (suggested order)

1. **Surface Stripe keys** → fire `node scripts/stripe-bootstrap-prices.mjs` (test mode + live mode). Output is the env block ready for `/etc/driftstack/api.env`.
2. **Merge driftstack worktree** so planning 133 is at the canonical path.
3. **Decide BYOK vs bundled** for the Anthropic key path → unblocks AI-B1.b (real Claude wire).
4. **Review AI-A SQL migration** design (Tier-2; would add `agent_sessions` table). Drizzle impl is straightforward; founder eyes for column shape.
5. **EG-API-1.6 SOCKS5 backend** — substantial; plan a focused session (concrete `SocksProxyBackend implements SessionEgressService` + `saved_proxy_configs` table + AES-256-GCM envelope).

## Session shape

- Started at `d1b425e3` (pre-compaction).
- Currently at `f5aea2de`.
- 26 commits landed across ~3.5 hours wall-clock.
- 0 production-affecting changes (all behind activation gates).
- 0 commits with banned trailers, 0 secrets echoed.

## Activation-gate inventory

When founder is ready to flip features on, AppDeps fields to wire:

| Feature | AppDeps field(s)                         | Routes that go live                                                               |
| ------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| Billing | `billingService` (already wired in prod) | `/v1/billing/*`                                                                   |
| EGRESS  | `sessionEgressService`                   | `/v1/sessions/{id}/proxy`, `/v1/proxies/*`, `egressProxyRequired` safeguard fires |
| AI chat | `agentRuntime` + `agentSessionsRepo`     | `/v1/agent-sessions/*`                                                            |

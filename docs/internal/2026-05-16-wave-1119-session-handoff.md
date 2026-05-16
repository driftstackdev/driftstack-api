# Wave 1119+ Agent 2 session handoff (2026-05-16)

Session continuation after context compaction. 14 commits landed on
`origin/main` (b4caffa4 → 99d8afb2) across Tier-1 launch fixes + EGRESS
Phase 1 SOCKS5 foundation + AI-CHAT scaffold.

## Tier-1 launch fixes — DONE 5/5 (+ 1 blocker surfaced)

| Slice  | Commit                  | Description                                                                                                                                                                                                                                                        |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1119.6 | (memory only)           | Read planning 133 + self-locked `feedback_planning_133_egress_session_orientation.md`                                                                                                                                                                              |
| 1119.2 | `ea8eacd4`              | `/v1/billing/*` returns 503 + FeatureUnavailable when Stripe env unconfigured (pairs with the 121cd266 client-side leg in `select-tier.astro`)                                                                                                                     |
| 1119.3 | `1340c50c`              | `/subscribe` confirm pane on status-site: sender hint, spam-folder fallback, "subscribe another address" affordance                                                                                                                                                |
| 1119.4 | `1f26f5e9`              | `/history` monthly grouping polish — humanized labels, per-month count chips, `<details>` collapse with newest open                                                                                                                                                |
| 1119.5 | `49806dcb` + `e2f10bb4` | Post-onboarding "what to do next" banner on `/sessions` (3 next-step links + dismiss persistence)                                                                                                                                                                  |
| 1119.1 | `d0b8a21f`              | **PREPARED, not run**. `scripts/stripe-bootstrap-prices.mjs` is keys-agnostic — founder runs `STRIPE_SECRET_KEY=sk_xxx node scripts/stripe-bootstrap-prices.mjs` to create products + prices + output the env block ready to paste into `/etc/driftstack/api.env`. |

**1119.1 BLOCKER (needs founder)**: Stripe keys claimed "in chat history" but not visible in any user message accessible to this session. Surface the keys to unblock — script is ready to fire instantly.

## EGRESS Phase 1 SOCKS5 — DONE 5/9

Per planning 133 §"Slice queue per agent per phase". All landed as
activation-gated 503-stubs (matches the billing pattern; dashboard +
SDK clients get a machine-readable "not yet shipped" signal vs a
misleading 404).

| Slice      | Commit                               | Description                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EG-API-1.1 | `555d8001`                           | Per-session egress config schema in `@driftstack/api-types/egress.ts` — `SessionEgressConfig` + `ProxyConfig` discriminated union + `SocksProxyConfig` + `OpenVpnProxyConfig` + `WireGuardProxyConfig` + `EgressSafeguard` + `SavedProxyConfig`. Binding cross-agent contract per planning 133. SUPERSEDES the f7bab517 `SessionProxyConfig` shape (which used a single `url:` field). |
| EG-API-1.2 | `9babedf1`                           | `POST + GET /v1/sessions/{id}/proxy` route surface + `registerSessionProxyDisabledRoutes` stubs. Body cross-checks `session_id` matches URL `:id`.                                                                                                                                                                                                                                     |
| EG-API-1.3 | `c1cf1cb8`                           | `POST + GET + DELETE /v1/proxies` saved-config endpoints + activation-gate stubs. `GET` returns 200 + empty list across both postures so the dashboard empty state renders identically.                                                                                                                                                                                                |
| EG-API-1.4 | `1f375be6`                           | Defense-in-depth layer 1 — `egressProxyRequired` flag in `SessionRoutesOptions`; when `sessionEgressService` is wired in AppDeps, `POST /v1/sessions` rejects bodies without a `proxy` envelope. Currently false in prod (no backend wired) → session-create unchanged.                                                                                                                |
| EG-API-1.5 | `d40ed7fb` + `b1046ccb` + `99d8afb2` | Dashboard `/proxies` page — SOCKS5 saved-config library + create form (label/host/port/UDP_ASSOCIATE/optional auth) + Phase 2/3 placeholder cards. Wired into the side-nav (W382.A parity refreshed to 13 entries).                                                                                                                                                                    |

**Remaining Phase 1 slices:**

- EG-API-1.6 propagation — concrete `SocksProxyBackend implements SessionEgressService` + bootstrap wiring + storage layer (`saved_proxy_configs` table + AES-256-GCM envelope per planning 133 SECURITY note). This is the substantial slice; lifts the activation gate.
- EG-API-1.7 integration tests — current tests cover the activation-gate posture (6 cases in `session-proxy-routes.test.ts` + `saved-proxies-routes.test.ts` + `session-create-egress-safeguard.test.ts`). Expansion needs the EG-API-1.6 backend.
- EG-API-1.8 trust/security page revision — DEFERRED until EG-API-1.6 lands. The `marketing-egress-claim-sweep` parity gate keys on concrete-wire detection (`implements SessionEgressService` + `sessionEgressService: sessionEgressService` in bootstrap). My slices added the routes + schema but NO concrete impl → disclaimers stay required. Updating the trust page now would break the parity test.
- EG-API-1.9 V-log entry — small follow-up after 1.6 lands.

## AI-CHAT scope reversal — AI-B1 DONE

| Slice | Commit     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI-B1 | `b4caffa4` | `DeterministicAgentDecomposer` impl. Four-way branching: token-budget exhausted → refuse (0 tokens charged); AUP keyword match (5-pattern launch subset) → refuse; ambiguity heuristic → clarify; otherwise → bounded plan (URL-extraction cap 3, DuckDuckGo fallback, wait-idle + dom_snapshot suffix). 13 unit tests. **Real Anthropic Claude wire deferred to AI-B1.b** once the BYOK-vs-bundled key-path Tier-3 question resolves — interface contract is now locked. |

## Memory updates

- `feedback_planning_133_egress_session_orientation.md` — NEW. Any EGRESS-touching session MUST orient on planning 133 first. Self-locked per founder Rule F orientation directive in Slice 1119.6.
- `project_egress_card_contradiction.md` — UPDATED. Reflects planning-133 lock + concrete-wire-detection parity gate + per-phase status table.
- MEMORY.md index — refreshed both entries.

## Planning 133 path resolution

Founder gave path `/Users/john/code/driftstack/docs/planning/133-egress-architecture-cross-agent.md`. **File does NOT exist there.** Found via `find` at the worktree path:

```
/Users/john/code/driftstack/.claude/worktrees/busy-satoshi-5fc161/docs/planning/133-egress-architecture-cross-agent.md
```

Read from the worktree. Founder should merge `claude/busy-satoshi-5fc161` to `main` in the driftstack repo so future Agent-2 sessions don't re-derive this lookup.

## Verification state

- 18,228 / 18,371 tests passing across 1,818 files (post EG-API-1.5 push gate). 143 skipped.
- All push pre-gates (typecheck + lint + format:check + npm test with prebuild) green for every commit landed.
- The `PUBLIC_API_BASE_URL=https://api.driftstack.dev` env-var prefix is required to push (without it the customer-dashboard prebuild errors at `resolveApiBaseUrl()`).

## Next actions (suggested order)

1. **Surface Stripe keys** so `1119.1` can fire on prod + staging.
2. **Merge driftstack worktree** so planning 133 is at the canonical path for future agents.
3. **Founder-only**: decide BYOK vs bundled for the Anthropic key path, then queue AI-B1.b.
4. **EG-API-1.6** is the next-most-leveraged EGRESS slice but it's substantial (concrete SOCKS5 backend + storage table + AES envelope + bootstrap wiring + harness propagation contract). Plan a focused session for it.

## Session shape

- Started at compaction-resume (d1b425e3 base).
- Ended at 99d8afb2.
- 14 commits over ~2 hours of wall-clock.
- 0 production-affecting changes (all behind activation gates or env-gated).
- 0 commits with banned trailers (per `no-coauthor-trailer` memory).
- 0 secrets ever echoed in Bash output or commit messages (per credentials-via-env-vars-only memory).

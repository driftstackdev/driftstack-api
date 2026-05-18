# v2 queue batch report — 2026-05-18

## Scope

16 commits closing v2-queue items v2-#17 through v2-#32, plus
v2-#18 from the earlier explicit queue. All commits land on `main` in
the `driftstack-api` repo; tests green per slice.

## Shipped

### Explicit v2 queue items

| Item   | Commit     | One-line                                                                                    |
| ------ | ---------- | ------------------------------------------------------------------------------------------- |
| v2-#17 | `b6474545` | Register daily rotation reminder cron jobs in bootstrap.ts                                  |
| v2-#18 | `74b19aec` | End-to-end agent-decomposer usage-recorder smoke through the HTTP layer                     |
| v2-#19 | `29349536` | Wire idempotency-key + closed_at through service / repo / route / SDKs                      |
| v2-#20 | `0c3876d2` | Honour rotation grace window — dual-sign deliveries while secretPrev is live (real bug fix) |
| v2-#21 | `f3c38a81` | Stored-key TTL gate — getPlaintext treats stale keys as absent                              |
| v2-#22 | `89175197` | Cross-SDK archetype roster parity fixture + test                                            |
| v2-#23 | `6c691898` | Rate-limit headers — pin headers across buckets + 429 retry-after path                      |
| v2-#24 | `a3e667c7` | Close ByokAnthropicRequired parity gap in Python + Go SDKs + cross-SDK drift guard          |
| v2-#25 | `3896d346` | Postmark transactional template audit + drift guard                                         |
| v2-#26 | `cc109734` | GET /v1/account/me/billing-portal redirect endpoint                                         |

### Invented depth slices

| Item   | Commit     | One-line                                                                    |
| ------ | ---------- | --------------------------------------------------------------------------- |
| v2-#27 | `b4cf4614` | Surface rotationReminders state on the bootstrap-complete log line          |
| v2-#28 | `8a3a0654` | Design doc — server-initiated webhook secret force-rotation policy          |
| v2-#29 | `e031571a` | Daily sweep to null stale secret_prev columns after grace expiry            |
| v2-#30 | `abdf32c5` | Extend cross-SDK parity to verify Python `__all__` + Go sentinel re-exports |
| v2-#31 | `615b9f1b` | Drizzle ↔ InMemory parity guard for clearStaleSecretPrev                    |
| v2-#32 | `1256438c` | onKeyExpired observability hook for the v2-#21 TTL gate                     |

## Tier-3 queue surfaced

Appended to `/tmp/orchestrator-pending-tier3.md` by v2-#28:

```
## v2-#28 webhook secret server-initiated force-rotation (2026-05-18)

4 founder verdicts needed:
  1. Day 91 behaviour. Block / auto-rotate / audit-log only. Rec: B.
  2. Auto-rotation grace window length. 24h / 7d / 30d. Rec: B (7 days).
  3. Post-rotation notification cadence. Single / single+24h-before-
     expiry / triple. Rec: B (single+24h-before-expiry).
  4. Per-endpoint opt-out flag. None / per-endpoint / per-account. Rec: A (no opt-out).
```

Combined with the pre-existing v2-#6 (bundled-LLM, 5 questions) +
v2-#8 (AI chat + manual, 5 questions) — total 14 pending Tier-3
verdicts in the morning founder queue.

## Production-relevant fixes

- **v2-#20 webhook dual-sign rotation grace** — the rotation grace
  window UX promised customers a 24h dual-sign period after
  `POST /v1/webhooks/:id/rotate-secret`, but the worker never threaded
  `secretPrev` through `signWebhookPayload`. Real customers rotating
  via the dashboard between when V-359 landed and this commit got
  single-signed deliveries during the grace window. Fix is live.
- **v2-#24 ByokAnthropicRequired Python+Go parity gap** — Python and
  Go SDK customers hitting 502 ByokAnthropicRequired got the generic
  DriftstackError / UnknownError fallback instead of a typed branch.
  Now they can `from driftstack import ByokAnthropicRequiredError` /
  `errors.As(err, &ByokAnthropicRequiredError)`.

## Drift guards added

- v2-#22 cross-SDK archetype roster (JSON source-of-truth + 5 langs pinned)
- v2-#24 cross-SDK PROBLEM_TYPES URI parity (3 SDK mapping tables)
- v2-#25 Postmark template audit (V-205 attribution + footer + no
  hardcoded archetype string)
- v2-#27 bootstrap-complete log carries rotationReminders state
- v2-#30 Python `__all__` + Go sentinel re-export parity
- v2-#31 Drizzle ↔ InMemory clearStaleSecretPrev predicate parity

## Test deltas

All affected unit + integration test files green per slice. Targeted
runs (one per touched surface) covered:

- agent-sessions inmemory + integration routes
- webhook-worker (incl. 2 new dual-sign tests)
- byok-anthropic service (3 new TTL + observability tests)
- rate-limit headers integration (2 new buckets/429-path tests)
- billing.test.ts + billing-disabled.test.ts (3 new redirect tests)
- bootstrap content-parity (2 new pins)
- cross-SDK parity tests (3 new test files / 9 new assertions)

Drizzle + Postgres-backed integration runs deferred to CI per Rule R
(uncommitted at session end: 0).

## What's NOT addressed

Per Tier-3 blocking:

- AI-B2.b implementation — gated on Q.4 verdicts (still pending)
- Stripe LIVE keys swap — ~2026-05-21 BV KvK closure
- Bundled-LLM billing surface — design doc only at v1.0; full impl v1.1
- AI chat + manual feature implementation — design doc first arc

Per scope:

- Multi-archetype 2nd archetype landing in api-types — gated on Agent
  1 fork-side delivery (est. 3-5 days from 2026-05-17 per memory
  `project_multi_archetype_coordination_queued`).

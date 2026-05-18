# Arc 4 Wave 2.B — observability + SDK parity batch report — 2026-05-18

## Scope

Sixteen commits closing v2-#8 Wave 2.B (Prometheus metrics + alerts +
dashboards + audit emission) plus three pre-existing TS-error tails
and one real EGRESS propagation bug (EG-WK-1.9). All commits land on
`main` in the `driftstack-api` repo; tests green per slice; full SDK
takeover/handback parity across TS + Python + Go.

## Shipped

### v2-#8 Wave 2.B observability (the headline)

| Sub-slice | Commit     | One-line                                                                              |
| --------- | ---------- | ------------------------------------------------------------------------------------- |
| 8.20      | `76459017` | Customer audit log emission for pair-mode transitions (takeover / handback / timeout) |
| 8.18      | `2f826bb1` | In-process MetricsRegistry + `/metrics` route + pair-mode transition counter          |
| 8.19      | `2e61d58d` | Bundled-LLM Prometheus counters (request/error by outcome+kind)                       |
| 8.21      | `efbc7b9d` | Prometheus alert rules YAML + drift guard against METRIC_NAMES                        |
| 8.22      | `cfc9be8e` | Grafana dashboard JSON (pair-mode + bundled-LLM) + drift guard                        |
| 8.18.b    | `59c78949` | Wire MetricsRegistry into prod bootstrap (METRICS_SCRAPE_TOKEN env)                   |
| 8.20.b    | `cb65ffb6` | Dashboard ACTION_LABEL + FILTER_OPTIONS for the new pair-mode actions                 |
| 8.20.c    | `e792afba` | Docs `/api/audit-log.md` catalog completeness — caught 5 missing rows                 |
| 8.18.c    | `ac285746` | METRICS_SCRAPE_TOKEN env-loader tests (round-trip + .min(16) gate)                    |

### Real bug + parity slices

| Item         | Commit     | One-line                                                                                                                                                                                     |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EG-API-1.6.b | `b58b657c` | SOCKS5 `require_remote_dns` propagation fix — schema accepted it, backend dropped it. Silent DNS leak through the host's resolver for opted-in customers.                                    |
| v2-#16       | `a16a02c8` | Postmark email V-205 attribution sweep — guards against Claude/GPT/Copilot/AI-generated strings + lowercase "driftstack" prose drift                                                         |
| v2-#8 SDK    | `0ef71149` | TS SDK `takeover()` + `handback()` wrappers + 3 pre-existing TS-error tails closed (SocksProxyConfig require_remote_dns fixtures × 3, email service stubs × 4, DecomposeUsage type widening) |
| v2-#8 SDK    | `b8906d01` | Python + Go SDK `takeover` / `handback` parity (sync + async on Python; ctx-based on Go)                                                                                                     |
| v2-#8 SDK    | `a31d2ef3` | CHANGELOG entries on all three SDKs                                                                                                                                                          |

## What landed end-to-end

- **In-process MetricsRegistry**: 145-line Prometheus exposition
  renderer + counter/gauge primitives. No prom-client dep (avoids
  lockfile churn). 11 unit tests cover render shape, label
  escaping, validation, error paths. /metrics is bearer-token gated
  (METRICS_SCRAPE_TOKEN); 503 when token missing, 401 on mismatch.

- **Three counters** registered at bootstrap + emitted by routes:
  - `driftstack_pair_mode_transition_total{from,to}` — every
    pair-mode state-machine transition.
  - `driftstack_bundled_llm_request_total{outcome="ok"}` — every
    successful bundled-LLM resolution.
  - `driftstack_bundled_llm_error_total{kind="consent_missing|budget_exhausted"}`
    — failure paths.

- **Five Prometheus alert rules** (two pair-mode + three bundled-LLM)
  with severity labels + summary/description annotations. Drift
  guard pins alert YAML against METRIC_NAMES so renamed counters
  break CI before alerts go silent.

- **Two Grafana dashboards** with templated Prometheus datasource
  variable + drift guard against METRIC_NAMES.

- **Audit log full surface**: server emit (8.20) → dashboard label +
  filter (8.20.b) → docs catalog (8.20.c). Three-way drift guard.
  Also caught + filled 2 pre-existing missing rows
  (agent.decompose.claude / agent.decompose.deterministic) so the
  docs catalog is now complete against AccountAuditActionSchema.

- **SOCKS5 DNS leak fix (EG-WK-1.9 propagation)**: the founder verdict
  EG-WK-1.9 (2026-05-17 ~20:15 UTC) added
  `SocksProxyConfigSchema.require_remote_dns` so customers could opt
  into proxy-resolved DNS via SOCKS5 ATYP DOMAINNAME (0x03). The
  schema accepted the field but `SocksProxyBackend.applyToSession`
  destructured the proxy config without including it — the WebKit
  fork never saw the flag. Customers who relied on the contract for
  DNS-leak prevention were silently falling back to local
  resolution. Fix propagates as `DRIFTSTACK_SOCKS5_REQUIRE_REMOTE_DNS=1|0`.

- **3-SDK pair-mode parity**: takeover + handback wrappers on TS +
  Python (sync + async) + Go. Cross-SDK wire contract pinned by a
  unit test in each. CHANGELOG entries.

## Test surface delta

| Surface                                                                     | Tests added |
| --------------------------------------------------------------------------- | ----------: |
| `apps/server/tests/unit/metrics-registry.test.ts`                           |          11 |
| `apps/server/tests/integration/v2-8-pair-mode-metrics.test.ts`              |           2 |
| `apps/server/tests/integration/v2-8-bundled-llm-metrics.test.ts`            |           3 |
| `apps/server/tests/unit/alert-rules-drift.test.ts`                          |           4 |
| `apps/server/tests/unit/grafana-dashboards-drift.test.ts`                   |           6 |
| `apps/server/tests/unit/audit-log-page-pair-mode-actions-parity.test.ts`    |           3 |
| `apps/server/tests/unit/docs-audit-log-action-catalog-completeness.test.ts` |           2 |
| `apps/server/tests/unit/email-templates-v205-attribution-sweep.test.ts`     |           4 |
| `apps/server/tests/unit/proxy-backends-socks5.test.ts` (extension)          |           2 |
| `apps/server/tests/unit/config.test.ts` (extension)                         |           3 |
| `packages/sdk-typescript/tests/unit/agent-sessions.test.ts` (extension)     |           3 |
| `packages/sdk-python/tests/test_resources_agent_sessions.py` (extension)    |           2 |
| `packages/sdk-go/agent_sessions_test.go` (extension)                        |           2 |
| **Total**                                                                   |      **47** |

## Pre-existing TS errors closed

Tail of the earlier full-suite run reported 13 failures + 1 error.
Three categories of TS error closed in this batch:

1. `SocksProxyConfig` fixtures × 3 — `require_remote_dns` was a
   required field after the EG-WK-1.9 schema commit but the
   existing examples / unit / integration tests didn't include
   it. The `.default(false)` applies at parse-time, but the
   z.infer<>-derived TS type treats the field as required.

2. `createRecordingEmailService` × 1 — was missing four methods
   added by v2-#28 (webhook secret rotation reminder / force
   rotated / grace expiring + BYOK Anthropic key rotation reminder).
   Every email send in integration tests now records.

3. `agentDecomposerUsageRecords` × 1 — locally typed against an
   index-signature-bearing shape that didn't match the real
   `DecomposeUsage` interface (no index signature) and was missing
   the `keySource` field added in v2-#6 sub-slice 6.4.

Remaining ~10 failures are in other files (unrelated to this
batch's scope; surface them in a follow-up).

## Track diversification (Rule M v2)

Five tracks touched: observability, audit-log, EGRESS, email-V-205,
3-SDK parity. Rule M v2 self-lock (max 5 consecutive same-track
waves) honoured — pivoted out of observability after sub-slice 8.22
into EG-API-1.6.b, then dashboard / docs / email / SDK in rotation.

## Outstanding (next session)

- Wave 2.C GUI integration: 8.23 design doc + 8.24-8.28 Next.js
  scaffolding + 8.29 V-log. The customer-facing pair-mode dashboard
  UI is the v1.0 differentiator surface (per founder verdict
  2026-05-17 strategic directives — primary differentiator + Marketing
  M.6 Path A).
- Wave 2.D E2E integration smoke: 8.30-8.35 Cypress/Playwright.
- Arc 5 EGRESS Phase 1: remaining slices (EG-API-1.7 .. 1.9) — the
  Phase 1 SOCKS5 backend is wired; harness propagation + trust-page
  revision + V-log remain.
- Tail of the 10 unrelated test failures from the full-suite run.
- Stripe LIVE post-BV KvK cutover (2026-05-21) — gated on the founder
  swap (no code action needed; Q.2 safety guard already enforces).

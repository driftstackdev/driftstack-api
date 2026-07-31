---
layout: ../../layouts/DocLayout.astro
title: Prometheus metrics
description: GET /metrics — Prometheus-format scrape endpoint. Bearer-token gated; surfaces in-process counters covering auth, rate limits, webhooks (Stripe + NOWPayments + OAuth), pair-mode + agent decompose outcomes, and audit-log emissions.
---

# Prometheus metrics

`GET /metrics`

Driftstack exposes an in-process counter registry over a single
Prometheus-compatible scrape endpoint. The format is plain-text
exposition format (`text/plain; version=0.0.4; charset=utf-8`); any
Prometheus-compatible scraper (Prometheus itself, VictoriaMetrics,
Grafana Agent, OpenTelemetry Collector with the Prometheus receiver)
can consume it.

This page is **for operators**, not API consumers — you only need it
if you're integrating Driftstack into your own observability stack.

## Auth

The endpoint is publicly addressable (so external scrapers can reach
it without needing an internal-only path) but bearer-token gated:

```
GET /metrics HTTP/1.1
Host: api.driftstack.dev
Authorization: Bearer <METRICS_SCRAPE_TOKEN>
```

Missing / wrong token → `401`. Token-unset deployments → `503` (the
gate is opt-in; the registry isn't constructed unless the token
env var is wired).

The token rotates on the same cadence as other internal credentials
and is provisioned via the deploy bridge (`/opt/driftstack/api/.env`).

## Cardinality

All exposed counters use **bounded label sets** — every label value
comes from a closed enum or namespace prefix. There are no
account-id labels, no api-key-id labels, no IP-address labels. The
total time-series count is dominated by the cross-product of small
enums; the scrape size stays well under the Prometheus default
`sample_limit`.

## Catalogue

The current counter catalogue (all `driftstack_*` namespaced):

### Foundational

| Metric                          | Labels                            | What it tracks                                                                                                                                                                                   |
| ------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `driftstack_http_request_total` | `method`, `route`, `status_class` | Every HTTP request. `route` is the Fastify route TEMPLATE (e.g. `/v1/sessions/:id`), never the raw URL — keeps cardinality bounded by the registered-route count. `status_class` is `1xx`–`5xx`. |

### Auth + rate limiting

| Metric                                       | Labels              | What it tracks                                                                                                                                                                      |
| -------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_auth_total`                      | `outcome`           | requireAuth resolution outcomes (ok / unauthorized / invalid / revoked / expired / forbidden / error)                                                                               |
| `driftstack_rate_limit_total`                | `bucket`, `outcome` | rate-limit consumes per bucket × allowed/exceeded                                                                                                                                   |
| `driftstack_rate_limit_store_fallback_total` | `limiter`           | rate-limit primary-store (Redis) failures that degraded to the bounded in-process memory fallback — any non-zero value means the cluster is on coarse per-instance limiting (alert) |
| `driftstack_oauth_token_total`               | `outcome`           | OAuth /token exchange outcomes (ok + the OAuthError code set + error)                                                                                                               |

### Agent + LLM rails

| Metric                                  | Labels           | What it tracks                                                                                                                                                              |
| --------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_agent_decompose_total`      | `result_kind`    | agent decompose() calls by result (plan / clarify / refuse)                                                                                                                 |
| `driftstack_pair_mode_transition_total` | `from`, `to`     | pair-mode state-machine transitions                                                                                                                                         |
| `driftstack_bundled_llm_request_total`  | `outcome`        | bundled-LLM decompose requests by outcome                                                                                                                                   |
| `driftstack_bundled_llm_error_total`    | `kind`           | bundled-LLM decompose errors (consent_missing / budget_exhausted)                                                                                                           |
| `driftstack_byok_anthropic_test_total`  | `outcome`        | BYOK Anthropic /test endpoint outcomes (ok / invalid / quota_exceeded / not_set / unknown; not_wired is a legacy pre-live-tester label)                                     |
| `driftstack_retention_purge_total`      | `arm`, `outcome` | account-deletion retention purge by arm (byok / proxy_secrets / profiles / snapshots) and outcome (purged / failed / skipped); `skipped` means the arm was not wired at all |

### Webhook ingress

| Metric                                 | Labels    | What it tracks                                                                                                                                 |
| -------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_stripe_webhook_total`      | `outcome` | Stripe inbound webhook outcomes (handled / duplicate / ignored / error / signature_invalid / signature_missing / empty_body / malformed_event) |
| `driftstack_nowpayments_webhook_total` | `outcome` | NOWPayments IPN outcomes (ok / signature_invalid / signature_missing / empty_body / malformed_event)                                           |

### Webhook delivery (outbound)

| Metric                                       | Labels           | What it tracks                                                                                                    |
| -------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `driftstack_webhook_delivery_attempt_total`  | `outcome`        | Every dispatcher attempt to a customer's endpoint (success / http_error / timeout / transport_error)              |
| `driftstack_webhook_delivery_terminal_total` | `terminal_state` | Terminal-state transitions only — `delivered` on first 2xx, `dlq` when retries exhaust (DEFAULT_MAX_ATTEMPTS = 6) |

### Audit log

| Metric                                | Labels                 | What it tracks                                                |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| `driftstack_account_audit_emit_total` | `prefix`, `actor_type` | Customer-facing audit log emissions, namespace-bucketed       |
| `driftstack_admin_audit_emit_total`   | `prefix`               | Admin (`/v1/admin/*`) audit log emissions, namespace-bucketed |

### Live-preview (LiveKit)

| Metric                                       | Labels            | What it tracks                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `driftstack_livekit_token_mint_total`        | `role`, `outcome` | LiveKit token mint requests. Emitted by `/v1/agent-sessions/:id/livekit-token` (agent-chat; role = subscriber) — the sole token-mint path. Outcomes: ok / not_found / forbidden / no_mac / secret_unreadable. (The legacy `/v1/sessions/:id/livekit-token` route, which emitted role = publisher, was removed.)    |
| `driftstack_mac_node_livekit_register_total` | `outcome`         | `POST /v1/mac-nodes/register` outcomes per call: `ok` (credentials persisted), `validation` (Zod parse failed), `encryption_error` (AES-256-GCM seal failed; ops alert — likely MFA_ENCRYPTION_KEY length wrong), `not_found` (mac_node_id has no `fleet_nodes` row — Mac provisioning hasn't run yet), `unknown`. |

### Transactional email

| Metric                        | Labels                | What it tracks                                                                                                                                                                   |
| ----------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_email_send_total` | `template`, `outcome` | Outbound transactional-email sends per template × outcome (ok / pending-approval / inactive-recipient / account-inactive / invalid-request / rate-limited / transport / unknown) |

## Suggested alerts

Reasonable starting alerts (translate to your alert-manager rules
language):

- `rate(driftstack_auth_total{outcome="invalid"}[5m]) > 0.1`
  — sustained invalid-key rate suggests credential stuffing.
- `rate(driftstack_auth_total{outcome="revoked"}[15m]) > 0`
  — a revoked key is being retried; investigate the calling client
  (it should rotate its credentials).
- `rate(driftstack_stripe_webhook_total{outcome="signature_invalid"}[15m]) > 0`
  — any failed-signature webhook is a spoofing attempt; investigate.
- `rate(driftstack_nowpayments_webhook_total{outcome="signature_invalid"}[15m]) > 0`
  — same posture as Stripe; crypto-payment spoofing attempt.
- `rate(driftstack_bundled_llm_error_total{kind="budget_exhausted"}[1h]) > 1`
  — multiple customers hitting the bundled-LLM cap signals demand
  outstripping the deployment-fallback budget.
- `rate(driftstack_byok_anthropic_test_total{outcome="quota_exceeded"}[1h]) > 5`
  — multiple customers' Anthropic accounts are throttling; an
  upstream Anthropic-side incident.
- `rate(driftstack_oauth_token_total{outcome="invalid_client"}[15m]) > 0.5`
  — failed `client_id`+`client_secret` exchanges at scale signal a
  brute-force probe.
- `rate(driftstack_rate_limit_total{outcome="exceeded"}[5m]) > 1`
  — sustained limit hits across the account base; either ramp the
  defaults or audit which buckets saturate.
- `rate(driftstack_email_send_total{outcome="pending-approval"}[1h]) > 0`
  — Postmark approval is STILL blocking transactional sends; chase
  with their compliance team.
- `rate(driftstack_email_send_total{outcome="transport"}[15m]) > 0.1`
  — sustained Postmark connectivity failures; check the status page
  - the egress network from the API host.
- `sum by (prefix) (rate(driftstack_admin_audit_emit_total[1h])) > 10`
  — unusually high admin-action volume in any one prefix bucket;
  audit whether the activity is expected.

Set thresholds per your traffic baseline; the rates above are
illustrative.

## Format

The exposition format is the text-based variant documented at
[prometheus.io/docs/instrumenting/exposition_formats](https://prometheus.io/docs/instrumenting/exposition_formats/).
Counters emit:

```
# HELP driftstack_auth_total Auth resolution outcomes (...).
# TYPE driftstack_auth_total counter
driftstack_auth_total{outcome="ok"} 1234
driftstack_auth_total{outcome="invalid"} 7
```

Scraper-side resets: counters reset to 0 on process restart. The
standard Prometheus `rate()` and `irate()` functions handle resets
correctly; sum metrics over longer windows in your dashboards.

## Source of truth

Counter name + label catalogue lives in
`apps/server/src/services/metrics-registry.ts` (`METRIC_NAMES`
constant). The integration-test fixture pre-registers the same set;
contributors adding a new counter must update both + a parity test
typically lives alongside the call site.

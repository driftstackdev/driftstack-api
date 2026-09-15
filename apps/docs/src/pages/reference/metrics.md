---
layout: ../../layouts/DocLayout.astro
title: Prometheus metrics
description: GET /metrics — Prometheus-format scrape endpoint. Bearer-token gated; surfaces in-process counters covering auth, rate limits, webhooks (Stripe + NOWPayments + OAuth), AI agent outcomes, and audit-log emissions.
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
endpoint is opt-in; it is not enabled unless the token is set).

The endpoint is enabled by setting `METRICS_SCRAPE_TOKEN` in the API's
environment. Treat the token as a credential: keep it secret and rotate it
periodically.

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

| Metric                          | Labels                            | What it tracks                                                                                                                                                                           |
| ------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_http_request_total` | `method`, `route`, `status_class` | Every HTTP request. `route` is the route TEMPLATE (e.g. `/v1/sessions/:id`), never the raw URL — keeps cardinality bounded by the registered-route count. `status_class` is `1xx`–`5xx`. |

### Auth + rate limiting

| Metric                                       | Labels              | What it tracks                                                                                                                                                                                      |
| -------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_auth_total`                      | `outcome`           | authentication outcomes (ok / unauthorized / invalid / revoked / expired / forbidden / error)                                                                                                       |
| `driftstack_rate_limit_total`                | `bucket`, `outcome` | rate-limit consumes per bucket × allowed/exceeded                                                                                                                                                   |
| `driftstack_rate_limit_store_fallback_total` | `limiter`           | rate-limit store (Redis) failures that fell back to the bounded in-process memory counter — any non-zero value means limits are being counted per instance instead of across the deployment (alert) |
| `driftstack_oauth_token_total`               | `outcome`           | OAuth /token exchange outcomes (ok + the OAuthError code set + error)                                                                                                                               |

### Agent + LLM rails

| Metric                                   | Labels           | What it tracks                                                                                                                                                                                    |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_agent_decompose_total`       | `result_kind`    | AI agent planning calls by result (plan / clarify / refuse)                                                                                                                                       |
| `driftstack_pair_mode_transition_total`  | `from`, `to`     | pair-mode (AI / human control) transitions                                                                                                                                                        |
| `driftstack_bundled_llm_request_total`   | `outcome`        | bundled-AI planning requests by outcome                                                                                                                                                           |
| `driftstack_bundled_llm_error_total`     | `kind`           | bundled-AI planning errors (consent_missing / budget_exhausted)                                                                                                                                   |
| `driftstack_byok_anthropic_test_total`   | `outcome`        | BYOK Anthropic /test endpoint outcomes (ok / invalid / quota_exceeded / not_set / unknown; `not_wired` is a legacy label)                                                                         |
| `driftstack_unhandled_rejection_total`   | —                | unhandled errors caught by the process-level safety net; the service stays up by design, so a rising rate is the only sign that errors are being lost                                             |
| `driftstack_retention_purge_total`       | `arm`, `outcome` | account-deletion data purge by `arm` (byok / proxy_secrets / profiles / snapshots) and `outcome` (purged / failed / skipped); `skipped` means that data type is not configured on this deployment |
| `driftstack_scheduled_job_chain_pending` | `job_type`       | whether each recurring background job is still scheduled: 1 while its next run is pending, 0 when it has stopped and will not resume without a restart                                            |

### Webhook ingress

| Metric                                 | Labels    | What it tracks                                                                                                                                 |
| -------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_stripe_webhook_total`      | `outcome` | Stripe inbound webhook outcomes (handled / duplicate / ignored / error / signature_invalid / signature_missing / empty_body / malformed_event) |
| `driftstack_nowpayments_webhook_total` | `outcome` | NOWPayments IPN outcomes (ok / signature_invalid / signature_missing / empty_body / malformed_event)                                           |

### Webhook delivery (outbound)

| Metric                                       | Labels           | What it tracks                                                                                                  |
| -------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `driftstack_webhook_delivery_attempt_total`  | `outcome`        | Every delivery attempt to a customer's endpoint (success / http_error / timeout / transport_error)              |
| `driftstack_webhook_delivery_terminal_total` | `terminal_state` | Terminal-state transitions only — `delivered` on first 2xx, `dlq` when retries are exhausted (after 6 attempts) |

### Audit log

| Metric                                | Labels                 | What it tracks                                                |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| `driftstack_account_audit_emit_total` | `prefix`, `actor_type` | Customer-facing audit log emissions, namespace-bucketed       |
| `driftstack_admin_audit_emit_total`   | `prefix`               | Admin (`/v1/admin/*`) audit log emissions, namespace-bucketed |

### Live-preview (LiveKit)

| Metric                                       | Labels            | What it tracks                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_livekit_token_mint_total`        | `role`, `outcome` | LiveKit token mint requests. Emitted by `/v1/agent-sessions/:id/livekit-token` (agent-chat; role = subscriber) — the sole token-mint path. Outcomes: ok / not_found / forbidden / no_mac / secret_unreadable. (The legacy `/v1/sessions/:id/livekit-token` route, which emitted role = publisher, was removed.) |
| `driftstack_mac_node_livekit_register_total` | `outcome`         | `POST /v1/mac-nodes/register` outcomes per call: `ok` (credentials persisted), `validation` (the request body failed validation), `encryption_error` (the credentials could not be encrypted — check that `MFA_ENCRYPTION_KEY` is set correctly), `not_found` (no Mac matches the supplied id), `unknown`.      |

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
  — multiple customers hitting the bundled-AI cap means demand is
  outgrowing the deployment's shared budget.
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
  — sustained Postmark connectivity failures; check Postmark's status page
  and the API host's outbound network.
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

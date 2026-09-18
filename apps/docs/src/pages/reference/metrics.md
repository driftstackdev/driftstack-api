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

### AI agent turns

One request to `POST /v1/agent-sessions/:id/message` is counted once,
however it ended. The three `_seconds` metrics and
`driftstack_agent_turn_replans` are histograms: each is exposed as
`_bucket{le="…"}`, `_sum` and `_count` series, the shape
`histogram_quantile` reads. No label on any of them ever carries a
session, an account, a URL, the task or anything the model wrote.

| Metric                                                 | Labels                             | What it tracks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `driftstack_agent_turn_total`                          | `outcome`                          | requests by how they ended: completed / failed / halted_for_confirmation / clarified / refused / stopped / busy_409 (the previous turn is still running) / conflict_409 / rate_limited / rejected / error / manual_note / replayed (a retried request answered from its stored result)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `driftstack_agent_turn_duration_seconds`               | `outcome`                          | histogram — wall time of one request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `driftstack_agent_turn_phase_duration_seconds`         | `phase`                            | histogram — time a turn spent in each phase (planning / starting_browser / executing / reading_page / answering), summed when a phase repeats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `driftstack_agent_turn_time_to_first_progress_seconds` | `transport`                        | histogram — seconds from the request arriving to the first progress event of its turn; `transport` is `stream` (the caller asked for `text/event-stream` and sees it live) or `json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `driftstack_agent_turn_model_call_total`               | `call_kind`, `model`               | model calls that returned, by `call_kind` (plan / re_plan / answer / unattributed) and `model` (a model id from the published list, or `other`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `driftstack_agent_turn_tokens_total`                   | `token_type`, `call_kind`, `model` | model tokens by `token_type` (input / output / cache_read / cache_write)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `driftstack_agent_turn_replans`                        | `outcome`                          | histogram — how many times one turn went back to planning after a step failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `driftstack_agent_turn_step_failure_total`             | `reason`, `step_kind`              | failed steps by a fixed failure class and the kind of step (navigate / interact / wait / capture / scroll / behavioral_pause, or `none` when the failure was not on a step)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `driftstack_agent_turn_telemetry_write_total`          | `outcome`                          | writes of the per-turn diagnostics record (ok / error / dropped / shed). The write never delays or fails a turn, so this counter is the only place its failure shows: alert on `error` or `dropped`. `shed` is a per-minute budget on records for turned-away requests and is not a failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `driftstack_agent_pre_tap_look_total`                  | `outcome`                          | the check made before each tap (and before typing, which starts with a tap on the field) that the control is there and nothing is covering it: clear / covered (nothing tapped) / not_found (nothing tapped once waiting for it gave up; tapped as before when no wait was left) / outside_viewport (tapped after scrolling, as before) / unverified (a page fact: nothing at the tap point, or the control is not shown; tapped as before) / fallback (an infrastructure fact: no answer in time, or a browser too old to answer; tapped as before, unchecked). A tap refused as covered is also counted in `driftstack_agent_turn_step_failure_total` under `element_click_intercepted`, the same class as a tap the browser reports intercepted after trying — only this counter separates the two |
| `driftstack_agent_pre_tap_look_device_seconds`         | `outcome`                          | histogram — how long the browser spent on that check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `driftstack_agent_pre_tap_look_round_trip_seconds`     | `outcome`                          | histogram — how long a turn waited for that check: the time it adds to each tap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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
| `driftstack_mac_node_livekit_register_total` | `outcome`         | `POST /v1/mac-nodes/register` outcomes per call: `ok` (credentials persisted), `validation` (the request body failed validation), `encryption_error` (the credentials could not be encrypted — check that `MFA_ENCRYPTION_KEY` is set correctly), `not_found` (no machine matches the supplied id), `unknown`.  |

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
- `(sum(increase(driftstack_agent_turn_total{outcome="completed"}[6h])) or vector(0)) / sum(increase(driftstack_agent_turn_total{outcome=~"completed|failed|refused|stopped|error"}[6h])) < 0.5`
  — fewer than half of the AI turns that reached a verdict completed.
- `histogram_quantile(0.95, sum by (le) (rate(driftstack_agent_turn_time_to_first_progress_seconds_bucket{transport="stream"}[30m]))) > 5`
  — customers are waiting more than five seconds for the first sign
  that the AI is working.
- `sum(increase(driftstack_agent_turn_telemetry_write_total{outcome=~"error|dropped"}[15m])) > 0`
  — per-turn diagnostics are being lost; the turns themselves are
  unaffected.

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

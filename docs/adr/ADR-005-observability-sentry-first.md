# ADR-005 — Observability metrics destination + format (Sentry-first)

**Status:** Proposed — **but the METRICS half is CONTRADICTED BY THE SHIPPED
SYSTEM as of 2026-08-19. The structured-log half stands; see the reality check
below.**

> ### ⚠️ 2026-08-19 reality check (V-1082)
>
> The decision below says Sentry is the primary **metrics** destination and that a
> second observability destination is deferred, and point 5 says to skip dedicated
> metrics primitives at launch.
>
> `GET /metrics` ships a Prometheus exposition endpoint — its own header names
> VictoriaMetrics, Prometheus and Grafana Agent as the scrapers, gated on
> `METRICS_SCRAPE_TOKEN` and answering `503` when that is unset. That is a second
> metrics destination, in production, deferred by this record.
>
> The structured-LOG half is unaffected: Pino still writes to stdout and Sentry
> still ingests it, exactly as decided. Only the metrics sentence is overtaken.
> **Date:** 2026-05-03
> **Tier:** Architectural (Workstream-level decision; surfaces for review per Decision authority)
> **Related V-entry:** V-094 (this proposal). Touches V-058 (Sentry SDK), V-085 / V-091 / V-092 / V-093 (the structured logs that flow through the chosen destination).

## Context

The control plane has been growing observability surface area:

- **Pino structured logs** at every layer: middleware (`auth`, `rate-limit`), services (`stripe-webhooks`, `auth-flows`, `webhook-worker`, `sessions`), the inbound Stripe webhook handler, the Stripe API client, the auth-cache. Per V-092 / V-093 / V-080 / V-088 / V-089 / V-090 these emit at info / warn / error with structured field bags.
- **Sentry breadcrumbs + errors** (V-058): EU region (`*.ingest.de.sentry.io`), per-environment DSNs, `SENTRY_TRACES_SAMPLE_RATE` config knob already wired.
- **Health + readiness probes** (`/health`, `/ready`, V-059): synchronous probes against Postgres + Redis + R2.

What's missing: a documented destination + retention + query model for the structured logs. Today they emit to stdout (Pino default) and Sentry catches errors, but there's no aggregation tier — no "show me the rate-limit-exceeded events for account X over the last 7 days," no "what's the p95 webhook delivery duration for endpoint Y this week," no "how many session.failed events fired across the fleet today."

## Decision

**Adopt Sentry as the primary structured-log + metrics destination at launch (next 6-12 months).** Defer adding a second observability vendor (Better Stack / Axiom / Datadog) until Sentry's structured-log capacity, retention, or query depth becomes a documented bottleneck against actual production volume.

Concretely:

1. **Continue Pino → stdout for the application logger** (no change). Sentry's Node SDK ingests Pino via the `@sentry/node` integration that captures all Pino-emitted records as Sentry breadcrumbs + structured-log entries.
2. **Wire Sentry's structured-log feature** (Sentry "Logs" beta, GA in 2025) so Pino info / warn / error records flow into searchable structured-log storage in addition to landing as breadcrumbs on errors.
3. **Sample rate**: keep `SENTRY_TRACES_SAMPLE_RATE` at 0.1 (10%) for performance traces; structured logs ingest unsampled. Production volume at launch (estimated <100 RPS at launch ramp) is well under Sentry's free-tier ceilings.
4. **Retention**: Sentry's default 90-day retention for issues + 30-day for transactions is adequate at launch. Audit-relevant data (admin_audit_log) lives in Postgres independently and has its own retention via ADR-006.
5. **Custom metrics**: skip dedicated `@sentry/node` metrics primitives at launch. Pino structured-log fields + Sentry's log-aggregation queries cover the use cases (rate-limit-exceeded volumes, webhook delivery latency, session.failed counts) without custom-metric instrumentation.
6. **No separate APM vendor** at launch. Sentry's Performance Monitoring covers slow-endpoint detection adequately for our scale.

### Why Sentry-first

- **Already provisioned + on the locked sub-processor list** (V-052 / V-058). Adding a second vendor requires DPA Annex 3 amendment + 30-day customer notice — meaningful cost for a marginal benefit at launch volume.
- **EU region already wired** (`*.ingest.de.sentry.io` per ADR validation in V-053). No data-residency re-evaluation.
- **Structured-log feature exists** in Sentry as of 2025; not a v0 product.
- **Cost predictable**: at <100 RPS launch volume, the team-tier plan ($26/mo) plus structured-log addon stays well under the free-tier breakpoint. Compare to Datadog ($31/host/mo + per-event ingestion) which is built for higher-scale shops.
- **Single pane of glass**: errors, performance traces, structured logs, and breadcrumbs all in one tool. The team-of-one founder benefits from minimizing context-switches.

### When to revisit

Trigger any of the following → re-open this ADR:

- **Sentry log volume ingestion ceiling** hit. The team plan covers ~5M events/mo for issues + ~100k events/mo for structured logs at the time of writing. If structured-log volume grows past that ceiling, the per-event cost on Sentry exceeds the alternatives (Better Stack or Axiom) for high-volume log ingestion.
- **Query depth limitation**. If the operational queries we need ("p95 webhook duration by endpoint over the last 30 days, faceted by event_type") become impossible or slow in Sentry's structured-log query UI, we need a vendor with a richer query model.
- **Compliance requirement** for explicit log-retention SLAs that Sentry's defaults don't meet.
- **Customer-facing metrics surface needed** (e.g. customer dashboard showing per-endpoint webhook delivery latency) — would require a metrics vendor with a customer-facing API, which Sentry doesn't currently offer.

## Alternatives considered

### Better Stack (formerly Logtail)

- **Pro**: built specifically for structured-log ingestion + querying. SQL-shaped query language (BetterStack uses ClickHouse-backed storage). Generous free tier (1 GB/mo).
- **Con**: separate vendor → DPA amendment + customer notice. EU region requires the EU-region account specifically (not the default US).
- **Cost at launch volume**: ~free. Cost at production volume (100 RPS, ~25 GB/mo log volume): ~$130/mo on the Pro plan.
- **Why deferred**: marginal benefit over Sentry at launch volume; the DPA + sub-processor cost outweighs the query-depth advantage until we exhaust Sentry.

### Axiom

- **Pro**: best-in-class structured-log query language (APL — Kusto-derived). Generous free tier (500 GB/mo). EU region available.
- **Con**: separate vendor → same DPA cost. Less mature error-tracking than Sentry; we'd still need Sentry alongside, so this is additive cost.
- **Cost at launch volume**: free.
- **Why deferred**: same as Better Stack.

### Datadog

- **Pro**: full APM + logs + metrics + tracing in one. Industry-standard for larger shops.
- **Con**: built for higher scale than we need at launch. Per-host pricing ($31/mo per Hetzner VM + per-event ingestion) is overkill for a single-VM deploy. Significant DPA + integration setup cost.
- **Why deferred**: cost + complexity not justified at launch volume.

### OpenTelemetry-only (vendor-neutral)

- **Pro**: no vendor lock-in. Standardized instrumentation; ship to any backend.
- **Con**: still need a backend. The instrumentation work is real (Pino-to-OTel adapter is straightforward but not zero); the backend choice still has to be made.
- **Why deferred**: **NOT abandoned**. Plan to land OTel scaffolding alongside Sentry as a future portable path (V-NNN follow-on); for V-094 the destination decision lands as Sentry.

## Operational notes

- The structured-log fields landed in V-080 / V-085 / V-091 / V-092 / V-093 are already shaped for log-aggregation querying (`component`, `account_id`, `bucket_key`, `duration_ms`, `event_type`, `outcome`, etc.). No re-instrumentation needed when the Sentry "Logs" feature flips on.
- Sentry's per-environment DSN convention (V-053) is preserved: staging logs go to `staging` environment, production to `production`. Local dev does NOT ship to Sentry (DSN unset by default).
- Audit log retention (admin_audit_log, processed_stripe_events, legal_acceptances) is governed by ADR-006 (separate proposal) — Sentry is not a substitute for the on-disk audit ledger.

## Decision authority

This is **architectural / vendor-level** — surfaces for founder review per the Decision authority section in AGENTS.md. No production change until founder confirms the recommendation (or redirects to one of the alternatives).

// W551.A — drift guard for /docs/adr/ADR-005-observability-sentry-first.md.
// Architectural proposal. Drift here either weakens the
// Sentry-as-primary-destination posture (would invite a premature
// second-vendor DPA Annex 3 amendment + customer notice), drops
// the Pino-stdout-no-change baseline (would re-instrument when
// no re-instrumentation is needed), or weakens the 4-revisit-
// trigger inventory (would orphan the path to Better Stack /
// Axiom / Datadog when Sentry actually outgrows the use case).
//
//   • Status: Proposed (pending founder review).
//   • Related V-entry: V-094 (this proposal). Touches V-058
//     (Sentry SDK), V-085 + V-091-V-093 (structured logs).
//   • SENTRY_TRACES_SAMPLE_RATE=0.1; structured logs unsampled.
//   • Sentry 90d issues + 30d transactions retention default.
//   • OTel-only NOT abandoned — scaffolding follow-on, separate.
//   • Decision authority: Architectural → founder review per
//     AGENTS.md.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/adr/ADR-005-observability-sentry-first.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W551.A /docs/adr/ADR-005-observability-sentry-first.md content parity', () => {
  const body = read(LIB);

  it("Header + Status-Proposed + Related-V framing pinned: '# ADR-005 — Observability metrics destination + format (Sentry-first)' + '**Status:** Proposed (pending founder review)' + '**Date:** 2026-05-03' + '**Tier:** Architectural (Workstream-level decision; surfaces for review per Decision authority)' + '**Related V-entry:** V-094 (this proposal). Touches V-058 (Sentry SDK), V-085 / V-091 / V-092 / V-093 (the structured logs that flow through the chosen destination).' — pinned so the ADR-005-Proposed-2026-05-03 + Workstream-level-Decision-authority + V-094-this-proposal + V-058-Sentry-SDK + V-085/091/092/093-structured-logs commitment survives", () => {
    expect(body).toMatch(
      /^# ADR-005 — Observability metrics destination \+ format \(Sentry-first\)$/m,
    );
    // V-1082 — the status now records that the metrics half is overtaken. Both
    // halves are asserted separately so the qualifier cannot be dropped while the
    // word "Proposed" survives, which is how the record read as undecided while a
    // second metrics destination shipped.
    expect(body).toMatch(/\*\*Status:\*\* Proposed —/);
    expect(body, 'the metrics-half retraction is gone').toMatch(
      /METRICS half is CONTRADICTED BY THE SHIPPED\s*\n?\s*SYSTEM/,
    );
    expect(body, 'the page no longer says the log half is unaffected').toMatch(
      /The structured-LOG half is unaffected/,
    );
    expect(body, 'the shipped scrape endpoint is no longer named').toMatch(
      /`GET \/metrics` ships a Prometheus exposition endpoint/,
    );
    expect(
      body,
      'ADR-005 reads as simply pending again, with nothing recording the shipped scrape endpoint',
    ).not.toMatch(/\*\*Status:\*\* Proposed \(pending [a-z]+ review\)/);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-03/);
    expect(body).toMatch(
      /\*\*Tier:\*\* Architectural \(Workstream-level decision; surfaces for review per Decision authority\)/,
    );
    expect(body).toMatch(/\*\*Related V-entry:\*\* V-094 \(this proposal\)\./);
    expect(body).toMatch(
      /Touches V-058 \(Sentry SDK\), V-085 \/ V-091 \/ V-092 \/ V-093 \(the structured logs that flow through the chosen destination\)\./,
    );
  });

  it("Context — Pino-stdout + Sentry-EU-region + Health-Readiness baseline framing pinned: '**Pino structured logs** at every layer: middleware (`auth`, `rate-limit`), services (`stripe-webhooks`, `auth-flows`, `webhook-worker`, `sessions`)' + '**Sentry breadcrumbs + errors** (V-058): EU region (`*.ingest.de.sentry.io`), per-environment DSNs, `SENTRY_TRACES_SAMPLE_RATE` config knob already wired.' + '**Health + readiness probes** (`/health`, `/ready`, V-059): synchronous probes against Postgres + Redis + R2.' — pinned so the Pino-middleware/services-coverage + V-058-Sentry-EU-region + V-059-/health-/ready-Postgres+Redis+R2 commitment survives", () => {
    expect(body).toMatch(/- \*\*Pino structured logs\*\* at every layer: middleware/);
    expect(body).toMatch(/\(`auth`, `rate-limit`\), services \(`stripe-webhooks`, `auth-flows`,/);
    expect(body).toMatch(/`webhook-worker`, `sessions`\)/);
    expect(body).toMatch(/- \*\*Sentry breadcrumbs \+ errors\*\* \(V-058\): EU region/);
    expect(body).toMatch(
      /\(`\*\.ingest\.de\.sentry\.io`\), per-environment DSNs, `SENTRY_TRACES_SAMPLE_RATE` config knob already wired\./,
    );
    expect(body).toMatch(
      /- \*\*Health \+ readiness probes\*\* \(`\/health`, `\/ready`, V-059\): synchronous probes against Postgres \+ Redis \+ R2\./,
    );
  });

  it("Decision — Sentry-as-primary + 6-item concrete-implementation framing pinned: '**Adopt Sentry as the primary structured-log + metrics destination at launch (next 6-12 months).**' + '1. **Continue Pino → stdout for the application logger** (no change).' + '2. **Wire Sentry's structured-log feature** (Sentry \"Logs\" beta, GA in 2025)' + '3. **Sample rate**: keep `SENTRY_TRACES_SAMPLE_RATE` at 0.1 (10%) for performance traces; structured logs ingest unsampled.' + '4. **Retention**: Sentry's default 90-day retention for issues + 30-day for transactions' + '5. **Custom metrics**: skip dedicated `@sentry/node` metrics primitives at launch.' + '6. **No separate APM vendor** at launch.' — pinned so the Sentry-primary-6-12-months + Pino-stdout-no-change + Sentry-Logs-beta-GA-2025 + SENTRY_TRACES_SAMPLE_RATE-0.1-unsampled-logs + 90d-issues-30d-txn + no-custom-metrics + no-separate-APM commitment survives", () => {
    expect(body).toMatch(
      /\*\*Adopt Sentry as the primary structured-log \+ metrics destination at launch \(next 6-12 months\)\.\*\*/,
    );
    expect(body).toMatch(
      /1\. \*\*Continue Pino → stdout for the application logger\*\* \(no change\)\./,
    );
    expect(body).toMatch(
      /2\. \*\*Wire Sentry's structured-log feature\*\* \(Sentry "Logs" beta, GA in 2025\)/,
    );
    expect(body).toMatch(
      /3\. \*\*Sample rate\*\*: keep `SENTRY_TRACES_SAMPLE_RATE` at 0\.1 \(10%\) for performance traces; structured logs ingest unsampled\./,
    );
    expect(body).toMatch(
      /4\. \*\*Retention\*\*: Sentry's default 90-day retention for issues \+ 30-day for transactions is adequate at launch\./,
    );
    expect(body).toMatch(
      /5\. \*\*Custom metrics\*\*: skip dedicated `@sentry\/node` metrics primitives at launch\./,
    );
    expect(body).toMatch(/6\. \*\*No separate APM vendor\*\* at launch\./);
  });

  it("Why-Sentry-first + When-to-revisit 4-trigger framing pinned: 'Already provisioned + on the locked sub-processor list** (V-052 / V-058).' + 'EU region already wired** (`*.ingest.de.sentry.io` per ADR validation in V-053)' + 'Single pane of glass**: errors, performance traces, structured logs, and breadcrumbs all in one tool.' + 'Sentry log volume ingestion ceiling**' + 'Query depth limitation**' + 'Compliance requirement** for explicit log-retention SLAs that Sentry's defaults don't meet.' + 'Customer-facing metrics surface needed**' — pinned so the V-052/V-058-locked-sub-processor + V-053-de.sentry.io-EU + single-pane-of-glass + 4-revisit-trigger commitment survives", () => {
    expect(body).toMatch(
      /\*\*Already provisioned \+ on the locked sub-processor list\*\* \(V-052 \/ V-058\)\./,
    );
    expect(body).toMatch(
      /\*\*EU region already wired\*\* \(`\*\.ingest\.de\.sentry\.io` per ADR validation in V-053\)\./,
    );
    expect(body).toMatch(
      /\*\*Single pane of glass\*\*: errors, performance traces, structured logs, and breadcrumbs all in one tool\./,
    );
    expect(body).toMatch(/- \*\*Sentry log volume ingestion ceiling\*\* hit\./);
    expect(body).toMatch(/- \*\*Query depth limitation\*\*\./);
    expect(body).toMatch(
      /- \*\*Compliance requirement\*\* for explicit log-retention SLAs that Sentry's defaults don't meet\./,
    );
    expect(body).toMatch(/- \*\*Customer-facing metrics surface needed\*\*/);
  });

  it("Alternatives — Better-Stack + Axiom + Datadog + OpenTelemetry-only framing pinned: '### Better Stack (formerly Logtail)' + '### Axiom' + '### Datadog' + '### OpenTelemetry-only (vendor-neutral)' + '**Why deferred**: **NOT abandoned**. Plan to land OTel scaffolding alongside Sentry as a future portable path (V-NNN follow-on); for V-094 the destination decision lands as Sentry.' + Operational-notes Audit-log retention governed by ADR-006 separate proposal — Sentry is not a substitute — pinned so the 4-alternative-inventory + OTel-NOT-abandoned-scaffolding + ADR-006-separate-audit-ledger commitment survives", () => {
    expect(body).toMatch(/### Better Stack \(formerly Logtail\)/);
    expect(body).toMatch(/### Axiom/);
    expect(body).toMatch(/### Datadog/);
    expect(body).toMatch(/### OpenTelemetry-only \(vendor-neutral\)/);
    expect(body).toMatch(
      /\*\*Why deferred\*\*: \*\*NOT abandoned\*\*\. Plan to land OTel scaffolding alongside Sentry as a future portable path \(V-NNN follow-on\); for V-094 the destination decision lands as Sentry\./,
    );
    expect(body).toMatch(
      /Audit log retention \(admin_audit_log, processed_stripe_events, legal_acceptances\) is governed by ADR-006 \(separate proposal\) — Sentry is not a substitute for the on-disk audit ledger\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

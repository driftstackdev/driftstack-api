// W566.B — drift guard for /docs/internal/v547-chaos-engineering-scenarios.md.
// V-547 CATALOGUE 2026-05-11 Wave-23. Drift here either weakens the
// 10-scenario × 5-category inventory, drops the P0 pre-launch
// rehearsal posture (1+4+6+9), or unsets the V-547.B/C automation
// staging.
//
//   • V-547. CATALOGUE. Failure-scenario inventory.
//   • 5 categories: sub-processor + database + cache + storage +
//     infrastructure.
//   • 10 scenarios across the 5 categories.
//   • P0 pre-launch: scenarios 1+4+6+9.
//   • Quarterly post-launch + post-incident-30-day rehearsal.
//   • V-547.B/V-659 Wave-45 harness landed at scripts/chaos/ with
//     CHAOS_MODE=dry-run default, execute mode against docker-compose.
//   • V-547.C scheduled chaos drill cron + post-drill admin report.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v547-chaos-engineering-scenarios.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W566.B /docs/internal/v547-chaos-engineering-scenarios.md content parity', () => {
  const body = read(LIB);

  it("Header + V-547-CATALOGUE-Wave-23 + 5-category framing pinned: '# V-547 — chaos engineering scenarios' + '**Date:** 2026-05-11' + '**Wave:** 23' + '**Status:** CATALOGUE — failure-scenario inventory. Active rehearsal' + 'scripts land in V-547.B; integration into a scheduled drill cadence in' + 'V-547.C.' + '5 categories:' + '**Sub-processor outage** — Postmark / Sentry / Stripe / Anthropic' + '**Database failure** — Postgres unavailable, replica lag, migration' + '**Cache failure** — Redis unavailable, eviction storms, TTL' + '**Storage failure** — R2 timeout, partial upload, eventual' + '**Infrastructure failure** — Hetzner instance down, network' — pinned so the V-547-CATALOGUE-Wave-23-2026-05-11 + V-547.B-rehearsal + V-547.C-drill-cron + 5-category (sub-processor + database + cache + storage + infrastructure) commitment survives", () => {
    expect(body).toMatch(/^# V-547 — chaos engineering scenarios$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 23/);
    expect(body).toMatch(
      /\*\*Status:\*\* CATALOGUE — failure-scenario inventory\. Active rehearsal/,
    );
    expect(body).toMatch(/scripts land in V-547\.B; integration into a scheduled drill cadence in/);
    expect(body).toMatch(/V-547\.C\./);
    expect(body).toMatch(/5 categories:/);
    expect(body).toMatch(
      /1\. \*\*Sub-processor outage\*\* — Postmark \/ Sentry \/ Stripe \/ Anthropic/,
    );
    expect(body).toMatch(
      /2\. \*\*Database failure\*\* — Postgres unavailable, replica lag, migration/,
    );
    expect(body).toMatch(/3\. \*\*Cache failure\*\* — Redis unavailable, eviction storms, TTL/);
    expect(body).toMatch(/4\. \*\*Storage failure\*\* — R2 timeout, partial upload, eventual/);
    expect(body).toMatch(/5\. \*\*Infrastructure failure\*\* — Hetzner instance down, network/);
  });

  it("10 scenario inventory framing pinned: '### 1. Sub-processor: Postmark unavailable' + 'Postmark API returns 503 for 5 minutes.' + 'pending_emails' + 'Retry with exponential backoff (1m / 2m / 5m / 15m / 60m).' + '### 2. Sub-processor: Stripe webhook signature verification failure' + '`/v1/webhooks/stripe` returns 400 problem+json `invalid_signature`' + 'stripe-webhook-signature.test.ts' + '### 3. Sub-processor: Anthropic LLM provider timeout' + 'Anthropic API takes > 60s' + 'No charge on the customer's metered usage' + 'Retry budget: 2 attempts with 5s/15s backoff' + '### 4. Database: Postgres connection drop mid-transaction' + 'Drizzle re-establishes the connection on next query.' + 'in-flight transaction rolls back cleanly' + '`docker compose restart postgres` mid-load-test' + '### 5. Database: Drizzle migration applies but with errors' + 'partially applies' + 'Migration tooling rolls back the transaction (Drizzle migrations' + 'run in a transaction by default).' + '### 6. Cache: Redis unavailable' + 'Rate-limit middleware falls back to \"fail-open\"' + 'Session-token cache falls back to direct Postgres lookup' + '### 7. Storage: R2 PUT timeout' + 'R2 PUT takes > 30s.' + 'Capture endpoint returns 504 problem+json `upstream_timeout`' + '### 8. Storage: R2 PUT succeeds but DB write fails' + 'orphaned R2 object is logged for cleanup by the' + '`r2-orphan-sweep` job (already scheduled per V-512)' + '### 9. Infrastructure: Hetzner instance down' + 'Single-instance posture is intentional pre-launch' + '`docs/runbooks/hetzner-instance-down.md` (NOT YET WRITTEN' + '### 10. Infrastructure: TLS certificate expiry' + 'Let's Encrypt cert renewal fails for 24h before expiry.' + '7-day-before-expiry: monitoring alert fires.' + '3-day-before-expiry: critical alert' — pinned so the 10-scenario-inventory + 1-Postmark-503-5min-pending_emails-1/2/5/15/60-backoff + 2-Stripe-invalid_signature-test + 3-Anthropic-60s-no-charge-2-retry-5/15s + 4-Postgres-mid-tx-rollback + 5-Drizzle-tx-default + 6-Redis-fail-open + 7-R2-30s-504 + 8-R2-orphan-V-512-sweep + 9-Hetzner-single-runbook-not-written + 10-Lets-Encrypt-7-day/3-day-alert commitment survives", () => {
    expect(body).toMatch(/### 1\. Sub-processor: Postmark unavailable/);
    expect(body).toMatch(/Postmark API returns 503 for 5 minutes\./);
    expect(body).toMatch(/pending_emails/);
    expect(body).toMatch(/Retry with exponential backoff \(1m \/ 2m \/ 5m \/ 15m \/ 60m\)\./);
    expect(body).toMatch(/### 2\. Sub-processor: Stripe webhook signature verification failure/);
    expect(body).toMatch(/`\/v1\/webhooks\/stripe` returns 400 problem\+json `invalid_signature`/);
    expect(body).toMatch(/stripe-webhook-signature\.test\.ts/);
    expect(body).toMatch(/### 3\. Sub-processor: Anthropic LLM provider timeout/);
    expect(body).toMatch(/Anthropic API takes > 60s/);
    expect(body).toMatch(/No charge on the customer's metered usage/);
    expect(body).toMatch(/Retry budget: 2 attempts with 5s\/15s backoff/);
    expect(body).toMatch(/### 4\. Database: Postgres connection drop mid-transaction/);
    expect(body).toMatch(/Drizzle re-establishes the connection on next query\./);
    expect(body).toMatch(/in-flight transaction rolls back cleanly/);
    expect(body).toMatch(/`docker compose restart postgres` mid-load-test/);
    expect(body).toMatch(/### 5\. Database: Drizzle migration applies but with errors/);
    expect(body).toMatch(/partially applies/);
    expect(body).toMatch(/Migration tooling rolls back the transaction \(Drizzle migrations/);
    expect(body).toMatch(/run in a transaction by default\)\./);
    expect(body).toMatch(/### 6\. Cache: Redis unavailable/);
    expect(body).toMatch(/Rate-limit middleware falls back to "fail-open"/);
    expect(body).toMatch(/Session-token cache falls back to direct Postgres lookup/);
    expect(body).toMatch(/### 7\. Storage: R2 PUT timeout/);
    expect(body).toMatch(/R2 PUT takes > 30s\./);
    expect(body).toMatch(/Capture endpoint returns 504 problem\+json `upstream_timeout`/);
    expect(body).toMatch(/### 8\. Storage: R2 PUT succeeds but DB write fails/);
    expect(body).toMatch(/orphaned R2 object is logged for cleanup by the/);
    expect(body).toMatch(/`r2-orphan-sweep` job \(already scheduled per V-512\)/);
    expect(body).toMatch(/### 9\. Infrastructure: Hetzner instance down/);
    expect(body).toMatch(/Single-instance posture is intentional pre-launch/);
    expect(body).toMatch(/`docs\/runbooks\/hetzner-instance-down\.md` \(NOT YET WRITTEN/);
    expect(body).toMatch(/### 10\. Infrastructure: TLS certificate expiry/);
    expect(body).toMatch(/Let's Encrypt cert renewal fails for 24h before expiry\./);
    expect(body).toMatch(/7-day-before-expiry: monitoring alert fires\./);
    expect(body).toMatch(/3-day-before-expiry: critical alert/);
  });

  it("Rehearsal cadence + V-547.B/V-659/V-547.C sub-slices framing pinned: '## Rehearsal cadence' + '**Pre-launch:** all P0 scenarios (1, 4, 6, 9) rehearsed before first' + 'paying customer.' + '**Post-launch quarterly:** rotate through scenarios 1-10 over the' + '**Post-incident:** if a real incident hits a scenario in this' + 'catalogue, rehearse the related scenarios within 30 days.' + '## Sub-slices' + '**V-547 (Wave 23):** scenario catalogue (this doc).' + '**V-547.B / V-659 (Wave 45):** rehearsal harness landed at' + '`scripts/chaos/`. Covers scenarios 1, 2, 6' + 'Each script defaults to `CHAOS_MODE=dry-run`' + '`CHAOS_MODE=execute` fires the fault injection' + 'against a local docker-compose stack.' + 'Scenarios 4, 5, 7, 8 will land in V-547.B continuation slices' + '**V-547.C (later):** scheduled chaos drill cron + post-drill admin' + 'report.' + '## Verification' + '10 scenarios catalogued across 5 categories.' + 'V-205 + V-211 sweep: zero hits.' — pinned so the P0-pre-launch-1+4+6+9 + post-launch-quarterly + post-incident-30-day + V-547.B/V-659-Wave-45-scripts/chaos + CHAOS_MODE-dry-run/execute + scenarios-1+2+6-covered + 4/5/7/8-continuation + V-547.C-cron-drill + 10-across-5-V-205+V-211-zero-hits commitment survives", () => {
    expect(body).toMatch(/## Rehearsal cadence/);
    expect(body).toMatch(
      /- \*\*Pre-launch:\*\* all P0 scenarios \(1, 4, 6, 9\) rehearsed before first/,
    );
    expect(body).toMatch(/paying customer\./);
    expect(body).toMatch(/- \*\*Post-launch quarterly:\*\* rotate through scenarios 1-10 over the/);
    expect(body).toMatch(/- \*\*Post-incident:\*\* if a real incident hits a scenario in this/);
    expect(body).toMatch(/catalogue, rehearse the related scenarios within 30 days\./);
    expect(body).toMatch(/## Sub-slices/);
    expect(body).toMatch(/- \*\*V-547 \(Wave 23\):\*\* scenario catalogue \(this doc\)\./);
    expect(body).toMatch(/- \*\*V-547\.B \/ V-659 \(Wave 45\):\*\* rehearsal harness landed at/);
    expect(body).toMatch(/`scripts\/chaos\/`\. Covers scenarios 1, 2, 3, 6/);
    expect(body).toMatch(/Each script defaults to `CHAOS_MODE=dry-run`/);
    expect(body).toMatch(/`CHAOS_MODE=execute` fires the fault injection/);
    expect(body).toMatch(/against a local docker-compose stack\./);
    expect(body).toMatch(/Scenarios 4, 5, 7, 8 will/);
    expect(body).toMatch(/land in V-547\.B continuation slices/);
    expect(body).toMatch(
      /- \*\*V-547\.C \(later\):\*\* scheduled chaos drill cron \+ post-drill admin/,
    );
    expect(body).toMatch(/report\./);
    expect(body).toMatch(/## Verification/);
    expect(body).toMatch(/- 10 scenarios catalogued across 5 categories\./);
    expect(body).toMatch(/- V-205 \+ V-211 sweep: zero hits\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

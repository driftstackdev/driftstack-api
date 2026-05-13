// W567.B — drift guard for /docs/internal/v541-cost-monitoring-design.md.
// V-541 DESIGN doc 2026-05-10 Wave-20. Drift here either weakens the
// 4-component cost model (compute + storage + egress + sub-processor),
// drops the per-tier soft-warning/hard-cap ladder (€5/€15 → €30/€80 →
// €120/€300 → custom), or unsets the V-541.B/C/D sub-slice deferral.
//
//   • V-541. DESIGN. Implementation deferred to V-541.B/C/D.
//   • In-scope: per-account cost meter + alert thresholds + admin
//     endpoint + Postmark email delivery.
//   • Out-of-scope: real-time attribution + cross-cloud aggregation +
//     customer-facing dashboards.
//   • Cost model: compute (session-minutes) + storage (R2 GB-month) +
//     egress (TURN bytes) + sub-processor (Postmark+Sentry+Stripe+Anthropic).
//   • Hard-cap enforcement: 402 Payment Required at session-create.
//   • Persistence: cost_snapshots table, nightly BullMQ recompute.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v541-cost-monitoring-design.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W567.B /docs/internal/v541-cost-monitoring-design.md content parity', () => {
  const body = read(LIB);

  it("Header + V-541-DESIGN-Wave-20 + V-541.B-admin-stub + V-541.C-alert-wiring + Out-of-scope + In-scope framing pinned: '# V-541 — cost monitoring + alerting design' + '**Date:** 2026-05-10' + '**Wave:** 20' + '**Status:** DESIGN — implementation deferred to V-541.B (admin endpoint' + 'stub) and V-541.C (alert delivery wiring).' + 'V-541 designs the monitoring surface that catches this _before_ the' + 'month ends.' + '## Out of scope for v1' + 'Real-time per-request cost attribution (too expensive at request rate;' + 'Cross-cloud cost aggregation (just Hetzner + R2 + Postmark + Stripe' + 'Customer-facing cost dashboards (internal-admin-only for v1).' + '## In scope for v1' + '**Per-account cost meter** — running estimate of cost-to-serve per' + '**Alert thresholds** — per-account hard cap + soft warning. Defaults' + '**Admin endpoint** — `/v1/admin/cost/accounts/:id` (single account) +' + '`/v1/admin/cost/overview` (aggregate dashboard data).' + '**Alert delivery** — Postmark email to admins when a threshold trips.' — pinned so the V-541-DESIGN-Wave-20-2026-05-10 + V-541.B-admin-stub + V-541.C-alert-delivery + 3-out-of-scope (real-time + cross-cloud + customer-dashboard) + 4-in-scope (cost-meter + thresholds + admin-endpoint + Postmark-delivery) commitment survives", () => {
    expect(body).toMatch(/^# V-541 — cost monitoring \+ alerting design$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-10/);
    expect(body).toMatch(/\*\*Wave:\*\* 20/);
    expect(body).toMatch(
      /\*\*Status:\*\* DESIGN — implementation deferred to V-541\.B \(admin endpoint/,
    );
    expect(body).toMatch(/stub\) and V-541\.C \(alert delivery wiring\)\./);
    expect(body).toMatch(/V-541 designs the monitoring surface that catches this _before_ the/);
    expect(body).toMatch(/month ends\./);
    expect(body).toMatch(/## Out of scope for v1/);
    expect(body).toMatch(
      /- Real-time per-request cost attribution \(too expensive at request rate;/,
    );
    expect(body).toMatch(
      /- Cross-cloud cost aggregation \(just Hetzner \+ R2 \+ Postmark \+ Stripe/,
    );
    expect(body).toMatch(/- Customer-facing cost dashboards \(internal-admin-only for v1\)\./);
    expect(body).toMatch(/## In scope for v1/);
    expect(body).toMatch(/\*\*Per-account cost meter\*\* — running estimate of cost-to-serve per/);
    expect(body).toMatch(
      /\*\*Alert thresholds\*\* — per-account hard cap \+ soft warning\. Defaults/,
    );
    expect(body).toMatch(
      /\*\*Admin endpoint\*\* — `\/v1\/admin\/cost\/accounts\/:id` \(single account\) \+/,
    );
    expect(body).toMatch(/`\/v1\/admin\/cost\/overview` \(aggregate dashboard data\)\./);
    expect(body).toMatch(
      /\*\*Alert delivery\*\* — Postmark email to admins when a threshold trips\./,
    );
  });

  it("Cost model 4-component + per-tier threshold table framing pinned: '## Cost model' + 'cost_total = cost_compute + cost_storage + cost_egress + cost_subprocessor' + '### `cost_compute`' + 'Driven by **session-minutes**. Each session occupies a Mac mini slot for' + '### `cost_storage`' + 'Driven by **R2 object-bytes-month**.' + 'R2 rate: ~$0.015 / GB-month (egress free under Cloudflare).' + '### `cost_egress`' + 'R2 egress is free under Cloudflare' + 'TURN bytes-month — once V-531 production wiring lands, TURN bandwidth' + '### `cost_subprocessor`' + '**Postmark** — emails sent on behalf of the account / total emails ×' + '**Sentry** — events ingested on behalf of the account / total' + '**Stripe** — Stripe fees per transaction, attributed at transaction' + '**Anthropic** — if bundled-LLM agent feature is opt-in for the' + '## Alert thresholds' + '| Trial      | €5           | €15      | Throttle new sessions; admin email; customer email   |' + '| Tier-1     | €30          | €80      | Throttle new sessions; admin email                   |' + '| Tier-2     | €120         | €300     | Admin email only (large customer; expected variance) |' + '| Enterprise | custom       | custom   | Per-account configured' + 'Hard-cap enforcement happens at session-create time — if account is' + 'over hard cap for the current cycle, return `402 Payment Required`' — pinned so the cost_total-4-component-formula + cost_compute-session-minutes-Mac-mini + cost_storage-R2-$0.015/GB-month + cost_egress-TURN-bytes + cost_subprocessor-Postmark/Sentry/Stripe/Anthropic + 4-tier-threshold-Trial-€5/€15 + Tier-1-€30/€80 + Tier-2-€120/€300 + Enterprise-custom + 402-Payment-Required-at-session-create commitment survives", () => {
    expect(body).toMatch(/## Cost model/);
    expect(body).toMatch(
      /cost_total = cost_compute \+ cost_storage \+ cost_egress \+ cost_subprocessor/,
    );
    expect(body).toMatch(/### `cost_compute`/);
    expect(body).toMatch(
      /Driven by \*\*session-minutes\*\*\. Each session occupies a Mac mini slot for/,
    );
    expect(body).toMatch(/### `cost_storage`/);
    expect(body).toMatch(/Driven by \*\*R2 object-bytes-month\*\*\./);
    expect(body).toMatch(/- R2 rate: ~\$0\.015 \/ GB-month \(egress free under Cloudflare\)\./);
    expect(body).toMatch(/### `cost_egress`/);
    expect(body).toMatch(/R2 egress is free under Cloudflare's offering\./);
    expect(body).toMatch(/- TURN bytes-month — once V-531 production wiring lands, TURN bandwidth/);
    expect(body).toMatch(/### `cost_subprocessor`/);
    expect(body).toMatch(
      /- \*\*Postmark\*\* — emails sent on behalf of the account \/ total emails ×/,
    );
    expect(body).toMatch(/- \*\*Sentry\*\* — events ingested on behalf of the account \/ total/);
    expect(body).toMatch(
      /- \*\*Stripe\*\* — Stripe fees per transaction, attributed at transaction/,
    );
    expect(body).toMatch(/- \*\*Anthropic\*\* — if bundled-LLM agent feature is opt-in for the/);
    expect(body).toMatch(/## Alert thresholds/);
    expect(body).toMatch(
      /\| Trial\s+\| €5\s+\| €15\s+\| Throttle new sessions; admin email; customer email\s+\|/,
    );
    expect(body).toMatch(
      /\| Tier-1\s+\| €30\s+\| €80\s+\| Throttle new sessions; admin email\s+\|/,
    );
    expect(body).toMatch(
      /\| Tier-2\s+\| €120\s+\| €300\s+\| Admin email only \(large customer; expected variance\) \|/,
    );
    expect(body).toMatch(/\| Enterprise \| custom\s+\| custom\s+\| Per-account configured/);
    expect(body).toMatch(/Hard-cap enforcement happens at session-create time — if account is/);
    expect(body).toMatch(/over hard cap for the current cycle, return `402 Payment Required`/);
  });

  it("Admin endpoint surface + Alert delivery + cost_snapshots schema + Implementation slices + Open questions + Verification framing pinned: 'GET /v1/admin/cost/accounts/:accountId' + 'GET /v1/admin/cost/overview' + 'Both endpoints require admin auth + audit-log entry on read.' + '## Alert delivery (V-541.C implementation target)' + '**Admin email** — Postmark template `cost-alert-admin` with body' + '**Status page banner** (V-541.D)' + 'CREATE TABLE cost_snapshots' + 'account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,' + 'UNIQUE (account_id, billing_cycle)' + 'Cost snapshot recomputes nightly via a scheduled job (BullMQ on top of' + 'Redis 7 — already in the stack).' + '**V-541 (THIS WAVE):** design doc (this file).' + '**V-541.B (later):** admin endpoint stubs + cost-snapshot schema +' + '**V-541.C (later):** alert delivery via Postmark + scheduled-job for' + '**V-541.D (later):** status-page banner integration when platform' + '## Open questions for team review' + '**Currency** — EUR everywhere' + 'Recommendation: EUR.' + '**Reconciliation cadence** — monthly reconciliation against' + 'Recommendation: monthly (founder reviews' + '**Anthropic LLM cost attribution model** — pass-through pricing (cost' + 'V-205 + V-211 regex sweep on this file — zero hits.' — pinned so the admin-endpoint-accounts/:accountId + overview + audit-log-required + cost-alert-admin-Postmark + V-541.D-status-page-banner + cost_snapshots-schema-CASCADE-UNIQUE + BullMQ-Redis-7-nightly + V-541.B/C/D-implementation-slices + 3-open-questions (Currency-EUR + Reconciliation-monthly + Anthropic-pass-through) + V-205+V-211-zero-hits commitment survives", () => {
    expect(body).toMatch(/GET \/v1\/admin\/cost\/accounts\/:accountId/);
    expect(body).toMatch(/GET \/v1\/admin\/cost\/overview/);
    expect(body).toMatch(/Both endpoints require admin auth \+ audit-log entry on read\./);
    expect(body).toMatch(/## Alert delivery \(V-541\.C implementation target\)/);
    expect(body).toMatch(/\*\*Admin email\*\* — Postmark template `cost-alert-admin` with body/);
    expect(body).toMatch(/\*\*Status page banner\*\* \(V-541\.D\)/);
    expect(body).toMatch(/CREATE TABLE cost_snapshots/);
    expect(body).toMatch(/account_id\s+uuid NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE,/);
    expect(body).toMatch(/UNIQUE \(account_id, billing_cycle\)/);
    expect(body).toMatch(/Cost snapshot recomputes nightly via a scheduled job \(BullMQ on top of/);
    expect(body).toMatch(/Redis 7 — already in the stack\)\./);
    expect(body).toMatch(/- \*\*V-541 \(THIS WAVE\):\*\* design doc \(this file\)\./);
    expect(body).toMatch(
      /- \*\*V-541\.B \(later\):\*\* admin endpoint stubs \+ cost-snapshot schema \+/,
    );
    expect(body).toMatch(
      /- \*\*V-541\.C \(later\):\*\* alert delivery via Postmark \+ scheduled-job for/,
    );
    expect(body).toMatch(
      /- \*\*V-541\.D \(later\):\*\* status-page banner integration when platform/,
    );
    expect(body).toMatch(/## Open questions for team review/);
    expect(body).toMatch(/\*\*Currency\*\* — EUR everywhere/);
    expect(body).toMatch(/Recommendation: EUR\./);
    expect(body).toMatch(/\*\*Reconciliation cadence\*\* — monthly reconciliation against/);
    expect(body).toMatch(/Recommendation: monthly \(founder reviews/);
    expect(body).toMatch(
      /\*\*Anthropic LLM cost attribution model\*\* — pass-through pricing \(cost/,
    );
    expect(body).toMatch(/- V-205 \+ V-211 regex sweep on this file — zero hits\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

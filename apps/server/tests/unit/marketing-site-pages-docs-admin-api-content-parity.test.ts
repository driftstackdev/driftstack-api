// W518.A — drift guard for apps/marketing-site/src/pages/docs/admin-api.astro.
// V-710 admin API surface overview. Drift here either softens the
// driftstack_internal_admin scope gating commitment (would create
// marketing↔server-scope divergence) or relaxes the 3-cannot-do
// list (would mislead customer security reviewers).
//
//   • V-710 doc-comment framing + docs.driftstack.dev/quickstart-curl/ (S47) + /docs/audit-log
//     companion cross-refs.
//   • driftstack_internal_admin scope + preHandler-gated + DB-level-
//     provisioning + no-promote-to-admin-API.
//   • 3-cannot-do list: cannot-read-or-modify-other-customer-resources
//     + cannot-issue-crypto-refund (per /legal/refunds) + cannot-charge-
//     customer (Stripe + NowPayments not reachable from admin).
//   • 11-admin-crypto-orders endpoint surface: list + .csv + stats +
//     idempotency-metrics + pending-age + daily + :id + :id/events +
//     :id/apply-ipn + :id/internal-note + sweep-expired.
//   • V-666.BY / V-666.AM anchors on list filters / cursor.
//   • V-666.AP / V-666.AR anchors on idempotency-metrics counters.
//   • 4-other-admin-surface bullets: account-lifecycle + health-probe-
//     incident-mgmt + cost-monitoring-alert-overrides + audit-log-archive.
//   • admin_audit_log table + acting-admin-key-id + action + resource +
//     timestamp + ADR-006 90-day R2 archive.
//   • drift admin keys create/revoke CLI + SHA-256 hash + ≤60s auth-cache
//     propagation.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/admin-api.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W518.A apps/marketing-site/src/pages/docs/admin-api.astro content parity', () => {
  const body = read(LIB);

  it("V-710 framing pinned: 'overview of the admin API surface. Pitched at the founder + support ops; the page is publicly indexed so customers running audit reviews see what admin keys are capable of. Companion to /docs/api-quickstart (customer-facing surface) and /docs/audit-log (where admin actions land).' — pinned so the V-710 anchor + publicly-indexed-for-audit-reviewers + 2-companion-doc cross-refs survive (drift to making this internal-only would orphan customers from security-review evidence). Re-enabled by slice 169 after verifying the V-710 comment exists at admin-api.astro:4-8 with the matching shape", () => {
    expect(body).toMatch(
      /\/\/ V-710 — overview of the admin API surface\. Pitched at the founder\s*\n?\s*\/\/ \+ support ops; the page is publicly indexed so customers running\s*\n?\s*\/\/ audit reviews see what admin keys are capable of\. Companion to\s*\n?\s*\/\/ https:\/\/docs\.driftstack\.dev\/quickstart-curl\/ \(customer-facing surface\) and \/docs\/audit-log\s*\n?\s*\/\/ \(where admin actions land\)\./,
    );
  });

  it("driftstack_internal_admin scope framing pinned: 'Every admin endpoint is preHandler-gated on driftstack_internal_admin. A customer-facing API key cannot acquire this scope — minting an admin key requires direct DB-level provisioning (we explicitly do not expose a \"promote to admin\" API). The scope only unlocks the routes listed below; it does not bypass any customer-facing authentication.' — pinned so the preHandler-gating + customer-key-can't-acquire + DB-level-provisioning + no-promote-to-admin-API + does-NOT-bypass-customer-auth 5-commitment cluster survives", () => {
    expect(body).toMatch(
      /Every admin endpoint is preHandler-gated on\s*\n?\s*<code>driftstack_internal_admin<\/code>\. A customer-facing API\s*\n?\s*key cannot acquire this scope — minting an admin key requires\s*\n?\s*direct DB-level provisioning \(we explicitly do not expose a\s*\n?\s*"promote to admin" API\)\. The scope only unlocks the routes\s*\n?\s*listed below; it does <strong>not<\/strong> bypass any\s*\n?\s*customer-facing authentication\./,
    );
  });

  it("3-cannot-do framing pinned: cannot-read-or-modify-other-customer-resources (sessions / recordings / profiles / API keys, no admin-impersonation path) + cannot-issue-crypto-refund (non-refundable by policy, /legal/refunds binding rules, Stripe-dashboard-only with audit-only records) + cannot-charge-customer (Stripe + NowPayments only money-moving paths, neither reachable from admin scope) — pinned so the 3-bullet customer-trust commitment survives (drift to softening any 'cannot' would re-create admin-impersonation risk that customer security reviewers depend on)", () => {
    expect(body).toMatch(
      /Read or modify another customer's <strong>sessions<\/strong>,\s*\n?\s*<strong>recordings<\/strong>, <strong>profiles<\/strong>, or\s*\n?\s*<strong>API keys<\/strong>\. Those endpoints scope by\s*\n?\s*<code>account_id<\/code> on the calling key — there is no\s*\n?\s*admin-impersonation path\./,
    );
    expect(body).toMatch(
      /Issue a crypto refund\. Crypto payments are non-refundable\s*\n?\s*by policy; there is no admin endpoint that initiates a\s*\n?\s*crypto-side reversal\. See\s*\n?\s*<a href="\/legal\/refunds\/">\/legal\/refunds<\/a> for the binding\s*\n?\s*rules\. Stripe refund handling is unchanged and runs through\s*\n?\s*the Stripe dashboard with audit-only records on our side\./,
    );
    expect(body).toMatch(
      /Charge a customer\. Stripe \+ NowPayments are the only\s*\n?\s*money-moving paths and neither is reachable from the admin\s*\n?\s*scope\./,
    );
  });

  it('11-admin-crypto-orders endpoint surface pinned. Re-enabled by slice 238 after restoring V-666.BY + V-666.AM + V-666.AP/V-666.AR anchors on admin-api.astro:72-73,86 (three anchors stripped to bare-space-period in the same drift pattern as 235-237)', () => {
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/crypto-orders<\/code><\/td>/);
    expect(body).toMatch(/V-666\.BY/);
    expect(body).toMatch(/V-666\.AM/);
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/crypto-orders\.csv<\/code><\/td>/);
    expect(body).toMatch(/<td>Same filter set, CSV export \(up to 1000 rows \/ call\)\.<\/td>/);
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/crypto-orders\/stats<\/code><\/td>/);
    expect(body).toMatch(
      /<td><code>GET \/v1\/admin\/crypto-orders\/idempotency-metrics<\/code><\/td>/,
    );
    expect(body).toMatch(/V-666\.AP \/ V-666\.AR/);
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/crypto-orders\/pending-age<\/code><\/td>/);
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/crypto-orders\/daily\?days=N<\/code><\/td>/);
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/crypto-orders\/:order_id<\/code><\/td>/);
    expect(body).toMatch(
      /<td><code>GET \/v1\/admin\/crypto-orders\/:order_id\/events<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>POST \/v1\/admin\/crypto-orders\/:order_id\/apply-ipn<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td>Manually replay a missed NowPayments IPN\. Forward-only state machine\.<\/td>/,
    );
    expect(body).toMatch(
      /<td><code>PATCH \/v1\/admin\/crypto-orders\/:order_id\/internal-note<\/code><\/td>/,
    );
    expect(body).toMatch(/<td><code>POST \/v1\/admin\/crypto-orders\/sweep-expired<\/code><\/td>/);
  });

  it("4-other-admin-surface framing pinned: 'Account lifecycle (suspend / unsuspend / restore).' + 'Health probe + incident management for the public status page.' + 'Cost-monitoring alert overrides.' + 'Audit-log archive runs.' + 'Each is gated on the same scope and is audit-logged.' — pinned so the 4-other-surface enumeration + same-scope-gating + audit-logged commitment survives", () => {
    expect(body).toMatch(/<li>Account lifecycle \(suspend \/ unsuspend \/ restore\)\.<\/li>/);
    expect(body).toMatch(
      /<li>Health probe \+ incident management for the public status page\.<\/li>/,
    );
    expect(body).toMatch(/<li>Cost-monitoring alert overrides\.<\/li>/);
    expect(body).toMatch(/<li>Audit-log archive runs\.<\/li>/);
    expect(body).toMatch(/Each is gated on the same scope and is audit-logged\./);
  });

  it("admin_audit_log table + 4-field row shape + ADR-006 90-day R2 archive framing pinned: 'Every admin write lands in admin_audit_log with the acting admin key id, the action, the resource it touched, and a timestamp.' + /docs/audit-log cross-ref + 'Audit rows are archived to R2 after 90 days (per ADR-006).' — pinned so the table-name + 4-field row + 90-day retention + ADR-006 anchor + /docs/audit-log cross-ref commitment survives", () => {
    expect(body).toMatch(
      /Every admin write lands in <code>admin_audit_log<\/code> with the\s*\n?\s*acting admin key id, the action, the resource it touched, and\s*\n?\s*a timestamp\./,
    );
    expect(body).toMatch(/Audit rows are archived to R2 after 90 days \(per\s*\n?\s*ADR-006\)\./);
    expect(body).toMatch(
      /The customer-facing\s*\n?\s*<a href="\/docs\/audit-log\/">audit log<\/a> page documents the\s*\n?\s*schema\./,
    );
  });

  it("Minting + revoking admin key framing pinned: 'drift admin keys create --scope driftstack_internal_admin from a host with the DATABASE_URL set. The plaintext token is shown once + stored as a SHA-256 hash. There is no \"self-service promotion\" path; minting an admin key requires database access.' + 'drift admin keys revoke <key_id>. The key's revoked_at column is set; the next auth-cache refresh (≤ 60s) propagates the revocation to all server replicas.' — pinned so the CLI + DATABASE_URL + SHA-256-hash + no-self-service-promotion + revoked_at-column + ≤60s-auth-cache-propagation commitments survive", () => {
    expect(body).toMatch(
      /For internal staff: <code>drift admin keys create\s*\n?\s*--scope driftstack_internal_admin<\/code> from a host with the\s*\n?\s*<code>DATABASE_URL<\/code> set\. The plaintext token is shown\s*\n?\s*once \+ stored as a SHA-256 hash\. There is no "self-service\s*\n?\s*promotion" path; minting an admin key requires database\s*\n?\s*access\./,
    );
    expect(body).toMatch(
      /<code>drift admin keys revoke &lt;key_id&gt;<\/code>\. The key's\s*\n?\s*<code>revoked_at<\/code> column is set; the next auth-cache\s*\n?\s*refresh \(≤ 60s\) propagates the revocation to all server\s*\n?\s*replicas\./,
    );
  });

  it('3-related-doc cluster: /docs/audit-log + /docs/billing-crypto-overview + /docs/api-quickstart — pinned so the 3-related navigation surface stays complete (drift to dropping /docs/audit-log would orphan the schema cross-ref from the admin-action source)', () => {
    expect(body).toMatch(/<a href="\/docs\/audit-log\/">Audit log schema<\/a>/);
    expect(body).toMatch(
      /<a href="\/docs\/billing-crypto-overview\/">Crypto payments — how it works<\/a>/,
    );
    // S47 2026-07-07 (founder-approved: mirror deprecation): the api-quickstart mirror is deleted; href re-pinned to the docs successor.
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/quickstart-curl\/">Customer-facing API quickstart<\/a>/,
    );
    expect(body).not.toMatch(
      /href="\/(?:legal\/refunds|docs\/(?:audit-log|billing-crypto-overview))"/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

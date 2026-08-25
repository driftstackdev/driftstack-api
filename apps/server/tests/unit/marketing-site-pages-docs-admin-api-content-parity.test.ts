// W518.A — drift guard for apps/marketing-site/src/pages/docs/admin-api.astro.
// V-710 admin API surface overview. Drift here either softens the
// driftstack_internal_admin scope gating commitment (would create
// marketing↔server-scope divergence) or invents staff access,
// customer impersonation, route, or archive behavior.
//
//   • V-710 doc-comment framing + docs.driftstack.dev/quickstart-curl/ (S47) + /docs/audit-log
//     companion cross-refs.
//   • driftstack_internal_admin scope + preHandler gate + boot-time
//     staff/owner web-session authority + no self-service promotion.
//   • Bounded cross-account metadata/force actions without customer
//     impersonation, plaintext-key, or desktop-recording access.
//   • 11-admin-crypto-orders endpoint surface: list + .csv + stats +
//     idempotency-metrics + pending-age + daily + :id + :id/events +
//     :id/apply-ipn + :id/internal-note + sweep-expired.
//   • V-666.BY / V-666.AM anchors on list filters / cursor.
//   • V-666.AP / V-666.AR anchors on idempotency-metrics counters.
//   • Three exact status-subscriber operations + offset/data envelope.
//   • Representative other-admin-surface bullets.
//   • admin_audit_log table + acting-admin-key-id + action + resource +
//     timestamp, without an unwired R2 archive claim.
//   • Staff allowlist/owner auth and controlled-restart revocation; no
//     fictional admin-key CLI.

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
      /\/\/ V-710 — overview of the admin API surface\. Pitched at the founder\s*\/\/ \+ support ops; the page is publicly indexed so customers running\s*\/\/ audit reviews see what admin keys are capable of\. Companion to\s*\/\/ https:\/\/docs\.driftstack\.dev\/quickstart-curl\/ \(customer-facing surface\) and \/docs\/audit-log\s*\/\/ \(where admin actions land\)\./,
    );
  });

  it('pins the staff web-session allowlist and generated-OpenAPI authority boundary', () => {
    expect(body).toMatch(
      /Every admin endpoint is preHandler-gated on\s*<code>driftstack_internal_admin<\/code>\. Customer key-management\s*APIs cannot grant that scope\./,
    );
    expect(body).toMatch(
      /normal authenticated web session whose exact account email is\s*present in the server's boot-time staff allowlist/,
    );
    expect(body).toMatch(/no\s*public or self-service "promote to admin" operation/);
    expect(body).toMatch(/generated\s*OpenAPI document is the authoritative current route list/);
  });

  it('pins bounded metadata authority, no impersonation/plaintext, local recordings, refunds, and charges', () => {
    expect(body).toMatch(
      /Impersonate a customer or turn an admin credential into a\s*customer-scoped API credential\. Bounded admin routes can inspect\s*cross-account session and API-key <em>metadata<\/em>, force-destroy a\s*session, and revoke a key, but they do not reveal API-key plaintext or\s*expose customer-scoped resources through impersonation\. Desktop\s*recordings are local files and never enter the admin API\./,
    );
    expect(body).not.toMatch(/<strong>recordings<\/strong>/);
    expect(body).toMatch(
      /Issue a crypto refund\. Crypto payments are non-refundable\s*by policy; there is no admin endpoint that initiates a\s*crypto-side reversal\. See\s*<a href="\/legal\/refunds\/">\/legal\/refunds<\/a> for the binding\s*rules\. Stripe refund handling is unchanged and runs through\s*the Stripe dashboard with audit-only records on our side\./,
    );
    expect(body).toMatch(
      /Charge a customer\. Stripe \+ NowPayments are the only\s*money-moving paths and neither is reachable from the admin\s*scope\./,
    );
  });

  it('11-admin-crypto-orders endpoint, filters, cursor, and idempotency metrics surface pinned', () => {
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/crypto-orders<\/code><\/td>/);
    expect(body).toMatch(
      /<code>created_after<\/code> \/\s*<code>created_before<\/code>\. Cursor-paginated via\s*<code>next_cursor<\/code>\./,
    );
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/crypto-orders\.csv<\/code><\/td>/);
    expect(body).toMatch(/<td>Same filter set, CSV export \(up to 1000 rows \/ call\)\.<\/td>/);
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/crypto-orders\/stats<\/code><\/td>/);
    expect(body).toMatch(
      /<td><code>GET \/v1\/admin\/crypto-orders\/idempotency-metrics<\/code><\/td>/,
    );
    expect(body).toMatch(/Counters for first-write vs replay vs body-mismatch/);
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

  it('pins all status-subscriber operations and their offset/data envelope', () => {
    expect(body).toMatch(/<td><code>GET \/v1\/admin\/status-subscribers<\/code><\/td>/);
    expect(body).toMatch(
      /<td><code>POST \/v1\/admin\/status-subscribers\/force-subscribe<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>POST \/v1\/admin\/status-subscribers\/:id\/force-unsubscribe<\/code><\/td>/,
    );
    expect(body).toMatch(/<code>limit<\/code> \(1–200\)/);
    expect(body).toMatch(/<code>offset<\/code> \(0 or greater\)/);
    expect(body).toMatch(/<code>&#123; data: \[\.\.\.\] &#125;<\/code>/);
    expect(body).toMatch(/does not return a cursor/);
  });

  it('representative other-admin surfaces stay explicit', () => {
    expect(body).toMatch(/<li>Account lifecycle \(suspend \/ unsuspend \/ restore\)\.<\/li>/);
    expect(body).toMatch(/Cross-account session and API-key metadata plus bounded force actions/);
    expect(body).toMatch(/Webhook delivery dead-letter inspection and recovery/);
    expect(body).toMatch(
      /<li>Health probe \+ incident management for the public status page\.<\/li>/,
    );
    expect(body).toMatch(/<li>Cost-monitoring alert overrides\.<\/li>/);
    expect(body).toMatch(/<li>Audit-log inspection\.<\/li>/);
    expect(body).toMatch(/Each is gated on the same scope and is audit-logged\./);
  });

  it('pins admin audit rows without claiming an unwired R2 archive', () => {
    expect(body).toMatch(
      /Every admin write lands in <code>admin_audit_log<\/code> with the\s*acting admin key id, the action, the resource it touched, and\s*a timestamp\./,
    );
    expect(body).toMatch(/does not claim an active R2 archive pipeline/);
    expect(body).not.toMatch(/archived to R2 after 90 days/);
    expect(body).toMatch(
      /The customer-facing\s*<a href="\/docs\/audit-log\/">audit log<\/a> page documents the\s*schema\./,
    );
  });

  it('pins implemented staff allowlist access and controlled revocation without a fictional CLI', () => {
    expect(body).toMatch(
      /server adds\s*<code>driftstack_internal_admin<\/code> only when the account email matches\s*<code>DRIFTSTACK_STAFF_EMAILS<\/code> or the configured\s*<code>DRIFTSTACK_OWNER_EMAIL<\/code>/,
    );
    expect(body).toMatch(
      /Revoke the affected web session and remove the email from staff authority/,
    );
    expect(body).toMatch(/does\s+not publish a separate admin-key CLI/);
    expect(body).not.toMatch(/drift admin keys (?:create|revoke)/);
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

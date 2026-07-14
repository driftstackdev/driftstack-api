// W513.C — drift guard for apps/marketing-site/src/pages/docs/crypto-orders-ops-runbook.astro.
// V-721 ops runbook for the crypto-orders surface. Drift here either softens
// the "stuck order" replay procedure (would create marketing↔admin-IPN-replay
// divergence) or breaks the duplicate-charge guidance (would mislead support).
//
//   • V-721 doc-comment framing.
//   • Customer-facing-published rationale: non-refundable policy makes every
//     support decision consequential.
//   • payment_id reverse-lookup via admin list filter (exact match, not fuzzy
//     search).
//   • "Stuck in pending" 4-step playbook: pull → check age 60min → tx-hash
//     cross-ref → replay IPN or sweep failed.
//   • Duplicate charge: V-666.AO idempotency + body_mismatches counter.
//   • Timeline /events endpoint + 5 source tags: create/ipn/cancel/expired/swept.
//   • Failed 3-cause: NowPayments terminal + pay-window-expired + admin sweep.
//   • crypto.order.failed reason field: ipn/expired/swept + not-yet-subscribable.
//   • V-666.BY date-range CSV export.
//   • crypto_checkout_idempotency_body_mismatch log event.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/crypto-orders-ops-runbook.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W513.C apps/marketing-site/src/pages/docs/crypto-orders-ops-runbook.astro content parity', () => {
  const body = read(LIB);

  it("V-721 customer-facing-published rationale pinned — pinned so the V-721 anchor + admin-API-link + non-refundable-auditability rationale all survive. Re-enabled by slice 200 after verifying both V-721 + 'Customer-facing? Yes' comments exist at crypto-orders-ops-runbook.astro:4-12 with the matching shape", () => {
    expect(body).toMatch(
      /\/\/ V-721 — ops runbook for the crypto-orders surface\. Internal-\s*\n?\s*\/\/ facing page \(linked from \/docs\/admin-api\) that walks support\s*\n?\s*\/\/ through the common drill-downs/,
    );
    expect(body).toMatch(
      /\/\/ Customer-facing\? Yes — the page lives on the public docs site\s*\n?\s*\/\/ rather than the internal wiki\. Reasoning: founder wants the\s*\n?\s*\/\/ support runbook to be auditable by customers, since the\s*\n?\s*\/\/ non-refundable policy means every ops decision is consequential\./,
    );
  });

  it("payment_id reverse-lookup framing pinned: 'the admin list endpoint accepts an exact-match payment_id query param' + 'GET /v1/admin/crypto-orders?payment_id=np_abc123' + admin GUI 'Payment ID' filter input + distinct-from-fuzzy-search framing — pinned so the exact-match + fuzzy-distinction + admin-GUI-input survive (drift to claiming the search param walks payment_id would mislead support about the routing)", () => {
    expect(body).toMatch(
      /The fastest reverse-lookup path: the admin list endpoint\s*\n?\s*accepts an exact-match <code>payment_id<\/code> query param\./,
    );
    expect(body).toMatch(/GET \/v1\/admin\/crypto-orders\?payment_id=np_abc123/);
    expect(body).toMatch(
      /Available in the\s*\n?\s*admin GUI as the "Payment ID" filter input next to the search\s*\n?\s*box\. Distinct from the fuzzy <code>search<\/code> param \(which\s*\n?\s*walks order_id \/ product \/ customer_note\)/,
    );
  });

  it("Stuck-in-pending 4-step playbook + 60-min pay-window + sweep-expired endpoint + apply-ipn endpoint with payment_id + provider_status: 'finished' framing pinned — pinned so the 4-step playbook + 60-min-pay-window + 2-admin-endpoint (sweep-expired + apply-ipn) + provider_status finished commitment all survive (drift to a different pay-window would let support sweep customers prematurely; drift to renaming the admin endpoints would create marketing↔admin-route divergence)", () => {
    expect(body).toMatch(
      /Pay windows are ~60 minutes\. Orders past\s*\n?\s*that without an IPN are candidates for sweep\s*\n?\s*\(<code>POST \/v1\/admin\/crypto-orders\/sweep-expired<\/code>\)/,
    );
    expect(body).toMatch(
      /manually\s*\n?\s*replay the IPN:\s*\n?\s*<code>POST \/v1\/admin\/crypto-orders\/:id\/apply-ipn<\/code> with\s*\n?\s*the recorded <code>payment_id<\/code> \+\s*\n?\s*<code>provider_status: 'finished'<\/code>\./,
    );
  });

  it('Duplicate-charge framing pinned. Re-enabled by slice 257 after restoring the V-666.AO anchor on the idempotency-keys sentence at crypto-orders-ops-runbook.astro:65 (anchor stripped to bare space + indentation lost)', () => {
    expect(body).toMatch(/Crypto orders don't touch cards — that's the Stripe surface\./);
    expect(body).toMatch(/double-click → handled by V-666\.AO idempotency keys/);
    expect(body).toMatch(
      /Check the <code>idempotency-metrics<\/code> endpoint —\s*\n?\s*does the <code>replays<\/code> count match/,
    );
    expect(body).toMatch(
      /this is a customer-side\s*\n?\s*bug \(their integration sent two distinct Idempotency-Keys\s*\n?\s*for what they intended as one intent\)\. Crypto is non-\s*\n?\s*refundable; the resolution is to credit the customer's\s*\n?\s*next billing cycle, not refund\./,
    );
  });

  it("Timeline /events endpoint + 5 source tags pinned: GET /v1/admin/crypto-orders/:id/events + 'append-only event log oldest-first' + 'each event carries the destination status, an ISO-8601 timestamp, and a source tag — create, ipn, cancel, expired, or swept' — pinned so the events-endpoint + append-only-oldest-first + ISO-8601 + 5-source-tag enum (create/ipn/cancel/expired/swept) all survive (drift to dropping any source tag would shrink the audit surface)", () => {
    expect(body).toMatch(/GET \/v1\/admin\/crypto-orders\/:id\/events/);
    expect(body).toMatch(
      /Returns the order's append-only event log oldest-first\. Each\s*\n?\s*event carries the destination status, an ISO-8601 timestamp,\s*\n?\s*and a <code>source<\/code> tag — <code>create<\/code>,\s*\n?\s*<code>ipn<\/code>, <code>cancel<\/code>, <code>expired<\/code>,\s*\n?\s*or <code>swept<\/code>\./,
    );
  });

  it('Failed-order 3-cause framing pinned: NowPayments terminal failure (failed/expired/refunded) + pay window elapsed + admin sweep + crypto.order.failed reason field with ipn/expired/swept + customer-subscribable framing — pinned so the 3-cause + 3-reason-enum + subscribable status survive. 2026-05-22 — migration 0064 + bootstrap wire (ee725ba3) flipped the event LIVE; doc + pin flipped accordingly. Anti-drift: claiming the event is NOT subscribable would re-create the pre-0064 stale framing.', () => {
    expect(body).toMatch(
      /NowPayments reported a terminal failure\s*\n?\s*\(<code>failed<\/code> \/ <code>expired<\/code> \/\s*\n?\s*<code>refunded<\/code>\)/,
    );
    expect(body).toMatch(
      /Server-side, the <code>crypto\.order\.failed<\/code> event\s*\n?\s*emitted by these transitions carries a <code>reason<\/code>\s*\n?\s*field with one of <code>ipn<\/code> \/ <code>expired<\/code> \/\s*\n?\s*<code>swept<\/code>\./,
    );
    expect(body).toMatch(/This event is customer-subscribable/);
  });

  it('V-666.BY CSV export with date-range + status filter framing pinned. Re-enabled by slice 257 after restoring the V-666.BY anchor on the date-range scoping paragraph at crypto-orders-ops-runbook.astro:131', () => {
    expect(body).toMatch(
      /V-666\.BY: scope the export to a date window with\s*\n?\s*<code>\?created_after<\/code> \+ <code>\?created_before<\/code>\s*\n?\s*\(ISO 8601\)\. Both work on the JSON list, the CSV endpoint, and\s*\n?\s*the admin GUI's From\/To inputs\. Combine with\s*\n?\s*<code>\?status=paid<\/code> for a nightly paid-only reconcile\./,
    );
    expect(body).toMatch(
      /GET \/v1\/admin\/crypto-orders\.csv\?status=paid&created_after=2026-05-01T00:00:00Z&created_before=2026-05-12T00:00:00Z/,
    );
  });

  it("body_mismatches + structured warn log framing pinned: '/v1/admin/crypto-orders/idempotency-metrics' + 'A non-zero number means at least one client is reusing keys across distinct intents — usually a hardcoded constant where a generated UUID belongs.' + 'crypto_checkout_idempotency_body_mismatch carries the account id; grep for the offending integration.' — pinned so the body_mismatches counter + hardcoded-constant-vs-UUID heuristic + structured-log-event-name survive (drift to renaming the log event would create marketing↔structured-log divergence)", () => {
    expect(body).toMatch(
      /Check the <code>body_mismatches<\/code> counter on\s*\n?\s*<code>\/v1\/admin\/crypto-orders\/idempotency-metrics<\/code>\. A\s*\n?\s*non-zero number means at least one client is reusing keys\s*\n?\s*across distinct intents — usually a hardcoded constant where\s*\n?\s*a generated UUID belongs\./,
    );
    expect(body).toMatch(
      /<code>event: 'crypto_checkout_idempotency_body_mismatch'<\/code>\)\s*\n?\s*carries the account id; grep for the offending integration\./,
    );
  });

  it('6-related-doc cluster: /docs/admin-api + /docs/admin-api-pagination + /docs/admin-csv-export + /docs/idempotency-keys + /docs/billing-crypto-integration-guide + /legal/refunds — pinned so the 6-related-doc navigation surface stays complete (drift to dropping /legal/refunds would orphan the non-refundable policy from the runbook)', () => {
    expect(body).toMatch(/<a href="\/docs\/admin-api\/">Admin API overview<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/admin-api-pagination\/">Admin API pagination<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/admin-csv-export\/">Admin CSV export<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/idempotency-keys\/">Idempotency keys<\/a>/);
    expect(body).toMatch(
      // S47 2026-07-07 (founder-approved: mirror deprecation): the integration-guide mirror is deleted; href re-pinned to the docs successor.
      /<a href="https:\/\/docs\.driftstack\.dev\/guides\/paying-with-crypto\/">Integration guide<\/a>/,
    );
    expect(body).toMatch(/<a href="\/legal\/refunds\/">Non-refundable policy<\/a>/);
    expect(body).not.toMatch(
      /href="\/(?:docs\/admin-api|docs\/admin-api-pagination|docs\/admin-csv-export|docs\/idempotency-keys|legal\/refunds)"/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

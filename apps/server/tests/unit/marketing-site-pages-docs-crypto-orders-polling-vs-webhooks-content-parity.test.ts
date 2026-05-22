// W509.A — drift guard for apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro.
// V-666.BV practitioner guide. Drift here either drops the now-LIVE
// webhook subscription path (would silently push customers back to
// polling-only) or breaks the polling-cadence guidance customers rely
// on for the fallback path.
//
//   • V-666.BV doc-comment framing (flipped 2026-05-22 alongside
//     the schema + bootstrap wire-up).
//   • crypto-order state machine: pending → confirming → paid /
//     failed / partial / cancelled.
//   • crypto.order.paid + crypto.order.failed in
//     SubscribableWebhookEventTypeSchema; polling is a fallback.
//   • Polling fallback: GET /v1/billing/crypto-orders.
//   • 3-cadence guidance: 1-5s + 30-60s + hourly/nightly + V-666.BU
//     cursor + V-534 history view + V-534.BS 60s default.
//   • Recommended hybrid: webhooks + reconciliation polling.
//   • Idempotency for hybrid receivers: (order_id, status) upsert key.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W509.A apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro content parity', () => {
  const body = read(LIB);

  it('V-666.BV framing pinned. Post-2026-05-22: crypto.order.paid/failed are in SubscribableWebhookEventTypeSchema; doc-comment reflects that webhook subscription is supported alongside polling.', () => {
    expect(body).toMatch(
      /\/\/ V-666\.BV — practitioner guide on how to detect crypto-order state\s*\n?\s*\/\/ changes\. As of 2026-05-22 `crypto\.order\.paid` and\s*\n?\s*\/\/ `crypto\.order\.failed` are in SubscribableWebhookEventTypeSchema,\s*\n?\s*\/\/ so this page now documents both the polling pattern and the\s*\n?\s*\/\/ \(now-shipped\) hybrid webhook \+ reconciliation pattern\./,
    );
  });

  it("Order state-machine framing pinned: 'pending → confirming → paid (or failed / partial / cancelled)' — pinned so the 5-state crypto-order lifecycle stays consistent (drift to adding/dropping a state would create marketing↔OpenAPI-enum divergence)", () => {
    expect(body).toMatch(
      /A crypto order's status moves between\s*\n?\s*<code>pending<\/code> → <code>confirming<\/code> →\s*\n?\s*<code>paid<\/code> \(or <code>failed<\/code> \/\s*\n?\s*<code>partial<\/code> \/ <code>cancelled<\/code>\)\./,
    );
  });

  it("Now-live subscribable framing pinned: 'Two customer-facing patterns are supported: poll GET /v1/billing/crypto-orders, or subscribe a webhook endpoint to the now-live crypto.order.paid / crypto.order.failed events.' + polling-stays-first-class-fallback framing — pinned so the dual-pattern + polling-still-supported commitment survives (drift to dropping polling would orphan customers without inbound HTTPS)", () => {
    expect(body).toMatch(
      /Two\s*\n?\s*customer-facing patterns are supported: poll\s*\n?\s*<code>GET \/v1\/billing\/crypto-orders<\/code>, or subscribe a\s*\n?\s*webhook endpoint to the now-live\s*\n?\s*<code>crypto\.order\.paid<\/code> \/\s*\n?\s*<code>crypto\.order\.failed<\/code> events\./,
    );
    expect(body).toMatch(
      /Polling stays a first-class path for backfill,\s*\n?\s*reconciliation, and any environment where you cannot accept\s*\n?\s*an inbound HTTPS callback\./,
    );
  });

  it('3-cadence polling guidance pinned. 1-5s + 30-60s + hourly/nightly cadence bullets with V-534 + V-666.BU anchors.', () => {
    expect(body).toMatch(
      /<strong>1-5 seconds<\/strong>: user is watching a "Pay\s*\n?\s*with crypto" page\. Stop polling once status is terminal\./,
    );
    expect(body).toMatch(
      /<strong>30-60 seconds<\/strong>: background process tied\s*\n?\s*to a dashboard tab\. Default for the V-534 history view\./,
    );
    expect(body).toMatch(
      /<strong>Hourly \/ nightly<\/strong>: reconciliation \+\s*\n?\s*backfill\. Use the cursor \(V-666\.BU\) to walk every order\s*\n?\s*once per window\./,
    );
  });

  it('Customer dashboard 60s-polling + V-534.BS pattern pinned.', () => {
    expect(body).toMatch(
      /The Driftstack customer dashboard polls\s*\n?\s*<code>GET \/v1\/billing\/crypto-orders<\/code> every 60s while\s*\n?\s*any visible order is still <code>pending<\/code> \(V-534\.BS\)\./,
    );
    expect(body).toMatch(
      /shorten the poll interval to 5-10s — the rate-limit budget\s*\n?\s*on the customer list endpoint is generous enough/,
    );
  });

  it("listAll() pattern pinned: 'The SDK's listAll() manages cursors internally and yields one envelope at a time, so consumers can break early without paying for the full scan.' — pinned so the listAll cursor-managed framing + break-early-without-full-scan commitment survive (drift to dropping 'break early' would let customers think they have to walk the whole list)", () => {
    expect(body).toMatch(
      /The SDK's <code>listAll\(\)<\/code> manages cursors internally\s*\n?\s*and yields one envelope at a time, so consumers can\s*\n?\s*<code>break<\/code> early without paying for the full scan\./,
    );
  });

  it("Recommended hybrid framing: 'The recommended pattern is hybrid: webhooks for sub-second notification, periodic polling as a safety net for the rare delivery that does not land within the retry window.' — pinned so the hybrid-end-state framing + polling-as-safety-net commitment survive (drift to dropping the hybrid framing would orphan the recommended end-state from the doc)", () => {
    expect(body).toMatch(
      /The\s*\n?\s*recommended pattern is hybrid: webhooks for sub-second\s*\n?\s*notification, periodic polling as a safety net for the\s*\n?\s*rare delivery that does not land within the retry window\./,
    );
  });

  it("Idempotency for hybrid receivers: '(order_id, status) so duplicate crypto.order.paid events for the same order are a no-op' — pinned so the (order_id, status) upsert-key idempotency advice survives (drift to dropping the composite-key guidance would let customers build receivers that double-process retried events)", () => {
    expect(body).toMatch(
      /Key your local DB upsert on\s*\n?\s*<code>\(order_id, status\)<\/code> so duplicate\s*\n?\s*<code>crypto\.order\.paid<\/code> events for the same order are\s*\n?\s*a no-op\./,
    );
  });

  it('4-related-doc cluster pinned: /docs/webhooks-crypto-events + /docs/webhooks (signing+retries) + /docs/sdk-typescript-crypto-orders + /docs/billing-crypto-integration-guide — pinned so the 4-related-doc navigation surface stays complete', () => {
    expect(body).toMatch(/<a href="\/docs\/webhooks-crypto-events">Crypto webhook events<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/webhooks">Webhook signing \+ retries<\/a>/);
    expect(body).toMatch(
      /<a href="\/docs\/sdk-typescript-crypto-orders">SDK reference — crypto orders<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/docs\/billing-crypto-integration-guide">Integration guide<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

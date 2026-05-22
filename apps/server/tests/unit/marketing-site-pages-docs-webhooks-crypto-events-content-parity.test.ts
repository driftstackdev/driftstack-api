// W515.C — drift guard for apps/marketing-site/src/pages/docs/webhooks-crypto-events.astro.
// V-716 public reference for crypto-payment webhook events. Drift here
// either drops the now-LIVE subscription framing (would silently
// mislead integrators back into polling-only), drops the polling
// alternative for backfill/no-callback environments, or drops any of
// the documented event-payload fields.
//
//   • V-716 doc-comment framing + W220.A accuracy-pass rationale
//     (events flipped to LIVE 2026-05-22 — migration 0064 + bootstrap
//     emitter sink wiring).
//   • crypto.order.paid + crypto.order.failed in
//     SubscribableWebhookEventTypeSchema; POST /v1/webhooks accepted.
//   • Polling alternative: GET /v1/billing/crypto-orders/<order_id>.
//   • crypto.order.paid 6-field shape: order_id + product +
//     price_cents + price_currency + payment_id + paid_at.
//   • crypto.order.failed 7-field shape: order_id + product +
//     price_cents + price_currency + payment_id (nullable) + reason +
//     failed_at.
//   • failed reason 3-state enum: ipn / expired / swept.
//   • Wire envelope mirrors /docs/webhooks standard envelope.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/webhooks-crypto-events.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W515.C apps/marketing-site/src/pages/docs/webhooks-crypto-events.astro content parity', () => {
  const body = read(LIB);

  it("V-716 + W220.A framing pinned: 'public reference for crypto-payment webhook events.' + W220.A accuracy-pass: V-666.I/V-666.AN events ARE in SubscribableWebhookEventTypeSchema as of 2026-05-22 (migration 0064 + WebhooksService emitter sink wired in bootstrap) — pinned so the V-716 anchor + W220.A accuracy-pass commitment + V-666.I/V-666.AN anchors survive (drift to re-introducing the as-if-not-live framing would mislead customers back into polling-only)", () => {
    expect(body).toMatch(/\/\/ V-716 — public reference for crypto-payment webhook events\./);
    expect(body).toMatch(
      /\/\/ W220\.A — accuracy pass\. The crypto\.order\.paid \/ crypto\.order\.failed\s*\n?\s*\/\/ events are emitted server-side \(V-666\.I \/ V-666\.AN\) AND are in\s*\n?\s*\/\/ SubscribableWebhookEventTypeSchema as of 2026-05-22 \(migration 0064\s*\n?\s*\/\/ \+ WebhooksService emitter sink wired in bootstrap\)\./,
    );
    expect(body).toMatch(
      /POST \/v1\/webhooks\s*\n?\s*\/\/ with events: \["crypto\.order\.paid"\] is accepted today; signed deliveries\s*\n?\s*\/\/ fire on terminal-state transitions\./,
    );
  });

  it("Subscribing-section framing pinned: 'Both are subscribable via POST /v1/webhooks.' + canonical curl-style example with events: ['crypto.order.paid', 'crypto.order.failed'] in one call + 'Deliveries are signed with the standard X-Driftstack-Signature header described in /docs/webhooks; the retry policy + secret-rotation grace + DLQ semantics are identical to every other live event family.' — pinned so the subscribe-via-POST framing + single-call-both-events + signed-with-X-Driftstack-Signature + shared-retry-grace-DLQ commitment survives (drift to claiming a separate signature scheme would create marketing↔webhooks-signing divergence)", () => {
    expect(body).toMatch(/Both are subscribable via\s*\n?\s*<code>POST \/v1\/webhooks<\/code>\./);
    expect(body).toMatch(/POST \/v1\/webhooks/);
    expect(body).toMatch(/"events": \["crypto\.order\.paid", "crypto\.order\.failed"\]/);
    expect(body).toMatch(
      /Deliveries are signed with the standard\s*\n?\s*<code>X-Driftstack-Signature<\/code> header described in\s*\n?\s*<a href="\/docs\/webhooks">\/docs\/webhooks<\/a>; the retry policy\s*\n?\s*\+ secret-rotation grace \+ DLQ semantics are identical to every\s*\n?\s*other live event family\./,
    );
  });

  it("Polling-alternative framing pinned: 'For integrations that cannot accept inbound HTTPS callbacks, poll GET /v1/billing/crypto-orders/<order_id> instead. The order's status transitions to paid or failed on the same triggers that fire the webhook events' + sample response 7-field (order_id/status/product/price_cents/price_currency/payment_id/paid_at) — pinned so the polling-as-fallback framing + same-triggers commitment + 7-field response shape survives (drift to dropping polling would orphan integrators that cannot accept inbound HTTPS)", () => {
    expect(body).toMatch(
      /For integrations that cannot accept inbound HTTPS callbacks,\s*\n?\s*poll <code>GET \/v1\/billing\/crypto-orders\/&lt;order_id&gt;<\/code>\s*\n?\s*instead\. The order's <code>status<\/code> transitions to\s*\n?\s*<code>paid<\/code> or <code>failed<\/code> on the same triggers\s*\n?\s*that fire the webhook events/,
    );
    expect(body).toMatch(/GET \/v1\/billing\/crypto-orders\/ord_…/);
    expect(body).toMatch(/"status": "paid"/);
    expect(body).toMatch(/"product": "team_manual"/);
    expect(body).toMatch(/"price_cents": 4900/);
    expect(body).toMatch(/"price_currency": "EUR"/);
    expect(body).toMatch(/"payment_id": "pi_…"/);
    expect(body).toMatch(/"paid_at": "2026-05-12T13:00:00\.000Z"/);
  });

  it('3-cross-link cluster framing pinned: /docs/billing-crypto-overview (lifecycle endpoints) + /docs/crypto-orders-polling-vs-webhooks (tradeoff piece) + /docs/webhooks#event-types (full subscribable list) — pinned so the 3-companion cross-references survive (drift to dropping /docs/webhooks#event-types would orphan from the subscribable enum source-of-truth)', () => {
    expect(body).toMatch(
      /<a href="\/docs\/billing-crypto-overview">\/docs\/billing-crypto-overview<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/docs\/crypto-orders-polling-vs-webhooks">\/docs\/crypto-orders-polling-vs-webhooks<\/a>/,
    );
    expect(body).toMatch(
      /The full subscribable event-type list is on\s*\n?\s*<a href="\/docs\/webhooks#event-types">\/docs\/webhooks<\/a>\./,
    );
  });

  it("crypto.order.paid 6-field shape pinned: order_id + product + price_cents + price_currency + payment_id + paid_at (ISO 8601) + 'Fires once when a pending order transitions to paid — i.e. when the NowPayments IPN reports finished. Idempotent: applying the same terminal IPN twice will not re-fire.' — pinned so the 6-field paid shape + fires-once-on-finished + idempotent commitment survives (drift to a different shape would create marketing↔emitter divergence)", () => {
    expect(body).toMatch(
      /Fires once when a pending order transitions to\s*\n?\s*<code>paid<\/code> — i\.e\. when the NowPayments IPN reports\s*\n?\s*<code>finished<\/code>\. Idempotent: applying the same terminal\s*\n?\s*IPN twice will not re-fire\./,
    );
    expect(body).toMatch(/<td><code>order_id<\/code><\/td>/);
    expect(body).toMatch(/<td><code>product<\/code><\/td>/);
    expect(body).toMatch(/<td><code>price_cents<\/code><\/td>/);
    expect(body).toMatch(/<td><code>price_currency<\/code><\/td>/);
    expect(body).toMatch(/<td><code>payment_id<\/code><\/td>/);
    expect(body).toMatch(/<td><code>paid_at<\/code><\/td>/);
    expect(body).toMatch(/<td>The Driftstack-internal order id\.<\/td>/);
    expect(body).toMatch(/<td>ISO 4217 fiat currency \(e\.g\. <code>EUR<\/code>\)\.<\/td>/);
  });

  it("crypto.order.failed framing + 3-trigger enum pinned: ipn (NowPayments terminal failure: failed/expired/refunded) + expired (pay-window elapsed without settled payment) + swept (background sweep retired long-pending orders) + 7-field shape (order_id + product + price_cents + price_currency + payment_id nullable + reason + failed_at) + 'Fires once when an order transitions to failed — a terminal state' — pinned so the 3-trigger reason enum + 7-field shape + nullable-payment_id commitment survives (drift to dropping any reason value would create marketing↔server-emit-logic divergence)", () => {
    expect(body).toMatch(
      /Fires once when an order transitions to <code>failed<\/code>\s*\n?\s*— a terminal state\. Three triggers, distinguished by the\s*\n?\s*<code>reason<\/code> field on the payload:/,
    );
    expect(body).toMatch(
      /<code>ipn<\/code> — NowPayments reported a terminal failure\s*\n?\s*status \(<code>failed<\/code>, <code>expired<\/code>, or\s*\n?\s*<code>refunded<\/code>\) via the standard IPN\./,
    );
    expect(body).toMatch(
      /<code>expired<\/code> — the order's pay-window elapsed\s*\n?\s*without a settled payment\./,
    );
    expect(body).toMatch(
      /<code>swept<\/code> — a background sweep retired\s*\n?\s*long-pending orders that NowPayments never delivered an IPN\s*\n?\s*for\./,
    );
    expect(body).toMatch(/<td><code>reason<\/code><\/td>/);
    expect(body).toMatch(/<td><code>failed_at<\/code><\/td>/);
    expect(body).toMatch(/<td>string \| null<\/td>/);
    expect(body).toMatch(
      /<td>NowPayments-side payment id, or <code>null<\/code> for\s*\n?\s*orders that never received an IPN before being swept \/\s*\n?\s*expired\.<\/td>/,
    );
    expect(body).toMatch(
      /<td>One of <code>ipn<\/code>, <code>expired<\/code>,\s*\n?\s*<code>swept<\/code>\.<\/td>/,
    );
  });

  it("Wire-envelope mirrors-/docs/webhooks framing pinned: 'The wire format mirrors the standard webhook envelope from /docs/webhooks; the payload data object for each event type is documented below.' — pinned so the mirrors-standard-envelope commitment stays consistent with the V-684 webhooks spec (drift to claiming a different envelope would create marketing↔envelope-source divergence)", () => {
    expect(body).toMatch(
      /The wire format mirrors the standard webhook envelope from\s*\n?\s*<a href="\/docs\/webhooks">\/docs\/webhooks<\/a>; the payload\s*\n?\s*<code>data<\/code> object for each event type is documented\s*\n?\s*below\./,
    );
  });

  it('4-related-doc cluster: /docs/webhooks (delivery semantics) + /docs/billing-crypto-overview + /docs/crypto-orders-polling-vs-webhooks + /legal/refunds — pinned so the 4-related-doc navigation surface stays complete (drift to dropping /legal/refunds would orphan the non-refundable posture cross-link)', () => {
    expect(body).toMatch(/<a href="\/docs\/webhooks">Webhook delivery semantics<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/billing-crypto-overview">How crypto payments work<\/a>/);
    expect(body).toMatch(
      /<a href="\/docs\/crypto-orders-polling-vs-webhooks">Polling vs webhooks tradeoffs<\/a>/,
    );
    expect(body).toMatch(/<a href="\/legal\/refunds">Refund policy<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

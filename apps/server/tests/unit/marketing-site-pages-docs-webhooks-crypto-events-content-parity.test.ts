// W515.C — drift guard for apps/marketing-site/src/pages/docs/webhooks-crypto-events.astro.
// V-716 public reference for crypto-payment webhook events. Drift here
// either re-introduces the fictional "events are subscribable" claim
// (would create marketing↔SubscribableWebhookEventTypeSchema divergence)
// or drops the polling-alternative path (would orphan customers from the
// only working integration today).
//
//   • V-716 doc-comment framing + W220.A accuracy-pass rationale.
//   • V-666.I (paid emit) + V-666.AN (failed emit) NOT YET in
//     SubscribableWebhookEventTypeSchema → 400 today on subscription.
//   • Polling alternative: GET /v1/billing/crypto-orders/<order_id>.
//   • Planned crypto.order.paid 6-field shape: order_id + product +
//     price_cents + price_currency + payment_id + paid_at.
//   • Planned crypto.order.failed 7-field shape: order_id + product +
//     price_cents + price_currency + payment_id (nullable) + reason +
//     failed_at.
//   • failed reason 3-state enum: ipn / expired / swept.
//   • Wire envelope mirrors /docs/webhooks standard envelope.
//   • Subscribe-to-changelog framing for graduation notification.

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

  it("V-716 + W220.A framing pinned: 'public reference for crypto-payment webhook events.' + W220.A accuracy-pass: V-666.I/V-666.AN events NOT YET in SubscribableWebhookEventTypeSchema → 400 today + 'The previous revision of this page described the integration as if it were live; this rewrite flags it as roadmap and directs integrators to poll /v1/billing/crypto-orders/:id in the meantime.' — pinned so the V-716 anchor + W220.A accuracy-pass commitment + V-666.I/V-666.AN anchors survive (drift to re-introducing the as-if-live framing would recreate the bug fixed by W220.A)", () => {
    expect(body).toMatch(/\/\/ V-716 — public reference for crypto-payment webhook events\./);
    expect(body).toMatch(
      /\/\/ W220\.A — accuracy pass\. The crypto\.order\.paid \/ crypto\.order\.failed\s*\n?\s*\/\/ events are emitted server-side \(V-666\.I \/ V-666\.AN\), but they are\s*\n?\s*\/\/ NOT YET in the SubscribableWebhookEventTypeSchema enum\. That means\s*\n?\s*\/\/ POST \/v1\/webhooks with `events: \["crypto\.order\.paid"\]` is rejected\s*\n?\s*\/\/ today with a 400 validation error\./,
    );
    expect(body).toMatch(
      /The previous revision of this\s*\n?\s*\/\/ page described the integration as if it were live; this rewrite\s*\n?\s*\/\/ flags it as roadmap and directs integrators to poll\s*\n?\s*\/\/ \/v1\/billing\/crypto-orders\/:id in the meantime\./,
    );
  });

  it('Amber heads-up banner pinned: \'these events are not yet on the public webhook subscription list. POST /v1/webhooks with events: ["crypto.order.paid"] is rejected today with a 400 validation error. Use the polling alternative below until the events graduate from internal-only.\' — pinned so the amber-banner + 400-today + use-polling-alternative-until-graduation messaging survives (drift to softening this banner would let customers attempt the as-if-live subscribe path)', () => {
    expect(body).toMatch(
      /<strong>Heads up:<\/strong> these events are not yet on the\s*\n?\s*public webhook subscription list\./,
    );
    expect(body).toMatch(
      /<code class="font-mono">POST \/v1\/webhooks<\/code> with\s*\n?\s*<code class="font-mono">events: \["crypto\.order\.paid"\]<\/code>\s*\n?\s*is rejected today with a <code class="font-mono">400<\/code>\s*\n?\s*validation error\. Use the polling alternative below until\s*\n?\s*the events graduate from internal-only\./,
    );
  });

  it("Polling alternative framing pinned: 'Poll GET /v1/billing/crypto-orders/<order_id> after you mint a crypto checkout. The order's status transitions to paid or failed on the same triggers that fire the planned events' + sample response 7-field (order_id/status/product/price_cents/price_currency/payment_id/paid_at) — pinned so the polling-endpoint + same-triggers commitment + 7-field response shape survives (drift to a different polling endpoint would orphan integrators from the only working path)", () => {
    expect(body).toMatch(
      /Poll <code>GET \/v1\/billing\/crypto-orders\/&lt;order_id&gt;<\/code>\s*\n?\s*after you mint a crypto checkout\. The order's\s*\n?\s*<code>status<\/code> transitions to <code>paid<\/code> or\s*\n?\s*<code>failed<\/code> on the same triggers that fire the planned\s*\n?\s*events/,
    );
    expect(body).toMatch(/GET \/v1\/billing\/crypto-orders\/ord_…/);
    expect(body).toMatch(/"status": "paid"/);
    expect(body).toMatch(/"product": "team_manual"/);
    expect(body).toMatch(/"price_cents": 4900/);
    expect(body).toMatch(/"price_currency": "EUR"/);
    expect(body).toMatch(/"payment_id": "pi_…"/);
    expect(body).toMatch(/"paid_at": "2026-05-12T13:00:00\.000Z"/);
  });

  it('3-cross-link cluster framing pinned: /docs/billing-crypto-overview (lifecycle endpoints) + /docs/crypto-orders-polling-vs-webhooks (tradeoff piece) + /docs/webhooks#event-types (currently subscribable list) — pinned so the 3-companion cross-references survive (drift to dropping /docs/webhooks#event-types would orphan from the currently-subscribable enum source-of-truth)', () => {
    expect(body).toMatch(
      /<a href="\/docs\/billing-crypto-overview">\/docs\/billing-crypto-overview<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/docs\/crypto-orders-polling-vs-webhooks">\/docs\/crypto-orders-polling-vs-webhooks<\/a>/,
    );
    expect(body).toMatch(
      /Currently subscribable webhook event types are listed on\s*\n?\s*<a href="\/docs\/webhooks#event-types">\/docs\/webhooks<\/a>\./,
    );
  });

  it("Planned crypto.order.paid 6-field shape pinned: order_id + product + price_cents + price_currency + payment_id + paid_at (ISO 8601) + 'Will fire once when a pending order transitions to paid — i.e. when the NowPayments IPN reports finished. Idempotent: applying the same terminal IPN twice will not re-fire.' — pinned so the 6-field paid shape + fires-once-on-finished + idempotent commitment survives (drift to a different shape would create marketing↔roadmap divergence)", () => {
    expect(body).toMatch(
      /Will fire once when a pending order transitions to\s*\n?\s*<code>paid<\/code> — i\.e\. when the NowPayments IPN reports\s*\n?\s*<code>finished<\/code>\. Idempotent: applying the same terminal\s*\n?\s*IPN twice will not re-fire\./,
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

  it("Planned crypto.order.failed framing + 3-trigger enum pinned: ipn (NowPayments terminal failure: failed/expired/refunded) + expired (pay-window elapsed without settled payment) + swept (background sweep retired long-pending orders) + 7-field shape (order_id + product + price_cents + price_currency + payment_id nullable + reason + failed_at) + 'fire once when an order transitions to failed — a terminal state' — pinned so the 3-trigger reason enum + 7-field shape + nullable-payment_id commitment survives (drift to dropping any reason value would create marketing↔server-emit-logic divergence)", () => {
    expect(body).toMatch(
      /Will fire once when an order transitions to <code>failed<\/code>\s*\n?\s*— a terminal state\. Three triggers, distinguished by the\s*\n?\s*<code>reason<\/code> field on the payload:/,
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

  it("Wire-envelope mirrors-/docs/webhooks framing pinned: 'The wire format mirrors the standard webhook envelope from /docs/webhooks; the payload data object is documented here for forward-planning.' — pinned so the mirrors-standard-envelope + forward-planning commitment stays consistent with the V-684 webhooks spec (drift to claiming a different envelope would create marketing↔envelope-source divergence)", () => {
    expect(body).toMatch(
      /The wire format mirrors the standard webhook envelope\s*\n?\s*from <a href="\/docs\/webhooks">\/docs\/webhooks<\/a>; the payload\s*\n?\s*<code>data<\/code> object is documented here for forward-planning\./,
    );
  });

  it("Graduation-notification framing pinned: 'Subscribe to the /changelog; the enum-expansion will land as a versioned entry with the new values appearing in SubscribableWebhookEventTypeSchema and on /api-reference.' — pinned so the changelog-anchor + SubscribableWebhookEventTypeSchema-enum-expansion + /api-reference-anchor survives (drift to dropping the changelog anchor would orphan customers from the graduation-notification path)", () => {
    expect(body).toMatch(
      /Subscribe to the <a href="\/changelog">API changelog<\/a>; the\s*\n?\s*enum-expansion will land as a versioned entry with the new\s*\n?\s*values appearing in <code>SubscribableWebhookEventTypeSchema<\/code>\s*\n?\s*and on <a href="\/api-reference">\/api-reference<\/a>\./,
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

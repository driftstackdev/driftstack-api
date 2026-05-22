// W520.B — drift guard for apps/marketing-site/src/pages/docs/billing-crypto-integration-guide.astro.
// V-720 billing-crypto end-to-end integration guide. Drift here either
// changes the 5-step integration flow (would mislead integrators on
// build order) or breaks the grant-entitlement-only-on-paid commitment
// (would invite premature entitlement grants).
//
//   • V-720 doc-comment framing.
//   • Before-you-start 3-bullet: write-scope API key + public webhook
//     endpoint (ngrok / cloudflared) + NowPayments wallet
//     (Driftstack doesn't custody).
//   • 5-step integration flow: mint checkout → show payment address →
//     observe settlement (poll for paid/failed) → show receipt →
//     confidence test (admin apply-ipn replay).
//   • Idempotency-Key header on POST /v1/billing/crypto-checkout.
//   • payment_address can be null with provider: 'stub' (no merchant
//     account yet provisioned for the pair).
//   • Address window roughly 60 minutes.
//   • crypto.order.paid + crypto.order.failed are now subscribable
//     (2026-05-22 — wired end-to-end via WebhooksService emitter sink).
//   • Grant-entitlements-only-on-status-paid commitment.
//   • Backfill via listAll cursor (V-666.BU) + date-range (V-666.BX).
//   • Edge-case 4-bullet: wrong amount → partial / address-window-
//     expired → failed / refund-request → non-refundable + cancel /
//     browser-retry-without-idempotency-key → duplicate.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/billing-crypto-integration-guide.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W520.B apps/marketing-site/src/pages/docs/billing-crypto-integration-guide.astro content parity', () => {
  const body = read(LIB);

  it("V-720 framing pinned: 'billing-crypto integration guide. End-to-end walkthrough of integrating with the crypto-payments surface: mint a checkout, listen for the webhook, render a receipt. Cross-links the individual reference pages (overview / webhooks / idempotency / receipts / cancellation).' — pinned so the V-720 anchor + 5-cross-link-categories commitment survives", () => {
    expect(body).toMatch(
      /\/\/ V-720 — billing-crypto integration guide\. End-to-end walkthrough\s*\n?\s*\/\/ of integrating with the crypto-payments surface: mint a checkout,\s*\n?\s*\/\/ listen for the webhook, render a receipt\./,
    );
  });

  it("Before-you-start 3-bullet framing pinned: 'You need an API key with the write scope. The admin endpoints documented elsewhere (sweep, stats, internal notes) are NOT required for a customer integration.' + 'You need a public endpoint to receive webhook deliveries. For local development, use a tunnel (ngrok, cloudflared, etc.).' + 'You need a wallet at NowPayments — Driftstack does not custody funds.' — pinned so the 3-prereq + admin-not-required + tunnel-list + Driftstack-doesn't-custody commitment survives", () => {
    expect(body).toMatch(
      /<li>You need an API key with the <code>write<\/code> scope\. The\s*\n?\s*admin endpoints documented elsewhere \(sweep, stats, internal\s*\n?\s*notes\) are NOT required for a customer integration\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>You need a public endpoint to receive webhook deliveries\.\s*\n?\s*For local development, use a tunnel\s*\n?\s*\(<code>ngrok<\/code>, <code>cloudflared<\/code>, etc\.\)\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>You need a wallet at NowPayments — Driftstack does not\s*\n?\s*custody funds\.<\/li>/,
    );
  });

  it("Step-1 mint-checkout framing pinned: POST /v1/billing/crypto-checkout + idempotency-key header (crypto.randomUUID) + 3-field body (product team_manual + price_cents 4900 + price_currency USD) + 'Always send an Idempotency-Key so accidental retries don't mint duplicate orders.' + payment_address-or-null with provider: 'stub' (no merchant account provisioned) + Idempotent-Replayed response header — pinned so the POST endpoint + idempotency-key header + 3-field body + stub-fallback + Idempotent-Replayed response-header commitment survives", () => {
    expect(body).toMatch(
      /Always send an\s*\n?\s*<code>Idempotency-Key<\/code> so accidental retries don't mint\s*\n?\s*duplicate orders\./,
    );
    expect(body).toMatch(/'idempotency-key': key/);
    expect(body).toMatch(/product: 'team_manual'/);
    expect(body).toMatch(/price_cents: 4900/);
    expect(body).toMatch(/price_currency: 'USD'/);
    expect(body).toMatch(
      /The response carries an <code>order_id<\/code> and either a\s*\n?\s*<code>payment_address<\/code> \(production NowPayments-backed\s*\n?\s*checkout\) or <code>null<\/code> with <code>provider: 'stub'<\/code>\s*\n?\s*\(Driftstack hasn't yet provisioned a merchant account for the\s*\n?\s*pair\)/,
    );
    expect(body).toMatch(/<code>Idempotent-Replayed<\/code> response header/);
  });

  it("Step-2 customer-display 3-piece framing pinned: wallet address (payment_address) + currency to send (pay_currency, BTC / USDT) + how long the address remains valid 'Today's window is roughly 60 minutes from order mint.' + 'Render a QR code over the address (any client-side QR library works) and let the customer copy the address verbatim. Don't pretty-print the amount; on-chain payments are measured in crypto units, not fiat cents.' — pinned so the 3-piece display + 60-min window + QR-code + don't-pretty-print-amount commitment survives", () => {
    expect(body).toMatch(/<li>The wallet address \(<code>payment_address<\/code>\)\.<\/li>/);
    expect(body).toMatch(
      /<li>The currency they should send in\s*\n?\s*\(<code>pay_currency<\/code> — e\.g\. <code>BTC<\/code>,\s*\n?\s*<code>USDT<\/code>\)\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>How long the address remains valid\. Today's window is\s*\n?\s*roughly 60 minutes from order mint\.<\/li>/,
    );
    expect(body).toMatch(
      /Render a QR code over the address \(any client-side QR library\s*\n?\s*works\) and let the customer copy the address verbatim\. Don't\s*\n?\s*pretty-print the amount; on-chain payments are measured in\s*\n?\s*crypto units, not fiat cents\./,
    );
  });

  it("Step-3 observe-settlement framing pinned: 'crypto.order.paid and crypto.order.failed are emitted server-side and are now on the subscribable webhook event list' + poll-GET /v1/billing/crypto-orders/<order_id> until status paid/failed + 5-second polling interval (setTimeout(r, 5000)) + 'Grant entitlements only after observing status === paid.' — pinned so the now-subscribable framing + polling fallback + 5s-poll-interval + grant-only-on-paid commitment survives (drift to granting on confirming would invite premature entitlement)", () => {
    expect(body).toMatch(
      /<code>crypto\.order\.paid<\/code> and\s*\n?\s*<code>crypto\.order\.failed<\/code> are emitted server-side and\s*\n?\s*are now on the subscribable webhook event list/,
    );
    expect(body).toMatch(/async function waitForSettlement\(orderId, apiKey\) \{/);
    expect(body).toMatch(/if \(order\.status === 'paid'\) return order;/);
    expect(body).toMatch(/if \(order\.status === 'failed'\) throw new Error\('order failed'\);/);
    expect(body).toMatch(/await new Promise\(r => setTimeout\(r, 5000\)\);/);
    expect(body).toMatch(
      /<strong>Grant entitlements only after observing\s*\n?\s*<code>status === 'paid'<\/code>\.<\/strong>/,
    );
  });

  it("Step-4 receipt 3-format framing pinned: GET /v1/billing/crypto-orders/:id/receipt (JSON) + .txt (plain text) + .pdf (PDF with Content-Disposition attachment) + 'Receipts are immutable; they reflect the order envelope at the moment of paid.' — pinned so the 3-receipt-format + Content-Disposition-attachment + immutable-at-paid commitment survives", () => {
    expect(body).toMatch(
      /<code>GET \/v1\/billing\/crypto-orders\/:id\/receipt<\/code>\s*\n?\s*— JSON\./,
    );
    expect(body).toMatch(
      /<code>GET \/v1\/billing\/crypto-orders\/:id\/receipt\.txt<\/code>\s*\n?\s*— plain text\./,
    );
    expect(body).toMatch(
      /<code>GET \/v1\/billing\/crypto-orders\/:id\/receipt\.pdf<\/code>\s*\n?\s*— PDF with a Content-Disposition attachment\./,
    );
    expect(body).toMatch(
      /Receipts are immutable; they reflect the order envelope at the\s*\n?\s*moment of <code>paid<\/code>\./,
    );
  });

  it("Step-5 confidence-test admin-apply-ipn framing pinned: 'In dev, replay a fake IPN against your own integration. The troubleshooting page documents the admin POST /v1/admin/crypto-orders/:id/apply-ipn route that lets you drive an order to paid without sending real coins.' — pinned so the dev-replay + admin-apply-ipn route + drive-to-paid-without-real-coins commitment survives", () => {
    expect(body).toMatch(
      /In dev, replay a fake IPN against your own integration\. The\s*\n?\s*<a href="\/docs\/billing-crypto-troubleshooting">troubleshooting\s*\n?\s*page<\/a> documents the admin\s*\n?\s*<code>POST \/v1\/admin\/crypto-orders\/:id\/apply-ipn<\/code> route\s*\n?\s*that lets you drive an order to <code>paid<\/code> without\s*\n?\s*sending real coins\./,
    );
  });

  it("Backfill + reconciliation framing pinned: 'For nightly jobs or post-incident catchups, walk every matching order using the cursor + date-range filters. The SDK's listAll() manages the cursor for you' + raw-fetch fallback while loop using next_cursor + 'Crypto payments are non-refundable; the reconciliation loop is naturally idempotent because the local DB key is (order_id, status).' The previous skip pinned inline `(V-666.BU)` + `(V-666.BX)` anchors that were removed from the customer-facing copy as a UX cleanup (internal V-anchors should not bleed into marketing pages); the structural framing + the listAll-SDK + raw-fetch-loop + (order_id, status)-idempotent-DB-key commitment all survive without them.", () => {
    expect(body).toMatch(
      /walk every\s*\n?\s*matching order using the cursor \+ date-range\s*\n?\s*filters\. The SDK's <code>listAll\(\)<\/code> manages\s*\n?\s*the cursor for you/,
    );
    expect(body).toMatch(/for await \(const o of client\.cryptoOrders\.listAll\(\{/);
    expect(body).toMatch(/status: 'paid',/);
    expect(body).toMatch(/created_after: since,/);
    expect(body).toMatch(/limit: 100,/);
    expect(body).toMatch(/const \{ orders, next_cursor \} = await res\.json\(\);/);
    expect(body).toMatch(/if \(!next_cursor\) break;/);
    expect(body).toMatch(
      /Crypto payments are non-refundable; the reconciliation loop\s*\n?\s*is naturally idempotent because the local DB key is\s*\n?\s*<code>\(order_id, status\)<\/code>\./,
    );
    // Internal V-anchors must NOT bleed into customer-facing copy.
    expect(body).not.toMatch(/cursor \(V-666\.BU\)/);
    expect(body).not.toMatch(/date-range \(V-666\.BX\)/);
  });

  it("Edge-cases 4-bullet framing pinned: wrong-amount → partial (no entitlement, manual reconcile) + after-window-expires → failed-with-IPN-recorded + refund-wanted → non-refundable + cancel-stops-future + browser-retries-without-Idempotency-Key → duplicate ('that's why Driftstack's own GUI client always sends the header') — pinned so the 4-edge-case + Driftstack-GUI-always-sends-Idempotency-Key commitment survives", () => {
    expect(body).toMatch(
      /<strong>Customer pays the wrong amount\.<\/strong> The\s*\n?\s*order moves to <code>partial<\/code>\. No entitlement is\s*\n?\s*granted\. Your support team reconciles manually\./,
    );
    expect(body).toMatch(
      /<strong>Customer pays after the address window expires\.<\/strong>\s*\n?\s*The order is already in <code>failed<\/code> when the IPN\s*\n?\s*arrives\. The IPN is recorded on the order; support\s*\n?\s*reconciles manually\./,
    );
    expect(body).toMatch(
      /<strong>Customer wants a refund\.<\/strong> Crypto\s*\n?\s*payments are non-refundable\. The order can be cancelled to\s*\n?\s*stop future billing periods\./,
    );
    expect(body).toMatch(
      /<strong>Customer's browser retries the checkout POST\.<\/strong>\s*\n?\s*If you sent <code>Idempotency-Key<\/code>, the second call\s*\n?\s*returns the original order\. If you didn't, you mint a\s*\n?\s*duplicate; that's why Driftstack's own GUI client always\s*\n?\s*sends the header\./,
    );
  });

  it('5-related-doc cluster: /docs/billing-crypto-overview + /docs/webhooks-crypto-events + /docs/idempotency-keys + /docs/billing-crypto-troubleshooting + /legal/refunds — pinned so the 5-related-doc navigation surface stays complete', () => {
    expect(body).toMatch(/<a href="\/docs\/billing-crypto-overview">Crypto payments overview<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/webhooks-crypto-events">Crypto webhook events<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/idempotency-keys">Idempotency keys<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/billing-crypto-troubleshooting">Troubleshooting<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/refunds">Refund policy<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

// W515.A — drift guard for apps/marketing-site/src/pages/docs/sdk-go-crypto-orders.astro.
// W190 Go SDK crypto-orders reference. Drift here either changes a method
// name (would create marketing↔Go-SDK divergence) or breaks the idempotency-
// key framing (would mislead about double-charge protection).
//
//   • W190 doc-comment framing + V-666 surface anchor.
//   • client.CryptoOrders 7-method customer-facing surface.
//   • Admin endpoints NOT exposed in the SDK.
//   • driftstack.New(...) constructor + ctx-first-arg.
//   • IdempotencyKey via &CreateCheckoutOptions{} + 24h dedupe.
//   • 6-status enum + V-666.BR + 400-on-unknown + 1..=100 limit clamp.
//   • Iterate cursor-walker + visit-callback (bool false to stop) +
//     do-not-set-opts.Cursor.
//   • Non-refundable banner + 409/404 cancel handling.
//   • VerifyWebhookSignature for already-live event types.
//   • End-to-end example: packages/sdk-go/examples/crypto_checkout.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-go-crypto-orders.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W515.A apps/marketing-site/src/pages/docs/sdk-go-crypto-orders.astro content parity', () => {
  const body = read(LIB);

  it("W190 framing + non-refundable banner pinned: 'Go SDK reference for the crypto-orders surface. Companion to /docs/sdk-go (the general Go SDK quickstart). Crypto payments are non-refundable.' — pinned so the W190 anchor + sdk-go companion + non-refundable banner all survive (drift to dropping the non-refundable banner would orphan the legal posture from the SDK doc)", () => {
    expect(body).toMatch(
      /\/\/ W190 — Go SDK reference for the crypto-orders surface\.\s*\n?\s*\/\/ Companion to \/docs\/sdk-go \(the general Go SDK quickstart\)\.\s*\n?\s*\/\/ Crypto payments are non-refundable\./,
    );
  });

  it('client.CryptoOrders + V-666 surface + admin-not-exposed framing pinned. Re-enabled by slice 258 after restoring the V-666 anchor on the lead-paragraph at sdk-go-crypto-orders.astro:15', () => {
    expect(body).toMatch(
      /The <code>client\.CryptoOrders<\/code> resource wraps every\s*\n?\s*customer-facing endpoint on the V-666 surface\. Admin endpoints\s*\n?\s*are not exposed; integrators that need them call the REST\s*\n?\s*surface directly\./,
    );
  });

  it("Quote + driftstack.New + ctx-first-arg framing pinned: driftstack.New('ds_live_…') + client.CryptoOrders.Quote(ctx, map[string]any{'product': 'solo_manual'}) + price_cents / price_currency keys — pinned so the New-constructor + ctx-first-arg + map[string]any-payload + 2-key-response shape survives (drift to dropping ctx-first-arg would break the Go-idiom commitment)", () => {
    expect(body).toMatch(/client := driftstack\.New\("ds_live_…"\)/);
    expect(body).toMatch(/quote, err := client\.CryptoOrders\.Quote\(ctx, map\[string\]any\{/);
    expect(body).toMatch(/"product": "solo_manual"/);
    expect(body).toMatch(/quote\["price_cents"\], quote\["price_currency"\]/);
  });

  it('CreateCheckout + IdempotencyKey via &CreateCheckoutOptions{IdempotencyKey: &key} + 24h dedupe framing pinned + 3-field body (product/price_cents/price_currency) — pinned so the CreateCheckout signature + Options-struct + pointer-to-key + 24h-dedupe survives (drift to changing the options-struct field name would create marketing↔SDK divergence)', () => {
    expect(body).toMatch(/key := uuid\.NewString\(\)/);
    expect(body).toMatch(/order, err := client\.CryptoOrders\.CreateCheckout\(/);
    expect(body).toMatch(/"product":\s+"team_manual"/);
    expect(body).toMatch(/"price_cents":\s+4900/);
    expect(body).toMatch(/"price_currency":\s+"USD"/);
    expect(body).toMatch(/&driftstack\.CreateCheckoutOptions\{IdempotencyKey: &key\}/);
    expect(body).toMatch(
      /The SDK forwards it\s*\n?\s*as the <code>Idempotency-Key<\/code> header; on a duplicate key\s*\n?\s*within the 24h window the server returns the original order\./,
    );
  });

  it('List + 6-status enum + V-666.BR + 400-on-unknown + 1..=100 limit clamp framing pinned. Re-enabled by slice 258 after verifying V-666.BR + the 6-status enum still exist verbatim at sdk-go-crypto-orders.astro:58+69-72', () => {
    expect(body).toMatch(/page, err := client\.CryptoOrders\.List\(ctx, nil\)/);
    expect(body).toMatch(/for _, o := range page\.Orders \{/);
    expect(body).toMatch(/V-666\.BR/);
    expect(body).toMatch(/&driftstack\.ListCryptoOrdersOptions\{/);
    expect(body).toMatch(
      /<code>Status<\/code> accepts <code>pending<\/code>,\s*\n?\s*<code>confirming<\/code>, <code>paid<\/code>, <code>failed<\/code>,\s*\n?\s*<code>partial<\/code>, or <code>cancelled<\/code>\. Unknown values\s*\n?\s*return a 400\. <code>Limit<\/code> is clamped to 1\.\.=100\./,
    );
  });

  it("Iterate cursor-walker framing pinned: 'Iterate walks every page until the server stops emitting a NextCursor. Cursor handoff is managed internally — do not set opts.Cursor when calling Iterate. Return false from the visit callback to stop iteration early (no further pages are fetched).' + visit-callback signature + manual-cursor while-loop fallback — pinned so the Iterate + do-not-set-opts.Cursor + bool-return-false-stops + manual-cursor while-loop commitments survive (drift to letting Iterate take opts.Cursor would invite cursor double-handling)", () => {
    expect(body).toMatch(
      /<code>Iterate<\/code> walks every page until the server stops\s*\n?\s*emitting a <code>NextCursor<\/code>\. Cursor handoff is managed\s*\n?\s*internally — <strong>do not<\/strong> set\s*\n?\s*<code>opts\.Cursor<\/code> when calling <code>Iterate<\/code>\.\s*\n?\s*Return <code>false<\/code> from the visit callback to stop\s*\n?\s*iteration early \(no further pages are fetched\)\./,
    );
    expect(body).toMatch(/func\(o driftstack\.CryptoOrderEnvelope\) bool \{/);
    expect(body).toMatch(/return true \/\/ keep going/);
    expect(body).toMatch(/if page\.NextCursor == nil \{ break \}/);
    expect(body).toMatch(/cursor = page\.NextCursor/);
  });

  it('UpdateNote + Cancel + Receipt 3-method signatures pinned: UpdateNote 3-arg (ctx + ord_id + map) + Cancel 2-arg + 409-past-pending + 404-doesnt-exist + Receipt 2-arg returning paid_at + price_cents keys — pinned so the 3-method surface + 2-status-error-code-meaning + receipt-fetch shape survives (drift to renaming the 409/404 meaning would create marketing↔server divergence)', () => {
    expect(body).toMatch(
      /_, err := client\.CryptoOrders\.UpdateNote\(ctx, "ord_abc", map\[string\]any\{/,
    );
    expect(body).toMatch(/"customer_note": "PO-9921"/);
    expect(body).toMatch(/_, err := client\.CryptoOrders\.Cancel\(ctx, "ord_abc"\)/);
    expect(body).toMatch(
      /\/\/ 409: order has moved past pending; cancellation is no longer self-service\./,
    );
    expect(body).toMatch(/\/\/ 404: order doesn't exist or belongs to another account\./);
    expect(body).toMatch(/receipt, err := client\.CryptoOrders\.Receipt\(ctx, "ord_abc"\)/);
    expect(body).toMatch(/receipt\["paid_at"\], receipt\["price_cents"\]/);
  });

  it("Non-refundable + cancel-pending-halts-pay-window framing pinned: 'Crypto payments are non-refundable. Cancelling a pending order halts its pay window; cancelling a paid order is not supported — past billing periods stay billed.' + /legal/refunds cross-ref — pinned so the non-refundable + halt-pay-window + paid-not-cancellable + /legal/refunds anchor commitment survives", () => {
    expect(body).toMatch(
      /Crypto payments are non-refundable\. Cancelling a pending order\s*\n?\s*halts its pay window; cancelling a paid order is not supported —\s*\n?\s*past billing periods stay billed\. See\s*\n?\s*<a href="\/legal\/refunds">\/legal\/refunds<\/a>\./,
    );
  });

  it("Now-subscribable + polling-fallback framing pinned: 'crypto.order.paid / crypto.order.failed events are emitted server-side and are now subscribable' + 'poll client.CryptoOrders.Get(ctx, orderID) until status transitions to paid or failed' + 'The Go SDK ships VerifyWebhookSignature for every live event type including crypto.order.* alongside session + quota + api-key + egress-capability.' — pinned so the now-subscribable + polling-as-fallback + VerifyWebhookSignature-every-domain trio survives (drift to claiming the events are NOT subscribable would create marketing↔SubscribableWebhookEventTypeSchema divergence)", () => {
    expect(body).toMatch(
      /<code>crypto\.order\.paid<\/code> \/ <code>crypto\.order\.failed<\/code>\s*\n?\s*events are emitted server-side and are now subscribable/,
    );
    expect(body).toMatch(
      /poll\s*\n?\s*<code>client\.CryptoOrders\.Get\(ctx, orderID\)<\/code> until\s*\n?\s*<code>status<\/code> transitions to <code>paid<\/code> or\s*\n?\s*<code>failed<\/code>/,
    );
    expect(body).toMatch(
      /The Go SDK ships\s*\n?\s*<code>VerifyWebhookSignature<\/code> for every live event type,\s*\n?\s*including the now-live crypto\.order\.\* events alongside the\s*\n?\s*session \+ quota \+ api-key \+ egress-capability event domains\./,
    );
  });

  it("End-to-end example framing pinned: 'packages/sdk-go/examples/crypto_checkout/main.go' + 'DRIFTSTACK_API_KEY=... go run ./examples/crypto_checkout' — pinned so the runnable-example path + go-run invocation stays consistent (drift to a different example path would create marketing↔SDK-examples-dir divergence)", () => {
    expect(body).toMatch(/<code>packages\/sdk-go\/examples\/crypto_checkout\/main\.go<\/code>/);
    expect(body).toMatch(
      /<code>DRIFTSTACK_API_KEY=\.\.\. go run \.\/examples\/crypto_checkout<\/code>/,
    );
  });

  it('7-related-doc cluster: /docs/sdk-go + /docs/sdk-typescript-crypto-orders + /docs/sdk-python-crypto-orders + /docs/billing-crypto-integration-guide + /docs/idempotency-keys + /docs/webhooks-crypto-events + /docs/crypto-orders-polling-vs-webhooks — pinned so the 7-related-doc navigation surface stays complete (drift to dropping any sister-SDK crypto-orders cross-ref would orphan the trilogy)', () => {
    expect(body).toMatch(/<a href="\/docs\/sdk-go">Go SDK quickstart<\/a>/);
    expect(body).toMatch(
      /<a href="\/docs\/sdk-typescript-crypto-orders">TypeScript SDK crypto orders<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/docs\/sdk-python-crypto-orders">Python SDK crypto orders<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/guides\/paying-with-crypto\/">Integration guide<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/idempotency-keys">Idempotency keys<\/a>/);
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/">Crypto webhook events<\/a>/,
    );
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/webhooks\/crypto-events\/">Polling vs webhooks<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

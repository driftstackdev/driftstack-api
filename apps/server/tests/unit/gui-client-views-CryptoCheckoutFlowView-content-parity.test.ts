// W481.A — drift guard for apps/gui-client/src/views/CryptoCheckoutFlowView.tsx.
// V-534.AC composite 3-step crypto-checkout flow. Drift here
// either drops the SUPPORTED_PRODUCTS 6-value tuple (a new
// paid tier ships server-side but the dropdown still only
// lists the old 6 — customers can't checkout the new tier from
// the GUI) or breaks the V-534.AZ replayed-from-earlier-attempt
// banner (a customer who retried after a network blip sees
// nothing distinguishing their replayed order from a fresh
// mint and thinks Driftstack double-charged them).
//
//   • V-534.AC framing pinned: 'composite crypto-checkout flow
//     view.' + 3-step flow stitching V-534.AC = V-534.V quote +
//     V-534.J checkout + V-534.T poll.
//   • SUPPORTED_PRODUCTS as const 6-tuple (solo_manual /
//     team_manual / agency_manual / api_starter / api_builder /
//     api_scale).
//   • Product picker disabled while checkout.state.kind !==
//     'idle' so user can't change products mid-mint.
//   • Step 2 onStart: quote.state must be 'ready' before
//     start() is called (early-return guard).
//   • V-534.AZ replayed banner: 'Restored from your earlier
//     attempt (no duplicate order minted).' surfaced when
//     checkout.state.replayed.
//   • Step 3 useCryptoOrder polling at pollIntervalMs: 5_000
//     when orderId !== null.
//   • Stub-provider notice surfaced separately from the
//     payment_address row.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoCheckoutFlowView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W481.A apps/gui-client/src/views/CryptoCheckoutFlowView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AC framing pinned: 'V-534.AC — composite crypto-checkout flow view.' + 3-step framing 'Pick a product → useCryptoQuote shows the price preview.' + 'Click \"Start checkout\" → useCryptoCheckout mints an order.' + 'Once the order_id is in hand → useCryptoOrder polls until the status reaches a terminal state (paid / failed).' + 'Designed for the GUI's /billing/crypto-checkout entry point. The component takes a `defaultProduct` prop so it can be embedded from pricing-page CTAs; the user can still switch products before minting.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AC — composite crypto-checkout flow view\./);
    expect(body).toMatch(
      /\/\/ Three-step flow stitched together from the V-534\.\* hook family:\s*\n?\s*\/\/\s+1\. Pick a product → useCryptoQuote shows the price preview\.\s*\n?\s*\/\/\s+2\. Click "Start checkout" → useCryptoCheckout mints an order\.\s*\n?\s*\/\/\s+3\. Once the order_id is in hand → useCryptoOrder polls until\s*\n?\s*\/\/\s+the status reaches a terminal state \(paid \/ failed\)\./,
    );
    expect(body).toMatch(
      /\/\/ Designed for the GUI's \/billing\/crypto-checkout entry point\. The\s*\n?\s*\/\/ component takes a `defaultProduct` prop so it can be embedded from\s*\n?\s*\/\/ pricing-page CTAs; the user can still switch products before\s*\n?\s*\/\/ minting\./,
    );
  });

  it("SUPPORTED_PRODUCTS pinned as const 6-tuple ('solo_manual' / 'team_manual' / 'agency_manual' / 'api_starter' / 'api_builder' / 'api_scale') — pinned so a new paid tier landing server-side prompts a deliberate update to the GUI dropdown rather than silently shipping with the old list", () => {
    expect(body).toMatch(
      /const SUPPORTED_PRODUCTS = \[\s*\n?\s*'solo_manual',\s*\n?\s*'team_manual',\s*\n?\s*'agency_manual',\s*\n?\s*'api_starter',\s*\n?\s*'api_builder',\s*\n?\s*'api_scale',\s*\n?\s*\] as const;/,
    );
  });

  it("CryptoCheckoutFlowViewProps {defaultProduct: string}; orderId derivation: checkout.state.kind === 'ready' ? checkout.state.order.order_id : null; useCryptoOrder(orderId, {pollIntervalMs: 5_000}) polling cadence pinned", () => {
    expect(body).toMatch(
      /export interface CryptoCheckoutFlowViewProps \{\s*\n?\s*defaultProduct: string;\s*\n?\s*\}/,
    );
    expect(body).toContain('const selectedProduct = checkout.lockedArgs?.product ?? product;');
    expect(body).toContain(
      "const quote = useCryptoQuote({ product: selectedProduct, priceCurrency: 'USD' });",
    );
    expect(body).toContain(
      "const orderId = checkout.state.kind === 'ready' ? checkout.state.order.order_id : null;",
    );
    expect(body).toContain(
      'const orderStatus = useCryptoOrder(orderId, { pollIntervalMs: 5_000 });',
    );
  });

  it('onStart requires an exact current product/USD quote before checkout.start; onReset invalidates copy work before checkout.reset()', () => {
    expect(body).toContain('quote.state.data.product === selectedProduct');
    expect(body).toContain("quote.state.data.price_currency === 'USD'");
    expect(body).toContain('if (currentQuote === null) return;');
    expect(body).toContain('product: selectedProduct');
    expect(body).toContain('price_cents: currentQuote.price_cents');
    expect(body).toContain('price_currency: currentQuote.price_currency');
    expect(body).toContain(
      'if (checkout.lockedArgs !== null) setProduct(checkout.lockedArgs.product);',
    );
    expect(body).toContain('checkout.reset();');
  });

  it("Step 1 picker: disabled while checkout.state.kind !== 'idle' (user can't change products mid-mint) + SUPPORTED_PRODUCTS.map options; Step 1 quote: 'Loading quote…' / ErrorBanner onDismiss={() => void quote.refetch()} (Dismiss retries the quote — not a dead control) / ready 'Price: <strong>{formatCents(...)}</strong>'", () => {
    expect(body).toMatch(
      /<select\s*\n?\s*value=\{selectedProduct\}\s*\n?\s*onChange=\{\(e\) => setProduct\(e\.target\.value\)\}\s*\n?\s*disabled=\{checkout\.state\.kind !== 'idle'\}/,
    );
    expect(body).toMatch(
      /\{SUPPORTED_PRODUCTS\.map\(\(p\) => \(\s*\n?\s*<option key=\{p\} value=\{p\}>\s*\n?\s*\{formatProduct\(p\)\}\s*\n?\s*<\/option>\s*\n?\s*\)\)\}/,
    );
    expect(body).toContain("quote.state.kind === 'loading'");
    expect(body).toContain("quote.state.kind === 'ready' && currentQuote === null");
    expect(body).toContain(
      '<ErrorBanner message={quote.state.message} onDismiss={() => void quote.refetch()} />',
    );
    expect(body).toContain('{currentQuote !== null && (');
    expect(body).toContain('formatCents(currentQuote.price_cents, currentQuote.price_currency)');
  });

  it('Step 2 checkout state-machine includes non-dismissible outcome_unknown with exact retry, plus ready replay notice', () => {
    expect(body).toMatch(
      /\{checkout\.state\.kind === 'idle' && \(\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{onStart\}\s*\n?\s*disabled=\{currentQuote === null\}/,
    );
    expect(body).toMatch(
      /\{checkout\.state\.kind === 'error' && \(\s*\n?\s*<ErrorBanner message=\{checkout\.state\.message\} onDismiss=\{onReset\} \/>\s*\n?\s*\)\}/,
    );
    expect(body).toContain('Confirming checkout…');
    expect(body).toContain("checkout.state.kind === 'outcome_unknown'");
    expect(body).toContain('checkout.state.retryable');
    expect(body).toContain('onClick={() => void checkout.retry()}');
    expect(body).toContain('Retry same checkout');
    expect(body).toContain(
      'Retry safely reuses the original request instead of minting a second order.',
    );
    expect(body).toContain(
      'Do not start another checkout until Orders or billing support confirms this one.',
    );
    // The ready branch destructures `const { order, replayed } = checkout.state;`
    // and derives the authoritative-price comparison so downstream JSX reads the
    // locals rather than re-drilling checkout.state each time.
    expect(body).toMatch(
      /const \{ order, replayed \} = checkout\.state;\s*\n?\s*const payment = activePaymentContext;\s*\n?\s*const addr = payment\?\.address \?\? null;\s*\n?\s*const priceChanged =/,
    );
    expect(body).toContain('Checkout amount:');
    expect(body).toContain('formatCents(order.price_cents, order.price_currency)');
    expect(body).toContain(
      'Price updated before checkout. The amount above is the authoritative charge.',
    );
    expect(body).toMatch(
      /\{replayed && \(\s*\n?\s*<div\s*\n?\s*role="status"\s*\n?\s*className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary"\s*\n?\s*>\s*\n?\s*Restored from your earlier attempt \(no duplicate order minted\)\.\s*\n?\s*<\/div>\s*\n?\s*\)\}/,
    );
    // Payment address row now carries a one-click Copy button (highest-stakes
    // copy in the app — a truncated hand-select loses funds).
    expect(body).toContain('const addr = payment?.address ?? null;');
    expect(body).toContain('Send exactly:');
    expect(body).toContain('formatCryptoAmount(payment.amount)');
    expect(body).toContain('payment.currency.toUpperCase()');
    expect(body).toContain('Send to:');
    expect(body).toContain('{addr}');
    expect(body).toMatch(/copyState === 'failed'[\s\S]*?'Retry copying payment address'/);
    expect(body).toMatch(/aria-busy=\{copyState === 'copying'\}/);
    expect(body).toMatch(
      /Couldn’t copy the payment address\. Check clipboard permission and try again\./,
    );
    expect(body).toContain("order.provider === 'stub' && effectiveOrderStatus === 'pending'");
    expect(body).toContain('Payment instructions are not available yet. Do not send funds;');
    expect(body).toContain(
      'Payment instructions are hidden because this order is {effectiveOrderStatus}.',
    );
    expect(body).not.toContain('Payment provider is in stub mode');
  });

  it('pins current-order, monotonic pending-only payment authority before address/copy exposure', () => {
    expect(body).toContain('orderStatus.state.data.order_id === orderId');
    expect(body).toContain("lastAuthoritativeStatusRef.current !== 'pending'");
    expect(body).toContain("currentOrderStatus.status === 'pending'");
    expect(body).toContain("effectiveOrderStatus === 'pending'");
    expect(body).toContain("currentOrderStatus?.status === 'pending'");
    expect(body).toContain("effectiveOrderStatus === 'pending'");
    expect(body).toContain('typeof currentOrderStatus.expires_at');
    expect(body).toContain('paymentDeadlineMs > Date.now()');
    expect(body).toContain('setPaymentDeadlineTick((tick) => tick + 1)');
    expect(body).toContain('currentOrderStatus === null');
    expect(body).toContain('Review this order in the Orders tab before starting another checkout.');
    expect(body).toContain('checkoutOrder.payment_address !== null');
    expect(body).toContain('checkoutOrder.pay_currency !== null');
    expect(body).toContain('checkoutOrder.pay_amount !== null');
    expect(body).toContain('checkoutOrder.pay_amount > 0');
    expect(body).toContain('activePaymentAddressRef.current !== addr');
    expect(body).toContain('activePaymentDeadlineRef.current <= Date.now()');
    expect(body).toContain('const hasCurrentOrderStatus =');
    expect(body).toContain('status={effectiveOrderStatus ?? orderStatus.state.data.status}');
  });

  it("Step 3 live status section only renders when orderId !== null; CryptoOrderStatusBadge size='sm' on ready state; 'Loading…' on loading state; error state surfaces a dismissable ErrorBanner onDismiss={() => void order.refetch()} (Dismiss re-polls the order status rather than dead-ending on a stale error)", () => {
    expect(body).toContain('{orderId !== null && (');
    expect(body).toContain("hasCurrentOrderStatus && orderStatus.state.kind === 'ready'");
    expect(body).toContain('status={effectiveOrderStatus ?? orderStatus.state.data.status}');
    expect(body).toContain("orderStatus.state.kind === 'ready' && !hasCurrentOrderStatus");
    expect(body).toContain("orderStatus.state.kind === 'error'");
    expect(body).toContain('message={orderStatus.state.message}');
    expect(body).toContain('onDismiss={() => void orderStatus.refetch()}');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

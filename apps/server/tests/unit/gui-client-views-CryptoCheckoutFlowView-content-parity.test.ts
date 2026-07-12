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
    expect(body).toMatch(
      /const orderId = checkout\.state\.kind === 'ready' \? checkout\.state\.order\.order_id : null;\s*\n?\s*const order = useCryptoOrder\(orderId, \{ pollIntervalMs: 5_000 \}\);/,
    );
  });

  it("onStart: quote.state.kind !== 'ready' early-return guard + checkout.start({product, price_cents from quote, price_currency from quote}); onReset → checkout.reset() — pinned so checkout doesn't fire without a fresh quote (would post stale prices to server)", () => {
    expect(body).toMatch(
      /const onStart = \(\): void => \{\s*\n?\s*if \(quote\.state\.kind !== 'ready'\) return;\s*\n?\s*void checkout\.start\(\{\s*\n?\s*product,\s*\n?\s*price_cents: quote\.state\.data\.price_cents,\s*\n?\s*price_currency: quote\.state\.data\.price_currency,\s*\n?\s*\}\);\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const onReset = \(\): void => \{\s*\n?\s*checkout\.reset\(\);\s*\n?\s*\};/,
    );
  });

  it("Step 1 picker: disabled while checkout.state.kind !== 'idle' (user can't change products mid-mint) + SUPPORTED_PRODUCTS.map options; Step 1 quote: 'Loading quote…' / ErrorBanner onDismiss={() => void quote.refetch()} (Dismiss retries the quote — not a dead control) / ready 'Price: <strong>{formatCents(...)}</strong>'", () => {
    expect(body).toMatch(
      /<select\s*\n?\s*value=\{product\}\s*\n?\s*onChange=\{\(e\) => setProduct\(e\.target\.value\)\}\s*\n?\s*disabled=\{checkout\.state\.kind !== 'idle'\}/,
    );
    expect(body).toMatch(
      /\{SUPPORTED_PRODUCTS\.map\(\(p\) => \(\s*\n?\s*<option key=\{p\} value=\{p\}>\s*\n?\s*\{formatProduct\(p\)\}\s*\n?\s*<\/option>\s*\n?\s*\)\)\}/,
    );
    expect(body).toMatch(
      /\{quote\.state\.kind === 'loading' && \(\s*\n?\s*<span className="text-ink-secondary">Loading quote…<\/span>\s*\n?\s*\)\}\s*\n?\s*\{quote\.state\.kind === 'error' && \(\s*\n?\s*<ErrorBanner message=\{quote\.state\.message\} onDismiss=\{\(\) => void quote\.refetch\(\)\} \/>\s*\n?\s*\)\}\s*\n?\s*\{quote\.state\.kind === 'ready' && \(\s*\n?\s*<span>\s*\n?\s*Price:\{' '\}\s*\n?\s*<strong>\s*\n?\s*\{formatCents\(quote\.state\.data\.price_cents, quote\.state\.data\.price_currency\)\}\s*\n?\s*<\/strong>\s*\n?\s*<\/span>\s*\n?\s*\)\}/,
    );
  });

  it("Step 2 checkout state-machine: idle → 'Start checkout' button disabled when quote !== ready / loading → 'Minting order…' / error → ErrorBanner onDismiss=onReset / ready → order_id font-mono + V-534.AZ replayed banner 'Restored from your earlier attempt (no duplicate order minted).' + payment_address row when !== null + stub-provider notice 'Payment provider is in stub mode. Contact support to receive a real payment address.'", () => {
    expect(body).toMatch(
      /\{checkout\.state\.kind === 'idle' && \(\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{onStart\}\s*\n?\s*disabled=\{quote\.state\.kind !== 'ready'\}/,
    );
    expect(body).toMatch(
      /\{checkout\.state\.kind === 'error' && \(\s*\n?\s*<ErrorBanner message=\{checkout\.state\.message\} onDismiss=\{onReset\} \/>\s*\n?\s*\)\}/,
    );
    // The ready branch destructures `const { order, replayed } = checkout.state;`
    // (and `const addr = order.payment_address;`) so downstream JSX reads the
    // locals rather than re-drilling checkout.state each time.
    expect(body).toMatch(
      /const \{ order, replayed \} = checkout\.state;\s*\n?\s*const addr = order\.payment_address;/,
    );
    expect(body).toMatch(
      /\{replayed && \(\s*\n?\s*<div\s*\n?\s*role="status"\s*\n?\s*className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary"\s*\n?\s*>\s*\n?\s*Restored from your earlier attempt \(no duplicate order minted\)\.\s*\n?\s*<\/div>\s*\n?\s*\)\}/,
    );
    // Payment address row now carries a one-click Copy button (highest-stakes
    // copy in the app — a truncated hand-select loses funds).
    expect(body).toMatch(
      /\{addr !== null && \(\s*\n?\s*<div className="flex items-center gap-2">\s*\n?\s*<span className="text-ink-secondary">Send to:<\/span>\s*\n?\s*<span className="min-w-0 flex-1 break-all font-mono text-xs">\{addr\}<\/span>/,
    );
    expect(body).toMatch(/copyState === 'failed'[\s\S]*?'Retry copying payment address'/);
    expect(body).toMatch(/aria-busy=\{copyState === 'copying'\}/);
    expect(body).toMatch(
      /Couldn’t copy the payment address\. Check clipboard permission and try again\./,
    );
    expect(body).toMatch(
      /\{order\.provider === 'stub' && \(\s*\n?\s*<div className="text-ink-secondary">\s*\n?\s*Payment provider is in stub mode\. Contact support to receive a real payment\s*\n?\s*address\.\s*\n?\s*<\/div>\s*\n?\s*\)\}/,
    );
  });

  it("Step 3 live status section only renders when orderId !== null; CryptoOrderStatusBadge size='sm' on ready state; 'Loading…' on loading state; error state surfaces a dismissable ErrorBanner onDismiss={() => void order.refetch()} (Dismiss re-polls the order status rather than dead-ending on a stale error)", () => {
    expect(body).toMatch(
      /\{orderId !== null && \(\s*\n?\s*<section className="rounded-md border border-surface-divider p-4">\s*\n?\s*<div className="flex items-center justify-between text-sm">\s*\n?\s*<span className="text-ink-secondary">Order status<\/span>\s*\n?\s*\{order\.state\.kind === 'ready' && \(\s*\n?\s*<CryptoOrderStatusBadge status=\{order\.state\.data\.status\} size="sm" \/>\s*\n?\s*\)\}\s*\n?\s*\{order\.state\.kind === 'loading' && <span className="text-ink-secondary">Loading…<\/span>\}/,
    );
    expect(body).toMatch(
      /\{order\.state\.kind === 'error' && \(\s*\n?\s*<div className="mt-2">[\s\S]*?<ErrorBanner message=\{order\.state\.message\} onDismiss=\{\(\) => void order\.refetch\(\)\} \/>\s*\n?\s*<\/div>\s*\n?\s*\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

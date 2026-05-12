// W479.B — drift guard for apps/gui-client/src/views/CryptoCheckoutView.tsx.
// V-534.K crypto-checkout view wraps V-534.J useCryptoCheckout.
// Drift here either drops the 'stub' provider 'support will
// reach out' notice (customer sees blank deposit-address surface
// after minting an order in the pre-merchant-account era — has
// no idea what to do next) or breaks the disabled-during-loading
// guard on the Pay button (double-click during the request mints
// two duplicate orders since the idempotency key only protects
// against retries of the same in-flight call).
//
//   • V-534.K framing pinned: 'crypto-checkout view.' + 'Wraps
//     the V-534.J `useCryptoCheckout` hook with a tier picker +
//     "Pay with crypto" button + a result panel rendered when
//     the order mints. Pre-merchant-account posture: the result
//     panel surfaces a "support will reach out" notice instead
//     of a deposit address (the route's stubbed `provider:
//     'stub'` response).' + 'Inputs: the parent supplies the
//     supported tiers + prices so the view stays presentation-
//     only.'
//   • CryptoCheckoutOption 4-field + CryptoCheckoutViewProps
//     {options: readonly CryptoCheckoutOption[]}.
//   • selectedProduct initial = options[0]?.product ?? ''
//     fallback for empty option list.
//   • Stub-provider notice: 'We'll email you a payment address
//     within one business day. Quote your order id when you
//     reply.'
//   • Non-stub provider: 'Send' label + payment_address ??
//     'pending…' display.
//   • Pay button disabled while loading || !selected; picker
//     disabled while loading.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoCheckoutView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W479.B apps/gui-client/src/views/CryptoCheckoutView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.K framing pinned: 'V-534.K — crypto-checkout view.' + 'Wraps the V-534.J `useCryptoCheckout` hook with a tier picker + \"Pay with crypto\" button + a result panel rendered when the order mints. Pre-merchant-account posture: the result panel surfaces a \"support will reach out\" notice instead of a deposit address (the route's stubbed `provider: 'stub'` response).' + 'Inputs: the parent supplies the supported tiers + prices so the view stays presentation-only.'", () => {
    expect(body).toMatch(/\/\/ V-534\.K — crypto-checkout view\./);
    expect(body).toMatch(
      /\/\/ Wraps the V-534\.J `useCryptoCheckout` hook with a tier picker \+\s*\n?\s*\/\/ "Pay with crypto" button \+ a result panel rendered when the order\s*\n?\s*\/\/ mints\. Pre-merchant-account posture: the result panel surfaces a\s*\n?\s*\/\/ "support will reach out" notice instead of a deposit address \(the\s*\n?\s*\/\/ route's stubbed `provider: 'stub'` response\)\./,
    );
    expect(body).toMatch(
      /\/\/ Inputs: the parent supplies the supported tiers \+ prices so the\s*\n?\s*\/\/ view stays presentation-only\./,
    );
  });

  it('CryptoCheckoutOption 4-field (product + label + price_cents + price_currency) + CryptoCheckoutViewProps with readonly options array — pinned so parent provides the tier surface, view stays presentation-only', () => {
    expect(body).toMatch(
      /export interface CryptoCheckoutOption \{\s*\n?\s*product: string;\s*\n?\s*label: string;\s*\n?\s*price_cents: number;\s*\n?\s*price_currency: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface CryptoCheckoutViewProps \{\s*\n?\s*options: readonly CryptoCheckoutOption\[\];\s*\n?\s*\}/,
    );
  });

  it("selectedProduct initial: useState(options[0]?.product ?? '') + selected = find(o.product===selectedProduct); onPay early-return if !selected + start({product, price_cents, price_currency}) destructure", () => {
    expect(body).toMatch(
      /const \[selectedProduct, setSelectedProduct\] = useState<string>\(props\.options\[0\]\?\.product \?\? ''\);\s*\n?\s*const selected = props\.options\.find\(\(o\) => o\.product === selectedProduct\);/,
    );
    expect(body).toMatch(
      /async function onPay\(\): Promise<void> \{\s*\n?\s*if \(!selected\) return;\s*\n?\s*await start\(\{\s*\n?\s*product: selected\.product,\s*\n?\s*price_cents: selected\.price_cents,\s*\n?\s*price_currency: selected\.price_currency,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("Header copy 'Pay with crypto' h2 + 'We support BTC, ETH, and major stablecoins. Your account upgrades automatically once your transfer settles on-chain.' subline — pinned so the customer-facing crypto-support message stays accurate to the implementation", () => {
    expect(body).toMatch(
      /<h2 id="crypto-checkout-heading" className="text-lg font-semibold text-ink-primary">\s*\n?\s*Pay with crypto\s*\n?\s*<\/h2>\s*\n?\s*<p className="text-sm text-ink-secondary">\s*\n?\s*We support BTC, ETH, and major stablecoins\. Your account upgrades automatically once your\s*\n?\s*transfer settles on-chain\.\s*\n?\s*<\/p>/,
    );
  });

  it("Picker + Pay button: state.kind !== 'ready' gates the picker (rendered before mint); picker disabled while loading; Pay button disabled while loading || !selected + onClick onPay + label 'Minting order…' during loading else 'Pay with crypto'", () => {
    expect(body).toMatch(/\{state\.kind !== 'ready' && \(/);
    expect(body).toMatch(
      /<select\s*\n?\s*id="crypto-product-picker"\s*\n?\s*value=\{selectedProduct\}\s*\n?\s*onChange=\{\(e\) => setSelectedProduct\(e\.target\.value\)\}\s*\n?\s*className="rounded border border-surface-divider bg-surface-input px-2 py-1 text-sm text-ink-primary"\s*\n?\s*disabled=\{state\.kind === 'loading'\}/,
    );
    expect(body).toMatch(
      /<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{\(\) => void onPay\(\)\}\s*\n?\s*disabled=\{state\.kind === 'loading' \|\| !selected\}/,
    );
    expect(body).toMatch(/\{state\.kind === 'loading' \? 'Minting order…' : 'Pay with crypto'\}/);
  });

  it("Error surface: role='alert' status-error tints with 'Could not create the order: ${message}'; Ready surface: role='status' aria-label 'Crypto order ready' + 'Order created' + font-mono order_id + 'Start another order' reset link", () => {
    expect(body).toMatch(
      /\{state\.kind === 'error' && \(\s*\n?\s*<div\s*\n?\s*role="alert"\s*\n?\s*className="rounded border border-status-error\/60 bg-status-error\/10 p-3 text-sm text-status-error"\s*\n?\s*>\s*\n?\s*Could not create the order: \{state\.message\}\s*\n?\s*<\/div>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(/role="status"\s*\n?\s*aria-label="Crypto order ready"/);
    expect(body).toMatch(
      /<p className="text-sm text-ink-secondary">Order created<\/p>\s*\n?\s*<p className="font-mono text-base text-ink-primary">\{state\.order\.order_id\}<\/p>/,
    );
    expect(body).toMatch(
      /<button type="button" onClick=\{\(\) => reset\(\)\} className="text-sm text-accent underline">\s*\n?\s*Start another order\s*\n?\s*<\/button>/,
    );
  });

  it("Stub-provider branch pinned: provider === 'stub' renders 'We'll email you a payment address within one business day. Quote your order id when you reply.' (we&apos;ll JSX escape for apostrophe) — pinned so pre-merchant-account customers see clear next-steps instead of a blank deposit-address surface; non-stub branch shows 'Send' + payment_address ?? 'pending…' fallback", () => {
    expect(body).toMatch(
      /\{state\.order\.provider === 'stub' \? \(\s*\n?\s*<p className="text-sm text-ink-secondary">\s*\n?\s*We&apos;ll email you a payment address within one business day\. Quote your order id\s*\n?\s*when you reply\.\s*\n?\s*<\/p>\s*\n?\s*\) : \(\s*\n?\s*<>\s*\n?\s*<p className="text-xs text-ink-secondary">Send<\/p>\s*\n?\s*<p className="font-mono text-sm text-ink-primary">\s*\n?\s*\{state\.order\.payment_address \?\? 'pending…'\}\s*\n?\s*<\/p>\s*\n?\s*<\/>\s*\n?\s*\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

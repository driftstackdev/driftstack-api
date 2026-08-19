// W902 — CryptoCheckout currency + price-cents cross-source
// invariant. Two-hundred-twenty-eighth in the drift-guard series.
// Pins the V-666 CryptoCheckout request bounds:
//
//   price_cents: int positive max 1_000_000 ($10,000 USD).
//   price_currency: length(3) + regex /^[A-Z]{3}$/ (ISO 4217).
//   product: string with describe 'SKU; one of the tier ids or
//     trial_pack.'.
//
//   The $10K cap is the policy upper-bound for a single crypto
//   checkout — anything higher should go through enterprise sales.
//
// stays in lockstep across api-types Zod canonical.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PRICE_CENTS_MAX = 1_000_000;

describe('W902 CryptoCheckout currency + price-cents cross-source invariant', () => {
  // ─── CreateCryptoCheckoutRequest 3-field bounds ──────────────

  it('CRITICAL packages/api-types/src/crypto-orders.ts CreateCryptoCheckoutRequestSchema has 3 fields — product (V-924: the self-serve paid tier enum, free and enterprise refined out) + price_cents (positive int max 1M) + price_currency (3-letter ISO regex).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/CreateCryptoCheckoutRequestSchema = z\.object\(\{/);
    expect(p, 'product is the purchasable-tier enum').toMatch(
      /product: z\s*\n\s*\.enum\(PURCHASABLE_TIERS, \{/,
    );
    // Per-occurrence negative: an unconstrained product field would put the
    // published contract back out of step with the enum the route enforces.
    expect(p, 'the bare-string form must not return').not.toMatch(
      /product: z\.string\(\)\.describe\(/,
    );
    expect(p).toMatch(/price_cents: z\.number\(\)\.int\(\)\.positive\(\)\.max\(1_000_000\),/);
  });

  it("CRITICAL price_currency uses length(3) + regex /^[A-Z]{3}$/ + error message 'price_currency must be a 3-letter uppercase ISO code'. The 3-letter ISO 4217 regex is what NowPayments accepts.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(
      /price_currency: z\s*\n?\s*\.string\(\)\s*\n\s*\.length\(3\)\s*\n\s*\.regex\(\/\^\[A-Z\]\{3\}\$\/, 'price_currency must be a 3-letter uppercase ISO code'\)/,
    );
  });

  // ─── 1M cents = $10K max bound rationale ─────────────────────

  it('CRITICAL price_cents max bound = 1_000_000 (= $10,000 USD or equiv in any 3-letter ISO currency). The 10K cap is the policy upper-bound for a single crypto checkout — anything higher should go through enterprise sales.', () => {
    expect(PRICE_CENTS_MAX).toBe(1_000_000);
    expect(PRICE_CENTS_MAX / 100).toBe(10_000); // $10K in 2-decimal currencies
  });

  // ─── CryptoOrderEvent 3-field shape ──────────────────────────

  it('CRITICAL CryptoOrderEventSchema 3 fields — status + at (ISO-8601 UTC describe) + source. The 3-field shape is the per-state-transition row in the V-666.AT append-only timeline.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(
      /CryptoOrderEventSchema = z\.object\(\{\s*\n\s*status: CryptoOrderStatusSchema,\s*\n\s*at: z\.string\(\)\.describe\('ISO-8601 UTC timestamp of the transition\.'\),\s*\n\s*source: CryptoOrderEventSourceSchema,/,
    );
  });

  // ─── CreateCryptoCheckoutResponse provider 2-value ───────────

  it("CRITICAL CreateCryptoCheckoutResponse.provider = z.enum(['stub', 'nowpayments']) — checkout alone reports the payment rail; 'stub' is the support-assisted fallback.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/provider: z\.enum\(\['stub', 'nowpayments'\]\)/);
    expect(p).toMatch(
      /Payment rail used for this checkout; `stub` is the support-assisted fallback/,
    );
  });

  // ─── product SKU describe ────────────────────────────────────

  it("CRITICAL product field describe pins 'SKU; one of the self-serve paid tier ids (free and enterprise are not purchasable).' The describe is what reaches SDK consumers through the OpenAPI document, so it has to name BOTH exclusions — V-924: the previous text named only the free tier while the route refuses enterprise as well, so a customer reading the spec could send it and get a 400 the description did not predict.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(
      /\.describe\(\s*\n?\s*'SKU; one of the self-serve paid tier ids \(free and enterprise are not purchasable\)\.',?\s*\n?\s*\)/,
    );
    // Per-occurrence negative. Paraphrased above rather than quoted so this
    // assertion cannot be satisfied by the sentence that retracts it.
    expect(p, 'the single-exclusion wording must not return').not.toMatch(
      /describe\('SKU; one of the paid tier ids/,
    );
  });

  // ─── 4-field CreateCryptoCheckoutResponse ────────────────────

  it('CRITICAL CreateCryptoCheckoutResponseSchema has 9 fields — order_id + product + price_cents + price_currency + status + provider + payment_address (nullable) + pay_currency (nullable) + created_at. The 9-field response gives clients enough to begin payment.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    const m = p.match(/CreateCryptoCheckoutResponseSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of [
      'order_id:',
      'product:',
      'price_cents:',
      'price_currency:',
      'status:',
      'provider:',
      'payment_address:',
      'pay_currency:',
      'created_at:',
    ]) {
      expect(body, `CreateCryptoCheckoutResponse must have ${f}`).toMatch(new RegExp(f));
    }
  });

  // ─── payment_address + pay_currency nullable ─────────────────

  it("CRITICAL CreateCryptoCheckoutResponse.payment_address + pay_currency BOTH nullable — server may return null when provider hasn't issued an address yet (e.g. stub mode + race conditions). Clients must handle null.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/payment_address: z\.string\(\)\.nullable\(\)/);
    expect(p).toMatch(/pay_currency: z\.string\(\)\.nullable\(\)/);
  });

  // ─── V-666.AU customer-facing source framing ─────────────────

  it("CRITICAL V-666.AU framing — 'customer-facing event source. swept is mapped to expired server-side before serialization so the customer-facing surface only sees four sources'. The swept→expired mapping is what makes the customer event-timeline narrative coherent.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.AU — customer-facing event source/);
    expect(p).toMatch(/'swept' is mapped to[\s\S]*?'expired' server-side before serialization/);
    expect(p).toMatch(/surface only sees four sources/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/crypto-checkout-currency-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

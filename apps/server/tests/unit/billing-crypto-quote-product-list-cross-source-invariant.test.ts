// Cross-source invariant — the crypto QUOTE route's purchasable-product list
// must equal the authoritative price table it quotes from.
//
// Two routes decide which tiers a crypto customer can transact:
//   • CHECKOUT (routes/billing-crypto.ts) DERIVES its product enum:
//     `SUPPORTED_PRODUCTS = Object.keys(TIER_PRICE_CENTS)` → can never drift.
//   • QUOTE    (routes/billing-crypto-quote.ts) hand-maintains an INDEPENDENT
//     literal `const SUPPORTED_PRODUCTS: AccountTier[] = [ … ]`.
//
// The quote route reads the price from the same TIER_PRICE_CENTS table, so the
// two lists are SUPPOSED to be identical — the file comment even says the schema
// "lines up with the price table." But nothing asserts it. Add a tier to
// TIER_PRICE_CENTS (checkout auto-supports it; its content-parity test is
// updated in the same commit) and forget the quote route's hardcoded list, and:
// a customer can open a crypto order for the new tier but CANNOT get a price
// quote for it first (the quote schema rejects it → 400). That is precisely the
// "#10 checkout-vs-quote product-list mismatch" that already shipped once and was
// only resolved by deleting trial_pack — the drift STRUCTURE remains. The v666h
// content-parity test pins the quote list's 6 literal tiers, but independently of
// the price table, so it stays green across exactly this drift.
//
// This invariant fails the moment the quote list and the price table diverge.
// (Deeper structural fix, surfaced for a focused call: derive the quote route's
// SUPPORTED_PRODUCTS from Object.keys(TIER_PRICE_CENTS) too — exactly as checkout
// does — which would make this drift impossible rather than merely detected.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', '..', '..', 'apps/server/src');

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8');
}

// Capture groups out of `matchAll`, dropping any that didn't participate
// (keeps the return type `string[]` under noUncheckedIndexedAccess without a
// non-null assertion).
function captures(body: string, re: RegExp): string[] {
  return [...body.matchAll(re)].flatMap((m) => (m[1] !== undefined ? [m[1]] : []));
}

// Keys of `export const TIER_PRICE_CENTS: Record<string, number> = { … };`
function priceTableTiers(): string[] {
  const src = read('routes/billing-crypto.ts');
  const block = src.match(/const TIER_PRICE_CENTS: Record<string, number> = \{([\s\S]*?)\};/);
  const body = block?.[1];
  if (body === undefined) throw new Error('TIER_PRICE_CENTS block not found');
  return captures(body, /([a-z_]+)\s*:\s*\d+/g);
}

// Tier string literals inside the quote route's `const SUPPORTED_PRODUCTS … = [ … ];`
function quoteSupportedProducts(): string[] {
  const src = read('routes/billing-crypto-quote.ts');
  const block = src.match(/const SUPPORTED_PRODUCTS[^=]*=\s*\[([\s\S]*?)\];/);
  const body = block?.[1];
  if (body === undefined) throw new Error('quote SUPPORTED_PRODUCTS block not found');
  return captures(body, /'([a-z_]+)'/g);
}

describe('crypto quote product-list cross-source invariant (quote SUPPORTED_PRODUCTS ↔ TIER_PRICE_CENTS)', () => {
  const priceTiers = priceTableTiers();
  const quoteTiers = quoteSupportedProducts();

  it('sanity — both lists extract a non-trivial set including a known paid tier', () => {
    expect(priceTiers.length).toBeGreaterThanOrEqual(6);
    expect(priceTiers).toContain('api_scale');
    expect(quoteTiers).toContain('api_scale');
  });

  it('the quote route quotes EXACTLY the tiers the price table prices — a drift means a tier is checkout-able but not quote-able (the #10 mismatch class)', () => {
    expect([...quoteTiers].sort()).toEqual([...priceTiers].sort());
  });

  it('the CHECKOUT route stays auto-derived from TIER_PRICE_CENTS (so the quote list is the only hand-maintained side this guard must watch)', () => {
    const checkout = read('routes/billing-crypto.ts');
    expect(checkout).toMatch(
      /const SUPPORTED_PRODUCTS = Object\.keys\(TIER_PRICE_CENTS\) as \[string, \.\.\.string\[\]\];/,
    );
  });
});

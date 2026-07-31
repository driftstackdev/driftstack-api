// W411.C — drift guard for apps/server/src/routes/billing-crypto-quote.ts.
// V-666.H POST /v1/billing/crypto-checkout/quote — price preview for the
// crypto-checkout page before committing to an order. Stateless (no DB
// write) so re-fetching is cheap. Drift here either breaks the tier
// allowlist (lets unsupported tiers reach the price table → 500) or
// drops auth/rate-limit on a pricing endpoint that mirrors paid tiers.
//
//   • V-666.H framing pinned: price preview endpoint; stateless;
//     re-fetchable; minted-order vs quote distinction.
//   • Pricing-only boundary pinned: payment-specific crypto amount,
//     currency and address belong to checkout creation.
//   • SUPPORTED_PRODUCTS allowlist: 6 tiers (solo_manual, team_manual,
//     agency_manual, api_starter, api_builder, api_scale).
//   • Auth + rate-limit posture: requireAuth + global rate-limit bucket.
//   • QuoteSchema: zod product enum cast + optional price_currency 3-
//     letter uppercase ISO with regex validator.
//   • Defensive 400 (not 500) when product not in TIER_PRICE_CENTS
//     — "schema-vs-table desync" guard rationale.
//   • Reply shape: {product, price_cents, price_currency = the USD
//     settlement currency; a caller-supplied value is ignored}.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-quote.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W411.C apps/server/src/routes/billing-crypto-quote.ts content parity', () => {
  const body = read(LIB);

  it('V-666.H framing pinned: POST /v1/billing/crypto-checkout/quote + price preview + quote-vs-order distinction', () => {
    expect(body).toMatch(/V-666\.H — POST \/v1\/billing\/crypto-checkout\/quote\./);
    expect(body).toMatch(
      /Price preview for the crypto-checkout page\. Customers hit this\s*\n?\s*\/\/\s*before committing to actually opening an order \(which would mint\s*\n?\s*\/\/\s*an order_id \+ reserve a payment address\)\./,
    );
  });

  it('Pricing-only boundary pinned: payment-specific values are returned only by checkout creation', () => {
    expect(body).toMatch(
      /The response carries\s*\n?\s*\/\/ only the authoritative tier price in fiat cents\. The exact crypto\s*\n?\s*\/\/ currency, amount and deposit address are payment-specific values\s*\n?\s*\/\/ returned by checkout creation, never invented by this stateless preview\./,
    );
    expect(body).not.toMatch(/provider: 'stub'|pay_currency: null|pay_min_amount|pay_max_amount/);
  });

  it('Stateless framing pinned: no DB write; re-fetching cheap; not rate-limited beyond global bucket', () => {
    expect(body).toMatch(
      /Quote responses are stateless — no DB write — so re-fetching is\s*\n?\s*\/\/\s*cheap and the route is not rate-limited beyond the global bucket\./,
    );
  });

  it('SUPPORTED_PRODUCTS: 6-tier allowlist (solo_manual + team_manual + agency_manual + api_starter + api_builder + api_scale)', () => {
    expect(body).toMatch(
      /const SUPPORTED_PRODUCTS: AccountTier\[\] = \[\s*\n?\s*'solo_manual',\s*\n?\s*'team_manual',\s*\n?\s*'agency_manual',\s*\n?\s*'api_starter',\s*\n?\s*'api_builder',\s*\n?\s*'api_scale',\s*\n?\s*\];/,
    );
  });

  it('QuoteSchema: product enum cast as [AccountTier, ...AccountTier[]] + optional price_currency 3-letter uppercase ISO', () => {
    expect(body).toMatch(
      /const QuoteSchema = z\.object\(\{\s*\n?\s*product: z\.enum\(SUPPORTED_PRODUCTS as \[AccountTier, \.\.\.AccountTier\[\]\]\),\s*\n?\s*price_currency: z\s*\n?\s*\.string\(\)\s*\n?\s*\.length\(3\)\s*\n?\s*\.regex\(\/\^\[A-Z\]\{3\}\$\/, 'price_currency must be a 3-letter uppercase ISO code'\)\s*\n?\s*\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it('Route registration: POST + read:billing scope before the global rate limit', () => {
    expect(body).toMatch(
      /app\.post\(\s*\n?\s*'\/v1\/billing\/crypto-checkout\/quote',\s*\n?\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('read:billing'\), app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('Defensive desync guard: priceCents undefined → 400 ValidationError (not 500) with "No quote available for tier" + schema-vs-table rationale', () => {
    expect(body).toMatch(
      /if \(priceCents === undefined\) \{\s*\n?\s*\/\/ Defensive: schema gated on a fixed list that lines up with\s*\n?\s*\/\/ the price table\. A new tier added to one but not the other\s*\n?\s*\/\/ is a 400 here rather than a 500\./,
    );
    expect(body).toMatch(
      /throw new ValidationError\(\{\s*\n?\s*fieldErrors: \{ product: \[`No quote available for tier "\$\{product\}"\.`\] \},\s*\n?\s*formErrors: \[\],\s*\n?\s*\}\);/,
    );
  });

  it('Reply shape is exactly product + price_cents + price_currency = the USD settlement currency', () => {
    expect(body).toMatch(
      /return reply\.send\(\{\s*\n?\s*product,\s*\n?\s*price_cents: priceCents,\s*\n?\s*price_currency: CRYPTO_SETTLEMENT_CURRENCY,\s*\n?\s*\}\);/,
    );
  });

  it('Validation: parsed = QuoteSchema.safeParse(req.body); ValidationError on failure', () => {
    expect(body).toMatch(/const parsed = QuoteSchema\.safeParse\(req\.body\);/);
    expect(body).toMatch(
      /if \(!parsed\.success\) throw new ValidationError\(parsed\.error\.flatten\(\)\);/,
    );
  });

  it('price source: reads the SAME PricingService.listEffective() the crypto-checkout CHARGE uses (quote == charge through owner edits), found by tier → monthlyCents', () => {
    expect(body).toMatch(/const effectivePricing = await deps\.pricing\.listEffective\(\);/);
    expect(body).toMatch(
      /const priceCents = effectivePricing\.find\(\(row\) => row\.tier === product\)\?\.monthlyCents;/,
    );
    // Must NOT read the static constant directly (that diverged quote from
    // charge the moment an owner edited a DB price — the bug this closed).
    expect(body).not.toMatch(/const priceCents = TIER_PRICE_CENTS\[product\];/);
  });

  it('deps: CryptoQuoteRoutesDeps carries pricing: PricingService (same source as the charge route)', () => {
    expect(body).toMatch(/export interface CryptoQuoteRoutesDeps \{/);
    expect(body).toMatch(/pricing: PricingService;/);
    expect(body).toMatch(
      /export function registerCryptoQuoteRoutes\(app: FastifyInstance, deps: CryptoQuoteRoutesDeps\): void/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + AccountTier (SDK mirror) + zod + ValidationError + PricingService (the checkout-authoritative price source, so quote == charge)', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ ValidationError \} from '\.\.\/lib\/errors\.js';/);
    expect(body).toMatch(/import type \{ PricingService \} from '\.\.\/services\/pricing\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

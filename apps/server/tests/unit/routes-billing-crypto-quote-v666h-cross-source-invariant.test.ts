// W1021 — routes/billing-crypto-quote V-666.H cross-source invariant.
// Three-hundred-forty-seventh in the drift-guard series. Pins the
// apps/server/src/routes/billing-crypto-quote.ts crypto-checkout
// quote preview:
//
//   V-666.H anchor — 'V-666.H — POST /v1/billing/crypto-checkout/
//   quote'.
//
//   Stateless framing — 'Quote responses are stateless — no DB write —
//   so re-fetching is cheap and the route is not rate-limited beyond
//   the global bucket'.
//
//   Stub framing — 'until the NowPayments client lands and we can
//   call its /v1/estimate endpoint, the response is a stub
//   pay_currency: null + computed fiat-cents from the tier table'.
//
//   SUPPORTED_PRODUCTS 6 tiers — solo_manual + team_manual +
//     agency_manual + api_starter + api_builder + api_scale.
//
//   QuoteSchema — product (enum) + optional price_currency (3-letter
//     uppercase ISO).
//
//   Defensive 'No quote available for tier' — for schema/table
//     drift; 400 not 500.
//
//   Response 7 fields — product + price_cents + price_currency (??
//     'EUR') + provider:'stub' + pay_currency:null + pay_min_amount:
//     null + pay_max_amount:null.
//
//   preHandler [requireAuth, rateLimit('global')].
//
// stays in lockstep across apps/server/src/routes/billing-crypto-quote.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1021 routes/billing-crypto-quote V-666.H cross-source invariant', () => {
  it("CRITICAL V-666.H anchor — 'V-666.H — POST /v1/billing/crypto-checkout/quote'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-quote.ts'));
    expect(p).toMatch(/V-666\.H — POST \/v1\/billing\/crypto-checkout\/quote\./);
  });

  it("CRITICAL stateless framing — 'Quote responses are stateless — no DB write — so re-fetching is cheap and the route is not rate-limited beyond the global bucket'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-quote.ts'));
    expect(p).toMatch(/Quote responses are stateless — no DB write — so re-fetching is/);
    expect(p).toMatch(/cheap and the route is not rate-limited beyond the global bucket\./);
  });

  it("CRITICAL stub framing — 'until the NowPayments client lands and we can call its /v1/estimate endpoint, the response is a stub pay_currency: null + computed fiat-cents from the tier table'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-quote.ts'));
    expect(p).toMatch(/until the NowPayments client lands and we can call its/);
    expect(p).toMatch(/`\/v1\/estimate` endpoint, the response is a stub `pay_currency: null`/);
    expect(p).toMatch(/\+ computed fiat-cents from the tier table/);
  });

  it('CRITICAL SUPPORTED_PRODUCTS 6 tiers — solo_manual + team_manual + agency_manual + api_starter + api_builder + api_scale.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-quote.ts'));
    expect(p).toMatch(/const SUPPORTED_PRODUCTS: AccountTier\[\] = \[/);
    expect(p).toMatch(/'solo_manual',/);
    expect(p).toMatch(/'team_manual',/);
    expect(p).toMatch(/'agency_manual',/);
    expect(p).toMatch(/'api_starter',/);
    expect(p).toMatch(/'api_builder',/);
    expect(p).toMatch(/'api_scale',/);
  });

  it('CRITICAL QuoteSchema — product (enum of SUPPORTED_PRODUCTS) + optional 3-letter-uppercase ISO price_currency.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-quote.ts'));
    expect(p).toMatch(
      /product: z\.enum\(SUPPORTED_PRODUCTS as \[AccountTier, \.\.\.AccountTier\[\]\]\),/,
    );
    expect(p).toMatch(/price_currency: z/);
    expect(p).toMatch(/\.string\(\)/);
    expect(p).toMatch(/\.length\(3\)/);
    expect(p).toMatch(
      /\.regex\(\/\^\[A-Z\]\{3\}\$\/, 'price_currency must be a 3-letter uppercase ISO code'\)/,
    );
    expect(p).toMatch(/\.optional\(\),/);
  });

  it("CRITICAL defensive 'No quote available for tier' 400 — schema/table-drift safety. The 400 not 500 keeps the failure attributable to client.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-quote.ts'));
    expect(p).toMatch(/\/\/ Defensive: schema gated on a fixed list that lines up with/);
    expect(p).toMatch(/\/\/ the price table\. A new tier added to one but not the other/);
    expect(p).toMatch(/\/\/ is a 400 here rather than a 500\./);
    expect(p).toMatch(/throw new ValidationError\(\{/);
    expect(p).toMatch(
      /fieldErrors: \{ product: \[`No quote available for tier "\$\{product\}"\.`\] \},/,
    );
  });

  it("CRITICAL response 7-field shape — product + price_cents + price_currency (?? 'EUR') + provider:'stub' + pay_currency:null + pay_min_amount:null + pay_max_amount:null.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-quote.ts'));
    expect(p).toMatch(/product,/);
    expect(p).toMatch(/price_cents: priceCents,/);
    expect(p).toMatch(/price_currency: parsed\.data\.price_currency \?\? 'EUR',/);
    expect(p).toMatch(/provider: 'stub',/);
    expect(p).toMatch(/pay_currency: null,/);
    expect(p).toMatch(/pay_min_amount: null,/);
    expect(p).toMatch(/pay_max_amount: null,/);
  });

  it("CRITICAL preHandler [requireAuth, requireScope('read:billing'), rateLimit('global')].", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-quote.ts'));
    expect(p).toMatch(
      /\{ preHandler: \[app\.requireAuth, app\.requireScope\('read:billing'\), app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-billing-crypto-quote-v666h-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

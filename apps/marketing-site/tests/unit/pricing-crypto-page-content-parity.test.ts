// W376.C — drift guard for marketing-site /pricing/crypto page
// content. V-674 + W247.C. Existing pricing-crypto-parity test
// covers basic shape. This guard pins the load-bearing customer-
// experience claims for crypto-payment evaluators:
//
//   • V-674 + V-666 family posture framing pinned: documents the
//     ACTUAL current flow (request quote → support sends address
//     out-of-band → IPN settles) not the V-666.D future state.
//   • W247.C — labels derived from API_TIERS data source (single
//     source of truth, hard-coded prices would drift).
//   • 6 CRYPTO_PAYABLE_TIER_IDS in canonical order: solo_manual /
//     team_manual / agency_manual / api_starter / api_builder /
//     api_scale. (The free tier is not purchasable.)
//   • 5 ACCEPTED_CURRENCIES pinned exactly: BTC / ETH / USDC
//     (ERC-20) / USDT (ERC-20) / USDC (Polygon).
//   • 4-row confirmation timing table: BTC (2 conf, ~20min) /
//     ETH (12 conf, ~3min) / USDC-USDT-ERC20 (12 conf, ~3min) /
//     USDC-Polygon (32 conf, ~90s).
//   • 1-hour pay-window claim pinned + auto-cancel framing.
//   • "Crypto payments are non-refundable" pinned + /legal/refunds
//     cross-link (load-bearing commercial-policy claim).
//   • 4-step checkout flow (dashboard → mint order → broadcast
//     transfer → settle on confirmations).
//   • 3 failure modes pinned: underpayment / late payment / wrong
//     currency.
//   • Tax: USD-denominated invoices (matches card-billing).
//   • Enterprise wire/crypto-on-negotiated-invoice escape hatch.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing/crypto.astro');
const PRICING_DATA = resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W376.C marketing-site /pricing/crypto page content parity', () => {
  const body = read(PAGE);

  it('V-674 + V-666 family posture framing pinned (current flow, not future state)', () => {
    expect(body).toMatch(/V-674 — crypto-payments pricing page/);
    expect(body).toMatch(/V-666 \/\s*\n?\s*\/\/\s*V-666\.B \/ V-666\.C/);
    expect(body).toMatch(
      /this page describes what the\s*\n?\s*\/\/\s*customer actually experiences today \(not the future state\)/,
    );
    expect(body).toMatch(/V-666\.D follow-up wires\s*\n?\s*\/\/\s*a NowPayments merchant account/);
  });

  it('W247.C — labels derived from API_TIERS data source (no two-source-of-truth drift)', () => {
    expect(existsSync(PRICING_DATA)).toBe(true);
    expect(body).toMatch(/W247\.C — labels derived from API_TIERS/);
    expect(body).toMatch(/import \{ API_TIERS \} from '\.\.\/\.\.\/data\/pricing\.ts';/);
  });

  it('6 CRYPTO_PAYABLE_TIER_IDS pinned in canonical order (free tier is not purchasable)', () => {
    const block = body.match(/const CRYPTO_PAYABLE_TIER_IDS = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const ids = Array.from(block![1]!.matchAll(/'([a-z_]+)'/g)).map((m) => m[1] as string);
    expect(ids).toEqual([
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
    ]);
  });

  it('5 ACCEPTED_CURRENCIES pinned exactly (BTC / ETH / USDC-ERC20 / USDT-ERC20 / USDC-Polygon)', () => {
    expect(body).toMatch(
      /const ACCEPTED_CURRENCIES = \['BTC', 'ETH', 'USDC \(ERC-20\)', 'USDT \(ERC-20\)', 'USDC \(Polygon\)'\];/,
    );
  });

  it('4-row confirmation timing table pinned (BTC 2/~20min, ETH 12/~3min, ERC-20 12/~3min, Polygon 32/~90s)', () => {
    expect(body).toMatch(/<tr><td>BTC<\/td><td>2<\/td><td>~20 minutes<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>ETH<\/td><td>12<\/td><td>~3 minutes<\/td><\/tr>/);
    expect(body).toMatch(
      /<tr><td>USDC \/ USDT \(ERC-20\)<\/td><td>12<\/td><td>~3 minutes<\/td><\/tr>/,
    );
    expect(body).toMatch(/<tr><td>USDC \(Polygon\)<\/td><td>32<\/td><td>~90 seconds<\/td><\/tr>/);
  });

  it('1-hour pay-window claim + auto-cancel framing pinned', () => {
    expect(body).toMatch(/equivalent\s+crypto amount is locked in for 1 hour from order creation/);
    expect(body).toMatch(/If\s+you pay outside that window, the order auto-cancels/);
  });

  it('"Crypto payments are non-refundable" pinned + /legal/refunds cross-link', () => {
    // Appears twice (callout + dedicated section).
    const occurrences = body.match(/Crypto payments are non-refundable/g);
    expect(occurrences).not.toBeNull();
    expect(occurrences!.length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/<a href="\/legal\/refunds">refund policy<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/refunds">\/legal\/refunds<\/a>/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/refunds.md'))).toBe(
      true,
    );
  });

  it('4-step checkout flow pinned (dashboard → mint order → broadcast → settle)', () => {
    expect(body).toMatch(/From your account dashboard, pick the tier and click/);
    expect(body).toMatch(
      /The Driftstack backend mints an order via NowPayments and\s+returns a unique deposit address \+ the exact amount to send\./,
    );
    expect(body).toMatch(/You broadcast the on-chain transfer/);
    expect(body).toMatch(
      /NowPayments watches the chain; once your transfer hits the\s+required confirmation count, Driftstack flips your account\s+to the new tier\./,
    );
  });

  it('3 failure modes pinned: underpayment / late payment / wrong currency', () => {
    expect(body).toMatch(/<strong>Underpayment<\/strong>/);
    expect(body).toMatch(/the order moves to <code>partial<\/code>/);
    expect(body).toMatch(/<strong>Late payment<\/strong>/);
    expect(body).toMatch(/<strong>Wrong currency<\/strong>/);
    expect(body).toMatch(
      /sending an unsupported\s+asset to the deposit address means the funds are not recovered\s+automatically/,
    );
  });

  it('tax + accounting: USD-denominated invoices (matches card-billing posture)', () => {
    expect(body).toMatch(
      /Driftstack issues USD-denominated invoices for crypto payments\s+based on the quoted USD price at order time, not the realised\s+crypto amount/,
    );
  });

  it('Enterprise wire/crypto-on-negotiated-invoice escape hatch pinned', () => {
    expect(body).toMatch(
      /Enterprise tiers \(custom pricing\) settle through wire transfer or\s+crypto on a negotiated invoice/,
    );
    expect(body).toMatch(/mailto:sales@driftstack\.dev/);
  });

  it("'card-billing path is the right channel for refunds' Stripe-fallback claim pinned", () => {
    expect(body).toMatch(
      /If you need a refund mechanism, our card-billing path \(Stripe\)\s+is the right channel/,
    );
  });

  it('runtime guard against missing tier id in API_TIERS (throw fast)', () => {
    expect(body).toMatch(
      /if \(!t\) throw new Error\(`Crypto-supported tier not found in API_TIERS: \$\{id\}`\);/,
    );
  });

  it('hero copy pinned: "Paying with crypto" headline + NowPayments processor anchor. 2026-05-23 — h1 wrapped with hero-glow + gradient text; intro restructured (icon-marked lead + body). Pin loosened to label + processor.', () => {
    expect(body).toMatch(/Paying with crypto/);
    expect(body).toMatch(/NowPayments/);
  });
});

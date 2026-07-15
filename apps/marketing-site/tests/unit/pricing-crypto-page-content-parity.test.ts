// W376.C — drift guard for marketing-site /pricing/crypto page
// content. V-674 + W247.C. Existing pricing-crypto-parity test
// covers basic shape. This guard pins the load-bearing customer-
// experience claims for crypto-payment evaluators:
//
//   • V-674 + V-666 family posture framing pinned: documents the
//     ACTUAL current flow (request quote → billing sends address
//     out-of-band → IPN settles) without a self-serve promise.
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
//   • No-automatic-expiry quote framing pinned (price is fixed at order
//     creation; no timer auto-cancels a pending order — corrected 2026-06-30
//     from a fictional 1-hour auto-cancel claim the backend never implemented).
//   • "Crypto payments are non-refundable" pinned + /legal/refunds
//     cross-link (load-bearing commercial-policy claim).
//   • 4-step invoice flow (email billing → receive provider-backed
//     invoice → broadcast transfer → settle on confirmations).
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

  it('V-674 + V-666 family posture framing pinned to the current handled invoice flow', () => {
    expect(body).toMatch(/V-674 — crypto-payments pricing page/);
    expect(body).toMatch(/V-666 \/\s*\n?\s*\/\/\s*V-666\.B \/ V-666\.C/);
    expect(body).toMatch(/customer-facing path is a handled crypto/);
    expect(body).toMatch(/without promising a\s*\n?\s*\/\/\s*self-serve checkout/);
    expect(body).not.toMatch(/stubbed|follow-up wires|future state/i);
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

  it("No-automatic-expiry quote framing pinned (a fictional '1-hour price-lock + auto-cancel' claim was corrected 2026-06-30: no code path ever automatically transitions a pending crypto order to expired/failed — sweep-expired is admin-manual-only, defaults to 24h not 1h, and no cron is registered)", () => {
    expect(body).toMatch(
      /equivalent\s+crypto amount is fixed when the order is created and doesn't\s+change/,
    );
    // S20b 2026-07-06 reconciliation: the page previously contradicted
    // itself ("no fixed 1-hour cutoff" vs the Late-payment bullet's 1-hour
    // pay-window). Both facts are true and now stated together: the quote
    // carries a 1-hour pay-window (server PAY_WINDOW_MS = 1h, gated by
    // W340.A), but NOTHING auto-cancels — a missed order just goes stale
    // and support closes it manually.
    expect(body).toMatch(
      /You then have a 1-hour window to pay at that quote\. An\s+order that misses the window isn't cancelled by a timer — it just\s+goes stale/,
    );
    expect(body).not.toMatch(/order auto-cancels/);
  });

  it('"Crypto payments are non-refundable" pinned + /legal/refunds cross-link', () => {
    // Appears twice (callout + dedicated section).
    const occurrences = body.match(/Crypto payments are non-refundable/g);
    expect(occurrences).not.toBeNull();
    expect(occurrences!.length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/<a href="\/legal\/refunds\/">refund policy<\/a>/);
    expect(body).toMatch(/<a href="\/legal\/refunds\/">\/legal\/refunds<\/a>/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/refunds.md'))).toBe(
      true,
    );
  });

  it('4-step invoice flow pinned (email billing → provider-backed invoice → send transfer → settle on confirmations)', () => {
    expect(body).toMatch(
      /Email <a href="mailto:billing@driftstack\.dev">billing@driftstack\.dev<\/a>/,
    );
    expect(body).toMatch(
      /Driftstack creates the provider-backed invoice and sends\s+you the exact amount, network, pay window, and one-time deposit address\./,
    );
    expect(body).toMatch(/You send the transfer\. The exchange or wallet\s+you use is up to you/);
    expect(body).toMatch(
      /NowPayments watches the blockchain; once your transfer reaches\s+the required number of confirmations, Driftstack activates your\s+tier and sends the receipt\./,
    );
    expect(body).not.toMatch(
      /pick the tier and click|unlocks automatically|no support ticket needed/,
    );
  });

  it('3 failure modes pinned: underpayment / late payment / wrong currency (S20b plain words, all 3 escalation paths intact)', () => {
    expect(body).toMatch(/<strong>Underpayment<\/strong>/);
    expect(body).toMatch(/the order is marked <code>partial<\/code>/);
    expect(body).toMatch(/<strong>Late payment<\/strong>/);
    expect(body).toMatch(/<strong>Wrong currency<\/strong>/);
    expect(body).toMatch(
      /if you send a currency we\s+don't accept, the money will not come back on its own/,
    );
  });

  it('tax + accounting: invoices in US dollars at the quoted (not realised) price — matches card-billing posture (S20b plain words, same facts)', () => {
    expect(body).toMatch(
      /Invoices for crypto payments are issued in US dollars, at the USD\s+price quoted when you ordered — not at what the crypto happened to\s+be worth when it arrived/,
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

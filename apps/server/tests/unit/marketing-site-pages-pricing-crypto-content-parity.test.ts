// W502.B — drift guard for apps/marketing-site/src/pages/pricing/crypto.astro.
// V-674 crypto-payments pricing page. Drift here either breaks the V-666 /
// V-666.B / V-666.C posture description (would let customers expect a
// flow we can't deliver pre-NowPayments-account) or drops a supported
// currency / confirmation count (would create marketing↔settle-window
// divergence).
//
//   • V-674 doc-comment framing + NowPayments stub posture description.
//   • W247.C — API_TIERS sourced labels.
//   • CRYPTO_PAYABLE_TIER_IDS 6-tier list: 3 Manual + 3 API (free not purchasable)
//     (no Enterprise — that lands in a wire/invoice flow).
//   • ACCEPTED_CURRENCIES 5-currency list: BTC / ETH / USDC ERC-20 /
//     USDT ERC-20 / USDC Polygon.
//   • Confirmation timing table: BTC 2 / ETH 12 / USDC-USDT ERC-20 12 /
//     USDC Polygon 32.
//   • 1-hour pay window for crypto-USD quote.
//   • Crypto-non-refundable framing + 4-step checkout flow.
//   • 3-state error handling: Underpayment / Late payment / Wrong currency.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing/crypto.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W502.B apps/marketing-site/src/pages/pricing/crypto.astro content parity', () => {
  const body = read(LIB);

  it("V-674 framing pinned: 'crypto-payments pricing page. Documents the V-666 / V-666.B / V-666.C crypto-checkout posture for customers who land on `/pricing/crypto` from the marketing nav.' — pinned so the V-cluster reference + the 'this is the customer-facing posture today' commitment survive (drift to dropping V-666.B/C would orphan the engineering-side V-cluster from the customer view)", () => {
    expect(body).toMatch(
      /\/\/ V-674 — crypto-payments pricing page\. Documents the V-666 \/\s*\n?\s*\/\/ V-666\.B \/ V-666\.C crypto-checkout posture for customers who land\s*\n?\s*\/\/ on `\/pricing\/crypto` from the marketing nav\./,
    );
  });

  it('NowPayments posture framing pinned to the CURRENT live flow: the API mints the order and the one-time payment address, the signed IPN settles and activates the tier, and a deployment without provider credentials fails closed. `6f30d12f5` superseded the old stub posture, and `apps/server/src/routes/billing-crypto.ts` really does mint `pay_address` through NowPayments `POST /v1/payment` — so the page must describe that flow, and must keep the fail-closed sentence rather than implying every deployment can take crypto.', () => {
    expect(body).toMatch(
      /\/\/ Posture \(current\): production checkout is live\. The API mints the\s*\n?\s*\/\/ NowPayments order and one-time payment address; the signed IPN\s*\n?\s*\/\/ settles it and activates the purchased tier\./,
    );
    expect(body).toMatch(
      /Deployments without provider\s*\n?\s*\/\/ credentials fail closed and direct customers to card or billing\./,
    );
    // The superseded stub framing must not come back as customer-facing copy.
    expect(body).not.toMatch(/payment-address minting is stubbed/);
  });

  it('W247.C labels-derived framing pinned: derived from API_TIERS (single source of truth in marketing-site/src/data/pricing.ts) + "Hard-coded prices here drifted against the canonical table; deriving keeps both layers in lockstep." — pinned so the W247.C derive-from-API_TIERS rationale survives (drift to hardcoding prices would re-introduce the divergence W247.C fixed)', () => {
    expect(body).toMatch(
      /\/\/ W247\.C — labels derived from API_TIERS \(single source of truth in\s*\n?\s*\/\/ marketing-site\/src\/data\/pricing\.ts\)\. Hard-coded prices here drifted\s*\n?\s*\/\/ against the canonical table; deriving keeps both layers in lockstep\./,
    );
    expect(body).toMatch(/import \{ API_TIERS \} from '\.\.\/\.\.\/data\/pricing\.ts';/);
  });

  it("CRYPTO_PAYABLE_TIER_IDS 6-tier list: solo_manual + team_manual + agency_manual + api_starter + api_builder + api_scale (free tier is not purchasable; trial pack retired) — pinned so the crypto-payable tier scope stays consistent (drift to adding 'enterprise' would over-promise crypto for the wire/invoice tier; drift to dropping a self-serve tier would block crypto for that-tier customers)", () => {
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

  it('ACCEPTED_CURRENCIES 5-asset list: BTC + ETH + USDC (ERC-20) + USDT (ERC-20) + USDC (Polygon) — pinned so the 5-currency scope stays consistent (drift to dropping USDC Polygon would lose the fast-settle option; drift to adding an unsupported asset would mislead customers about what NowPayments will actually accept)', () => {
    expect(body).toMatch(
      /const ACCEPTED_CURRENCIES = \['BTC', 'ETH', 'USDC \(ERC-20\)', 'USDT \(ERC-20\)', 'USDC \(Polygon\)'\];/,
    );
  });

  it('Confirmation timing table 4-row map: BTC 2 conf / ~20min + ETH 12 conf / ~3min + USDC-USDT ERC-20 12 conf / ~3min + USDC Polygon 32 conf / ~90s — pinned so the per-asset settle timing stays consistent with NowPayments configuration (drift to changing a confirmation count would create marketing↔backend divergence on when account unlocks)', () => {
    expect(body).toMatch(/<tr><td>BTC<\/td><td>2<\/td><td>~20 minutes<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>ETH<\/td><td>12<\/td><td>~3 minutes<\/td><\/tr>/);
    expect(body).toMatch(
      /<tr><td>USDC \/ USDT \(ERC-20\)<\/td><td>12<\/td><td>~3 minutes<\/td><\/tr>/,
    );
    expect(body).toMatch(/<tr><td>USDC \(Polygon\)<\/td><td>32<\/td><td>~90 seconds<\/td><\/tr>/);
  });

  it("No-automatic-expiry quote framing pinned: 'the equivalent crypto amount is fixed when the order is created and doesn't change. There's no fixed 1-hour cutoff — a pending order isn't automatically cancelled on a timer.' + support@driftstack.dev stale-order-closure path — pinned so the honest no-auto-cancel statement survives (a fictional '1 hour price-lock + auto-cancel' claim was corrected 2026-06-30: expireOrder()/sweepExpiredOrders() in apps/server/src/services/crypto-orders.ts are never invoked by any route or scheduled job — sweep-expired is admin-manual-only via POST /v1/admin/crypto-orders/sweep-expired with a default 24h window, not 1h, and no cron is registered in apps/server/src/lib/bootstrap.ts. Drift back to claiming an automatic timer would re-create the doc/code mismatch; drift to dropping the support-contact fallback would orphan customers wanting a fresh quote)", () => {
    expect(body).toMatch(
      /the equivalent\s*\n?\s*crypto amount is fixed when the order is created and doesn't\s*\n?\s*change\./,
    );
    // S20b 2026-07-06 reconciliation: the quote carries a 1-hour pay-window
    // (server PAY_WINDOW_MS = 1h, gated by W340.A) but NOTHING auto-cancels
    // — a missed order just goes stale and support closes it manually. This
    // resolves the page's prior self-contradiction with the Late-payment
    // bullet while keeping the no-auto-cancel truth this pin protects.
    expect(body).toMatch(
      /You then have a 1-hour window to pay at that quote\. An\s*\n?\s*order that misses the window isn't cancelled by a timer — it just\s*\n?\s*goes stale\./,
    );
    expect(body).toMatch(
      /email\s*\n?\s*<a href="mailto:support@driftstack\.dev">support@driftstack\.dev<\/a>\s*\n?\s*and we'll close the stale order so you can check out again at\s*\n?\s*the current price\./,
    );
    // The fabricated auto-cancel mechanic must not reappear.
    expect(body).not.toMatch(/order auto-cancels/);
  });

  it("Crypto-non-refundable framing pinned: 'Crypto payments are non-refundable.' (banner) + 'Once a crypto payment settles on-chain, it is committed for the billing period it covers.' + 'If you need a refund mechanism, our card-billing path (Stripe) is the right channel' — pinned so the non-refundable commitment + the Stripe-card-fallback survive (drift to softening 'non-refundable' would invite refund disputes that NowPayments can't honor)", () => {
    expect(body).toMatch(/<strong>Crypto payments are non-refundable\.<\/strong>/g);
    expect(body).toMatch(
      /Once a\s*\n?\s*crypto payment settles on-chain, it is committed for the\s*\n?\s*billing period it covers\./,
    );
    expect(body).toMatch(
      /If you need a refund mechanism, our card-billing path \(Stripe\)\s*\n?\s*is the right channel/,
    );
  });

  it("4-step checkout flow: 'Pay with crypto' click → 'NowPayments and returns a unique deposit address' → 'broadcast the on-chain transfer' → 'flips your account to the new tier' — pinned so the 4-step crypto-checkout customer-mental-model stays consistent (drift to dropping the 'unique deposit address' framing would let customers expect a static address; drift to dropping 'flips your account' would obscure the auto-unlock behaviour)", () => {
    expect(body).toMatch(/<strong>Pay with crypto<\/strong>/);
    // S20b 2026-07-06 plain words, same flow (one-time deposit address +
    // auto tier-switch on confirmations both still pinned).
    expect(body).toMatch(
      /Driftstack creates an order through NowPayments and shows\s*\n?\s*you a one-time deposit address \+ the exact amount to send\./,
    );
    expect(body).toMatch(
      /You send the transfer\. The exchange or wallet\s*\n?\s*you use is up to you/,
    );
    expect(body).toMatch(
      /once your transfer reaches\s*\n?\s*the required number of confirmations, Driftstack switches your\s*\n?\s*account to the new tier\./,
    );
  });

  it('3-state error handling: Underpayment (partial → support 1-business-day topup) + Late payment (expired-order reconcile) + Wrong currency (best-effort recovery via tx hash) — pinned so the 3 failure-mode escalation paths stay documented (drift to dropping any would orphan customers in that error state)', () => {
    // S20b 2026-07-06 plain words — all 3 escalation paths intact.
    expect(body).toMatch(
      /<strong>Underpayment<\/strong> — if the transfer is short of\s*\n?\s*the quoted amount, the order is marked <code>partial<\/code>/,
    );
    expect(body).toMatch(
      /<strong>Late payment<\/strong> — transfers received after the\s*\n?\s*1-hour pay-window land on an order we treat as expired/,
    );
    expect(body).toMatch(
      /<strong>Wrong currency<\/strong> — if you send a currency we\s*\n?\s*don't accept, the money will not come back on its own/,
    );
  });

  it("USD invoice framing pinned: 'Invoices for crypto payments are issued in US dollars, at the USD price quoted when you ordered — not at what the crypto happened to be worth when it arrived.' (S20b plain words) — pinned so the USD-invoice + quoted-not-realised commitment survives (drift to switching to crypto-denominated invoices would break customer-side accounting that's built on USD line items)", () => {
    expect(body).toMatch(
      /Invoices for crypto payments are issued in US dollars, at the USD\s*\n?\s*price quoted when you ordered — not at what the crypto happened to\s*\n?\s*be worth when it arrived/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

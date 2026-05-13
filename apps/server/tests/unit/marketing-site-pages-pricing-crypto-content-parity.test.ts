// W502.B — drift guard for apps/marketing-site/src/pages/pricing/crypto.astro.
// V-674 crypto-payments pricing page. Drift here either breaks the V-666 /
// V-666.B / V-666.C posture description (would let customers expect a
// flow we can't deliver pre-NowPayments-account) or drops a supported
// currency / confirmation count (would create marketing↔settle-window
// divergence).
//
//   • V-674 doc-comment framing + NowPayments stub posture description.
//   • W247.C — API_TIERS sourced labels.
//   • CRYPTO_PAYABLE_TIER_IDS 7-tier list: trial_pack + 3 Manual + 3 API
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

  it("NowPayments stub-posture framing pinned: 'the checkout endpoint mints an order but payment-address minting is stubbed — the customer-facing flow is \"request quote, support sends a payment address out-of-band, IPN settles.\" That arrangement holds until the V-666.D follow-up wires a NowPayments merchant account' — pinned so the honest 'we mint orders but addresses are stub' commitment survives (drift to claiming live address minting would over-promise pre-V-666.D)", () => {
    expect(body).toMatch(
      /\/\/ payment-address minting is stubbed — the customer-facing flow is\s*\n?\s*\/\/ "request quote, support sends a payment address out-of-band, IPN\s*\n?\s*\/\/ settles\." That arrangement holds until the V-666\.D follow-up wires\s*\n?\s*\/\/ a NowPayments merchant account/,
    );
  });

  it('W247.C labels-derived framing pinned: derived from API_TIERS (single source of truth in marketing-site/src/data/pricing.ts) + "Hard-coded prices here drifted against the canonical table; deriving keeps both layers in lockstep." — pinned so the W247.C derive-from-API_TIERS rationale survives (drift to hardcoding prices would re-introduce the divergence W247.C fixed)', () => {
    expect(body).toMatch(
      /\/\/ W247\.C — labels derived from API_TIERS \(single source of truth in\s*\n?\s*\/\/ marketing-site\/src\/data\/pricing\.ts\)\. Hard-coded prices here drifted\s*\n?\s*\/\/ against the canonical table; deriving keeps both layers in lockstep\./,
    );
    expect(body).toMatch(/import \{ API_TIERS \} from '\.\.\/\.\.\/data\/pricing\.ts';/);
  });

  it("CRYPTO_PAYABLE_TIER_IDS 7-tier list: trial_pack + solo_manual + team_manual + agency_manual + api_starter + api_builder + api_scale — pinned so the crypto-payable tier scope stays consistent (drift to adding 'enterprise' would over-promise crypto for the wire/invoice tier; drift to dropping a self-serve tier would block crypto for that-tier customers)", () => {
    expect(body).toMatch(
      /const CRYPTO_PAYABLE_TIER_IDS = \[\s*\n?\s*'trial_pack',\s*\n?\s*'solo_manual',\s*\n?\s*'team_manual',\s*\n?\s*'agency_manual',\s*\n?\s*'api_starter',\s*\n?\s*'api_builder',\s*\n?\s*'api_scale',\s*\n?\s*\];/,
    );
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

  it("1-hour quote window pinned: 'the equivalent crypto amount is locked in for 1 hour from order creation. If you pay outside that window, the order auto-cancels and you can mint a new one.' — pinned so the 1-hour-quote-lock + auto-cancel + mint-new fallback survives (drift to changing the window would create marketing↔order-state-machine divergence; drift to dropping 'auto-cancels' would let customers think a late transfer succeeds silently)", () => {
    expect(body).toMatch(
      /the equivalent\s*\n?\s*crypto amount is locked in for 1 hour from order creation\. If\s*\n?\s*you pay outside that window, the order auto-cancels and you can\s*\n?\s*mint a new one\./,
    );
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
    expect(body).toMatch(
      /The Driftstack backend mints an order via NowPayments and\s*\n?\s*returns a unique deposit address \+ the exact amount to send\./,
    );
    expect(body).toMatch(
      /You broadcast the on-chain transfer\. The exchange or wallet\s*\n?\s*you use is up to you/,
    );
    expect(body).toMatch(
      /once your transfer hits the\s*\n?\s*required confirmation count, Driftstack flips your account\s*\n?\s*to the new tier\./,
    );
  });

  it('3-state error handling: Underpayment (partial → support 1-business-day topup) + Late payment (expired-order reconcile) + Wrong currency (best-effort recovery via tx hash) — pinned so the 3 failure-mode escalation paths stay documented (drift to dropping any would orphan customers in that error state)', () => {
    expect(body).toMatch(
      /<strong>Underpayment<\/strong> — if the transfer is short of\s*\n?\s*the quoted amount, the order moves to <code>partial<\/code>/,
    );
    expect(body).toMatch(
      /<strong>Late payment<\/strong> — transfers received after the\s*\n?\s*1-hour pay-window land on an expired order/,
    );
    expect(body).toMatch(
      /<strong>Wrong currency<\/strong> — sending an unsupported\s*\n?\s*asset to the deposit address means the funds are not recovered\s*\n?\s*automatically/,
    );
  });

  it("USD-denominated invoice framing pinned: 'Driftstack issues USD-denominated invoices for crypto payments based on the quoted USD price at order time, not the realised crypto amount.' — pinned so the USD-invoice + quoted-not-realised commitment survives (drift to switching to crypto-denominated invoices would break customer-side accounting that's built on USD line items)", () => {
    expect(body).toMatch(
      /Driftstack issues USD-denominated invoices for crypto payments\s*\n?\s*based on the quoted USD price at order time, not the realised\s*\n?\s*crypto amount\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

// W264.B — drift-guard for /docs/billing-faq. Pins:
// 1. Free-tier concurrent/profile caps + non-refundability of crypto match data.
// 2. Free desktop ds_test_ versus paid customer ds_live_ boundary.
// 3. 14-day refund window for card payments.
// 4. NowPayments + Stripe pathways are named (no fictional providers).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TIER_CONCURRENT_SESSION_LIMITS,
  PROFILES_PER_TIER,
  TIER_FEATURES,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/billing-faq.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W264.B /docs/billing-faq ↔ live billing parity', () => {
  const page = read(PAGE);

  it('Free-tier concurrent + profile caps match data layer', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS.free).toBe(1);
    expect(PROFILES_PER_TIER.free).toBe(1);
    expect(page).toMatch(/1\s+concurrent\s+session/);
    expect(page).toMatch(/1\s+profile/);
  });

  it('Free is desktop-only while paid tiers provide ds_live customer API keys', () => {
    expect(TIER_FEATURES.free.apiAccess).toBe(false);
    expect(page).toMatch(/launched and driven through the desktop app/);
    expect(page).toMatch(/restricted\s+<code>ds_test_…<\/code> device credential automatically/);
    expect(page).toMatch(/<code>ds_live_…<\/code> customer API keys require a\s+paid tier/);
    expect(page).toMatch(/cannot create or\s+rotate them/);
    expect(page).not.toMatch(/drive them from the API\/SDK/);
    expect(page).not.toMatch(/no separate[^.]*ds_test_/);
  });

  it('card refund window is 14 days; crypto is non-refundable', () => {
    expect(page).toMatch(/14 days of payment/);
    expect(page).toMatch(/Crypto payments[^.]*non-refundable/i);
  });

  it('payment providers Stripe + NowPayments are named (no fictional providers)', () => {
    expect(page).toMatch(/Stripe Checkout/);
    expect(page).toMatch(/NowPayments/);
    // No fictional providers.
    expect(page).not.toMatch(/CoinPayments/);
    expect(page).not.toMatch(/Coinbase Commerce/);
    expect(page).not.toMatch(/BitPay/);
  });

  it('separates fixed subscription payment truth from the operational cost estimate', () => {
    expect(page).toMatch(/new fixed subscription price and entitlement limits/);
    expect(page).toMatch(/do not create usage overages/);
    expect(page).toMatch(
      /Stripe's Customer Portal and Stripe-issued invoices are the source of\s+truth/,
    );
    expect(page).toMatch(/NowPayments order receipt for the amount paid/);
    expect(page).toMatch(/operational cost estimate[\s\S]*unit-economics view, not an invoice/);
    expect(page).toMatch(
      /does not itemize sessions,\s+recordings, storage, egress, email, or LLM as customer charges/,
    );
    expect(page).toMatch(/included-service monthly budget/);
  });

  it('states the real cancellation lifecycle without a fictional 30-day purge', () => {
    expect(page).toMatch(/account then moves to the Free tier\s+automatically/);
    expect(page).toMatch(/Cancellation itself does not schedule a data\s+purge/);
    expect(page).toMatch(/recordings saved by the desktop\s+app stay on that device/);
    expect(page).toMatch(/resubscribe at any time/);
    expect(page).not.toMatch(/30 days[\s\S]{0,100}(?:purged|deleted)/i);
  });

  it('VAT / reverse-charge framing is consistent with EU + UK Stripe Tax', () => {
    expect(page).toMatch(/VAT/);
    expect(page).toMatch(/reverse-charge/);
  });
});

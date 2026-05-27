// W264.B — drift-guard for /docs/billing-faq. Pins:
// 1. Free-tier concurrent/profile caps + non-refundability of crypto match data.
// 2. ds_live_ prefix and no separate ds_test_ namespace.
// 3. 14-day refund window for card payments.
// 4. NowPayments + Stripe pathways are named (no fictional providers).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_CONCURRENT_SESSION_LIMITS, PROFILES_PER_TIER } from '@driftstack/api-types';

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

  it('ds_live_ prefix is the only key namespace today', () => {
    expect(page).toMatch(/ds_live_/);
    // The doc explicitly says no ds_test_ namespace exists today.
    expect(page).toMatch(/no separate[^.]*ds_test_/);
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

  it('VAT / reverse-charge framing is consistent with EU + UK Stripe Tax', () => {
    expect(page).toMatch(/VAT/);
    expect(page).toMatch(/reverse-charge/);
  });
});

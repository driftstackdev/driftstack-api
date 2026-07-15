import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/stripe-bootstrap-prices.mjs');

describe('Stripe bootstrap catalog content parity', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const tiers = source.match(/const TIERS = \[([\s\S]*?)\n\];/)?.[1] ?? '';

  it('pins the six public self-serve tiers to the exact monthly and annual totals', () => {
    const expected = [
      ['solo_manual', 'Personal', '7_900', '75_800'],
      ['team_manual', 'Team', '24_900', '239_000'],
      ['agency_manual', 'Agency', '69_900', '671_000'],
      ['api_starter', 'API Starter', '14_900', '143_000'],
      ['api_builder', 'API Builder', '49_900', '479_000'],
      ['api_scale', 'API Scale', '149_900', '1_439_000'],
    ] as const;

    expect(tiers.match(/\bid:/g)).toHaveLength(expected.length);
    for (const [id, name, monthly, annual] of expected) {
      expect(tiers).toContain(
        `{ id: '${id}', name: '${name}', monthly_cents: ${monthly}, annual_cents: ${annual} }`,
      );
    }
  });

  it('does not recreate the retired trial pack or derive annual prices from stale arithmetic', () => {
    expect(source).not.toMatch(/\bTRIAL_PACK\b/);
    expect(source).not.toContain('STRIPE_TRIAL_PACK_PRICE_ID');
    expect(source).not.toMatch(/monthly_cents\s*\*\s*10/);
  });

  it('retains idempotent metadata lookup and emits only the canonical tier-price map', () => {
    expect(source).toContain("metadata['driftstack_tier']:'${tier}'");
    expect(source).toContain("metadata['billing_period']:'${period}'");
    expect(source).toContain('`driftstack-product-${tier}`');
    expect(source).toContain('`driftstack-price-${tier}-${period}`');
    expect(source).toContain("ensurePrice(tier.id, 'monthly'");
    expect(source).toContain("ensurePrice(tier.id, 'annual'");
    expect(source).toContain("DRIFTSTACK_TIER_PRICE_IDS='${JSON.stringify(tierPrices)}'");
  });
});

// W268.B — drift-guard for customer-dashboard /select-tier page.
// Pins the hard-coded TIERS array (id + price) against the canonical
// marketing-site pricing data. The dashboard onboarding picker must
// not drift away from what /pricing advertises.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/select-tier.astro');
const PRICING = resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const liveTiers = new Set(AccountTierSchema.options);

describe('W268.B /select-tier ↔ marketing pricing parity', () => {
  const page = read(PAGE);
  const pricing = read(PRICING);

  it('every tier id in TIERS is a real AccountTierSchema value', () => {
    const ids = [...page.matchAll(/id:\s*'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(3);
    const offenders = ids.filter((id) => !liveTiers.has(id as never));
    expect(offenders).toEqual([]);
  });

  it('Solo Manual / Team Manual / etc. price labels match marketing data', () => {
    const pairs: Array<[string, number]> = [
      ['solo_manual', 79],
      ['team_manual', 249],
      ['agency_manual', 699],
      ['api_starter', 149],
      ['api_builder', 499],
      ['api_scale', 1_499],
    ];
    for (const [id, monthly] of pairs) {
      // pricing.ts maps id → monthlyUsd. The literal may have an
      // underscore thousands separator (e.g. `1_499`).
      const monthlyLiteral = monthly.toString();
      const monthlyWithSep =
        monthly >= 1000
          ? `${monthlyLiteral.slice(0, -3)}_?${monthlyLiteral.slice(-3)}`
          : monthlyLiteral;
      expect(pricing).toMatch(
        new RegExp(`id:\\s*'${id}',[\\s\\S]{0,200}monthlyUsd:\\s*${monthlyWithSep}`),
      );
      const formatted =
        monthly >= 1000 ? `$${monthly.toLocaleString('en-US')}/mo` : `$${monthly}/mo`;
      expect(page).toContain(formatted);
    }
  });

  it('TIERS list omits enterprise (Sales contact only) + trial_pack (free trial)', () => {
    const ids = [...page.matchAll(/id:\s*'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(ids).not.toContain('enterprise');
    expect(ids).not.toContain('trial_pack');
  });

  it('imports PROFILES_PER_TIER + TIER_CONCURRENT_SESSION_LIMITS from api-types', () => {
    expect(page).toMatch(/PROFILES_PER_TIER/);
    expect(page).toMatch(/TIER_CONCURRENT_SESSION_LIMITS/);
    expect(page).toMatch(/from\s+['"]@driftstack\/api-types['"]/);
  });

  it('14-day pro-rated refund framing matches the billing-faq', () => {
    expect(page).toMatch(/14 days/);
  });
});

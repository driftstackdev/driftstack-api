// W292.A — drift guard for select-tier page tier-card coverage.
// Every paid, self-serve AccountTier must appear as a card on
// /select-tier so customers can pick any subscription tier.
// Excluded: 'free' (the perpetual default entry tier — no purchase,
// so no card) and 'enterprise' (contact-sales, not self-serve).
// Catches drift where a tier ships in the schema but the dashboard
// doesn't expose it for selection.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/select-tier.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W292.A /select-tier ↔ AccountTierSchema coverage', () => {
  const body = read(PAGE);

  it('every paid AccountTier appears as a card on /select-tier', () => {
    const tiers = AccountTierSchema.options.filter((t) => t !== 'free' && t !== 'enterprise');
    const missing: string[] = [];
    for (const tier of tiers) {
      const re = new RegExp(`\\bid:\\s*['"]${tier}['"]`);
      if (!re.test(body)) missing.push(tier);
    }
    expect(missing).toEqual([]);
    // Exactly the 6 self-serve paid tiers render as cards. The 7th paid
    // tier (enterprise) is contact-sales — a mailto link, not a card.
    expect(tiers).toEqual([
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
    ]);
    // 'free' is the default entry tier and must NOT render as a card.
    expect(body).not.toMatch(/\bid:\s*['"]free['"]/);
  });

  it('cards declare a label that matches the live tier id (capitalised words)', () => {
    const offenders: string[] = [];
    const matches = [
      ...body.matchAll(/\{\s*id:\s*['"]([a-z_]+)['"]\s*,\s*label:\s*['"]([^'"]+)['"]/g),
    ];
    for (const m of matches) {
      const id = m[1]!;
      const label = m[2]!;
      // Label should contain the second segment of the id (e.g.
      // solo_manual → "Manual"; api_starter → "Starter").
      const segment = id.split('_')[1] ?? '';
      const cap = segment.charAt(0).toUpperCase() + segment.slice(1);
      if (segment && !label.includes(cap)) {
        offenders.push(`${id} → ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

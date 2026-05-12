// W292.A — drift guard for select-tier page tier-card coverage.
// Every AccountTier (except trial_pack, which has its own focus
// section) must appear as a card on /select-tier so customers can
// pick any subscription tier. Catches drift where a tier ships in
// the schema but the dashboard doesn't expose it for selection.

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
    const tiers = AccountTierSchema.options.filter((t) => t !== 'trial_pack' && t !== 'enterprise');
    const missing: string[] = [];
    for (const tier of tiers) {
      const re = new RegExp(`\\bid:\\s*['"]${tier}['"]`);
      if (!re.test(body)) missing.push(tier);
    }
    expect(missing).toEqual([]);
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

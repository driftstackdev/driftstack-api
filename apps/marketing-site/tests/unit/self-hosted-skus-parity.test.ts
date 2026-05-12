// W261.B — drift-guard for /self-hosted page. Pins SELF_HOSTED_SKUS
// pricing + the page's claim of three tiers (Solo / Pro / Enterprise).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SELF_HOSTED_SKUS } from '../../src/data/pricing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/self-hosted.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W261.B /self-hosted ↔ SELF_HOSTED_SKUS data parity', () => {
  const page = read(PAGE);

  it('three live SKUs cover Solo / Pro / Enterprise', () => {
    const ids = SELF_HOSTED_SKUS.map((s) => s.id).sort();
    expect(ids).toEqual(['self_hosted_enterprise', 'self_hosted_pro', 'self_hosted_solo']);
  });

  it('Solo monthly $1000 / annual-monthly $800 match data', () => {
    const solo = SELF_HOSTED_SKUS.find((s) => s.id === 'self_hosted_solo')!;
    expect(solo.monthlyUsd).toBe(1000);
    expect(solo.annualMonthlyEquivalentUsd).toBe(800);
    expect(solo.profilesMax).toBe(25);
    expect(solo.archetypesMax).toBe(1);
  });

  it('Pro monthly $2000 / annual-monthly $1600 match data', () => {
    const pro = SELF_HOSTED_SKUS.find((s) => s.id === 'self_hosted_pro')!;
    expect(pro.monthlyUsd).toBe(2000);
    expect(pro.annualMonthlyEquivalentUsd).toBe(1600);
    expect(pro.profilesMax).toBe(100);
    expect(pro.archetypesMax).toBe(3);
  });

  it('Enterprise is annual-only (no monthlyUsd) + source-escrow on', () => {
    const ent = SELF_HOSTED_SKUS.find((s) => s.id === 'self_hosted_enterprise')!;
    expect(ent.monthlyUsd).toBeNull();
    expect(ent.annualMonthlyEquivalentUsd).toBe(4000);
    expect(ent.sourceEscrow).toBe(true);
    expect(ent.minimumTermMonths).toBe(12);
  });

  it('page imports SELF_HOSTED_SKUS from the data layer (no hard-coded numbers)', () => {
    expect(page).toMatch(/SELF_HOSTED_SKUS/);
    expect(page).toMatch(/from\s*['"]\.\.\/data\/pricing(?:\.ts)?['"]/);
  });

  it('every SKU id has a hardware-row entry on the page', () => {
    for (const sku of SELF_HOSTED_SKUS) {
      expect(page).toContain(sku.id);
    }
  });

  it('page does not hard-code legacy SKU pricing numbers', () => {
    // Sentinel old values from earlier waves: $500 monthly, $400 annual.
    expect(page).not.toMatch(/\$500\/mo\b/);
    expect(page).not.toMatch(/\$400\/mo\b/);
  });
});

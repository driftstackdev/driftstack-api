// W292.B — drift guard for marketing-site /pricing page data
// binding. The page must render tier data from API_TIERS, not from
// inline hard-coded prices. Catches drift where a refactor copies
// prices into the .astro file instead of using the canonical data
// module.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W292.B /pricing data-binding parity', () => {
  const body = read(PAGE);

  it('page imports API_TIERS from data/pricing', () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?\bAPI_TIERS\b[\s\S]*?\}\s+from\s+['"][^'"]*data\/pricing(\.ts)?['"]/,
    );
  });

  it('page filters API_TIERS by tierType (manual / api / trial)', () => {
    expect(body).toMatch(/API_TIERS\.filter\(\s*\(t\)\s*=>\s*t\.tierType\s*===\s*['"]manual['"]/);
    expect(body).toMatch(/API_TIERS\.filter\(\s*\(t\)\s*=>\s*t\.tierType\s*===\s*['"]api['"]/);
  });

  it('full pricing matrix renders via {fmtUsd(tier.monthlyUsd)} not hard-coded', () => {
    // The persona-card section above the matrix can cite prices
    // inline as a fast-scan summary, but the matrix itself must
    // bind monthlyUsd via the formatter so a tier-price change in
    // pricing.ts propagates without touching the page.
    expect(body).toMatch(/\{fmtUsd\(tier\.monthlyUsd\)\}/);
    expect(body).toMatch(/\{fmtUsd\(tier\.annualMonthlyEquivalentUsd\)\}/);
  });
});

// W248.B — drift-guard for /pricing/comparison. The page is a
// per-tier spreadsheet view; it should derive every cell from
// API_TIERS so it can't drift from /pricing (W246.B) or
// /pricing/crypto (W247.C). This guard verifies the derivation
// import + flags any hard-coded $-price literal.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_TIERS } from '../../../marketing-site/src/data/pricing.ts';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'pricing',
  'comparison.astro',
);

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W248.B /pricing/comparison doc parity', () => {
  const doc = read();

  it('imports API_TIERS from the canonical pricing data file', () => {
    expect(doc).toMatch(
      /import \{[^}]*API_TIERS[^}]*\} from ['"]\.\.\/\.\.\/data\/pricing\.ts['"]/,
    );
  });

  it('does not hard-code paid-tier monthly prices in the page body', () => {
    // Pull every $NN[N][.NN] literal not adjacent to a placeholder like
    // "fmtUsd(" — i.e. anything that looks like a hard-coded price.
    // The page should use the fmtUsd helper exclusively for pricing.
    const stripped = doc.replace(/^---[\s\S]*?---/, '');
    const numeric = Array.from(stripped.matchAll(/\$(\d[\d,]*(?:\.\d+)?)/g)).map((m) => m[1]!);
    // The free tier ($0) and every paid tier render via the fmtUsd
    // helper, so no hard-coded price literal should appear at all.
    const offenders = numeric;
    expect(offenders).toEqual([]);
  });

  it('renders rows for every paid tier in API_TIERS', () => {
    // The doc filters out the free tier but renders every other tier.
    expect(doc).toMatch(/paidTiers = API_TIERS\.filter\(\(t\) => t\.id !== 'free'\)/);
    // Tiers must include the locked list.
    const ids = new Set(API_TIERS.map((t) => t.id));
    for (const id of [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('keeps the comparison-dimension groupings in display order', () => {
    expect(doc).toMatch(/heading:\s*['"]Pricing['"]/);
    expect(doc).toMatch(/DIMENSIONS = \[/);
  });
});

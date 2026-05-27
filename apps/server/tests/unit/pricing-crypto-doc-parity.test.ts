// W247.C — drift-guard for /pricing/crypto. Previous revision listed
// hard-coded tier prices ($25 / $80 / $300 / $50 / $250) that had
// drifted against the canonical API_TIERS table ($79 / $249 / $699 /
// $149 / $499). The page now derives labels from API_TIERS; this
// guard verifies the derived labels contain the live prices.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_TIERS } from '../../../marketing-site/src/data/pricing.ts';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'pricing', 'crypto.astro');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W247.C /pricing/crypto doc parity', () => {
  const doc = read();

  it('derives SUPPORTED_TIERS from API_TIERS (no hard-coded prices)', () => {
    expect(doc).toContain(`import { API_TIERS } from '../../data/pricing.ts'`);
    // No raw hard-coded stale price labels.
    expect(doc).not.toMatch(/Solo Manual \(\$25\/mo\)/);
    expect(doc).not.toMatch(/Team Manual \(\$80\/mo\)/);
    expect(doc).not.toMatch(/Agency Manual \(\$300\/mo\)/);
    expect(doc).not.toMatch(/API Starter \(\$50\/mo\)/);
    expect(doc).not.toMatch(/API Builder \(\$250\/mo\)/);
  });

  it('the canonical tier prices in API_TIERS are stable', () => {
    const byId = new Map(API_TIERS.map((t) => [t.id, t]));
    expect(byId.get('solo_manual')!.monthlyUsd).toBe(79);
    expect(byId.get('team_manual')!.monthlyUsd).toBe(249);
    expect(byId.get('agency_manual')!.monthlyUsd).toBe(699);
    expect(byId.get('api_starter')!.monthlyUsd).toBe(149);
    expect(byId.get('api_builder')!.monthlyUsd).toBe(499);
    expect(byId.get('api_scale')!.monthlyUsd).toBe(1_499);
  });

  it('crypto-payable list references the six paid tiers (free not purchasable; trial pack retired)', () => {
    expect(doc).toMatch(/CRYPTO_PAYABLE_TIER_IDS/);
    for (const id of [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
    ]) {
      expect(doc).toContain(`'${id}'`);
    }
    expect(doc).not.toContain(`'trial_pack'`);
  });

  it('keeps the accepted currencies list', () => {
    expect(doc).toMatch(/'BTC'/);
    expect(doc).toMatch(/'ETH'/);
    expect(doc).toMatch(/'USDC \(ERC-20\)'/);
  });
});

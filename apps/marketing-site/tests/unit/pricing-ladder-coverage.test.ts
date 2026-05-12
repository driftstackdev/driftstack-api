// W319.B — drift guard for /pricing tier ladder coverage. Each
// of the eight canonical AccountTier slugs must appear in API_TIERS
// (the marketing source of truth), and tier grouping must be:
//   • 'trial'  → trial_pack
//   • 'manual' → solo_manual / team_manual / agency_manual
//   • 'api'    → api_starter / api_builder / api_scale / enterprise

import { describe, expect, it } from 'vitest';
import { API_TIERS } from '../../src/data/pricing';
import { AccountTierSchema } from '@driftstack/api-types';

const EXPECTED_GROUPS: Record<string, string[]> = {
  trial: ['trial_pack'],
  manual: ['solo_manual', 'team_manual', 'agency_manual'],
  api: ['api_starter', 'api_builder', 'api_scale', 'enterprise'],
};

describe('W319.B /pricing ladder coverage', () => {
  it('API_TIERS covers all 8 canonical AccountTier slugs', () => {
    const ids = new Set(API_TIERS.map((p) => p.id));
    const schemaTiers = AccountTierSchema.options;
    const missing = schemaTiers.filter((t) => !ids.has(t));
    expect(missing).toEqual([]);
  });

  it('API_TIERS contains exactly the expected number of entries (8)', () => {
    expect(API_TIERS.length).toBe(8);
  });

  it('trial group: only trial_pack', () => {
    const ids = API_TIERS.filter((p) => p.tierType === 'trial').map((p) => p.id);
    expect(ids).toEqual(EXPECTED_GROUPS.trial);
  });

  it('manual ladder ordered solo → team → agency', () => {
    const ids = API_TIERS.filter((p) => p.tierType === 'manual').map((p) => p.id);
    expect(ids).toEqual(EXPECTED_GROUPS.manual);
  });

  it('api ladder ordered starter → builder → scale → enterprise', () => {
    const ids = API_TIERS.filter((p) => p.tierType === 'api').map((p) => p.id);
    expect(ids).toEqual(EXPECTED_GROUPS.api);
  });
});

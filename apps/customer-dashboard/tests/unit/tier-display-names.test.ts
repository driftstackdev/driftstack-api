import { describe, expect, it } from 'vitest';
import { TIER_DISPLAY_NAMES } from '../../src/data/tier-display-names.ts';

describe('customer tier display names', () => {
  it('covers every current tier with a customer-facing label', () => {
    expect(TIER_DISPLAY_NAMES).toEqual({
      free: 'Free',
      solo_manual: 'Personal',
      team_manual: 'Team',
      agency_manual: 'Agency',
      api_starter: 'API Starter',
      api_builder: 'API Builder',
      api_scale: 'API Scale',
      enterprise: 'Enterprise',
    });
  });
});

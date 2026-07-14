import type { AccountTier } from '@driftstack/api-types';

/** Customer-facing labels for the canonical API tier identifiers. */
export const TIER_DISPLAY_NAMES: Record<AccountTier, string> = {
  free: 'Free',
  solo_manual: 'Personal',
  team_manual: 'Team',
  agency_manual: 'Agency',
  api_starter: 'API Starter',
  api_builder: 'API Builder',
  api_scale: 'API Scale',
  enterprise: 'Enterprise',
};

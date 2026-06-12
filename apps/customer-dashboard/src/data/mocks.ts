// Mock data for customer-dashboard scaffolding. Swap to live API
// reads (`/v1/billing`, `/v1/profiles`, `/v1/api-keys`, `/v1/sessions`,
// `/v1/usage`) once the dashboard moves past scaffolding into a wired
// state — gated on the customer-dashboard-stack proposal in
// docs/architecture/customer-dashboard-stack.md.

import {
  TIER_CONCURRENT_SESSION_LIMITS,
  type AccountTier,
  type Profile,
  type Subscription,
} from '@driftstack/api-types';

// Customer-facing display name for each backend tier id. Single source
// of truth so the account overview + billing pages stop rendering the
// raw id (e.g. "solo_manual") and instead show the human plan name that
// marketing + /select-tier use. The Manual ladder was renamed to
// Personal / Team / Agency on 2026-05-29; the ids are unchanged.
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

export interface MockAccount {
  id: string;
  email: string;
  name: string | null;
  tier: AccountTier;
  emailVerifiedAt: string | null;
  createdAt: string;
}

export const MOCK_ACCOUNT: MockAccount = {
  id: 'acc_00000000-0000-4000-8000-000000000001',
  email: 'tester@driftstack.local',
  name: 'Tester',
  tier: 'api_builder',
  emailVerifiedAt: '2026-04-15T09:00:00Z',
  createdAt: '2026-04-15T08:55:00Z',
};

export const MOCK_SUBSCRIPTION: Subscription | null = {
  tier: 'api_builder',
  status: 'active',
  stripe_subscription_id: 'sub_test_dashboard_mock',
  current_period_end: '2026-06-15T08:55:00Z',
  cancel_at_period_end: false,
  canceled_at: null,
  created_at: '2026-04-15T09:00:00Z',
  updated_at: '2026-04-15T09:00:00Z',
};

export const MOCK_PROFILES: Profile[] = [
  {
    id: 'prof_00000000-0000-4000-8000-0000000000a1',
    name: 'work-laptop',
    archetype: 'iphone17_ios18_7_safari26_4',
    description: 'primary work profile',
    folder: 'Work',
    tags: ['primary'],
    last_used_at: '2026-05-02T18:30:00Z',
    created_at: '2026-04-15T09:05:00Z',
    updated_at: '2026-05-02T18:30:00Z',
  },
  {
    id: 'prof_00000000-0000-4000-8000-0000000000a2',
    name: 'staging-tester',
    archetype: 'iphone17_ios18_7_safari26_4',
    description: 'integration test rig',
    folder: null,
    tags: ['qa'],
    last_used_at: '2026-05-01T11:15:00Z',
    created_at: '2026-04-20T14:00:00Z',
    updated_at: '2026-05-01T11:15:00Z',
  },
];

export interface MockApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ReadonlyArray<'read' | 'write' | 'admin' | 'gui_control'>;
  last_used_at: string | null;
  created_at: string;
}

export const MOCK_API_KEYS: MockApiKey[] = [
  {
    id: 'key_00000000-0000-4000-8000-0000000000b1',
    name: 'production',
    key_prefix: 'ds_live_a1b2c3d4',
    scopes: ['read', 'write'],
    last_used_at: '2026-05-03T10:00:00Z',
    created_at: '2026-04-15T09:10:00Z',
  },
];

export interface MockUsageSummary {
  period_start: string;
  period_end: string;
  tier: AccountTier;
  totals: {
    session_minute: number;
    navigate: number;
    interact: number;
    state_capture: number;
    screenshot_capture: number;
  };
  concurrent_now: number;
  concurrent_limit: number;
}

export const MOCK_USAGE_SUMMARY: MockUsageSummary = {
  period_start: '2026-05-01T00:00:00Z',
  period_end: '2026-05-31T23:59:59Z',
  tier: 'api_builder',
  totals: {
    session_minute: 423,
    navigate: 1284,
    interact: 5612,
    state_capture: 312,
    screenshot_capture: 189,
  },
  concurrent_now: 2,
  concurrent_limit: TIER_CONCURRENT_SESSION_LIMITS.api_builder,
};

export interface MockSession {
  id: string;
  status: 'creating' | 'ready' | 'busy' | 'destroyed' | 'errored';
  archetype: string;
  profile_id: string | null;
  created_at: string;
  destroyed_at: string | null;
  duration_ms: number | null;
}

export const MOCK_SESSIONS: MockSession[] = [
  {
    id: 'ses_00000000-0000-4000-8000-0000000000c1',
    status: 'ready',
    archetype: 'iphone17_ios18_7_safari26_4',
    profile_id: 'prof_00000000-0000-4000-8000-0000000000a1',
    created_at: '2026-05-03T11:30:00Z',
    destroyed_at: null,
    duration_ms: null,
  },
  {
    id: 'ses_00000000-0000-4000-8000-0000000000c2',
    status: 'destroyed',
    archetype: 'iphone17_ios18_7_safari26_4',
    profile_id: 'prof_00000000-0000-4000-8000-0000000000a1',
    created_at: '2026-05-02T18:00:00Z',
    destroyed_at: '2026-05-02T18:30:00Z',
    duration_ms: 30 * 60 * 1000,
  },
];

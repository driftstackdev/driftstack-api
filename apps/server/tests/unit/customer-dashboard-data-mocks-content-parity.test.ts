// W463.B — drift guard for apps/customer-dashboard/src/data/mocks.ts.
// Mock fixtures for customer-dashboard scaffolding. Drift here
// either swaps the tier on MOCK_ACCOUNT/MOCK_SUBSCRIPTION away from
// 'api_builder' (concurrent-limit assertion in MOCK_USAGE_SUMMARY
// breaks since it pulls from TIER_CONCURRENT_SESSION_LIMITS.
// api_builder by KEY) or breaks the api-types imports (dashboard
// scaffolding pages fail to typecheck on `astro build`).
//
//   • Mock-data scaffolding framing pinned + 'Swap to live API
//     reads (/v1/billing, /v1/profiles, /v1/api-keys, /v1/sessions,
//     /v1/usage) once the dashboard moves past scaffolding into a
//     wired state — gated on the customer-dashboard-stack proposal
//     in docs/architecture/customer-dashboard-stack.md.'
//   • 5 api-types imports: TIER_CONCURRENT_SESSION_LIMITS value +
//     AccountTier, Profile, Subscription, TrialPackState types.
//   • MockAccount 6-field + MOCK_ACCOUNT seeded with tier:'api_builder'.
//   • MOCK_SUBSCRIPTION Subscription with tier='api_builder' +
//     status='active' + cancel_at_period_end=false.
//   • MOCK_TRIAL_PACK_STATE: active=false + redeemed=true (post-trial
//     state matching the scaffolded subscription).
//   • MOCK_PROFILES: 2 entries with archetype
//     'iphone16pro_ios18_7_safari26_4'.
//   • MockApiKey scopes 4-value union ('read'|'write'|'admin'|
//     'gui_control') + MOCK_API_KEYS single production entry with
//     ['read','write'] scopes + 'ds_live_' prefix format.
//   • MockUsageSummary + MOCK_USAGE_SUMMARY 5-totals shape
//     (session_minute + navigate + interact + state_capture +
//     screenshot_capture) + concurrent_limit pulled from
//     TIER_CONCURRENT_SESSION_LIMITS.api_builder by KEY.
//   • MockSession 7-field with 5-value status union
//     ('creating'|'ready'|'busy'|'destroyed'|'errored') +
//     MOCK_SESSIONS 2 entries + duration_ms 30*60*1000 = 30 min.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/data/mocks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W463.B apps/customer-dashboard/src/data/mocks.ts content parity', () => {
  const body = read(LIB);

  it("Mock-data scaffolding framing pinned: 'Mock data for customer-dashboard scaffolding. Swap to live API reads (/v1/billing, /v1/profiles, /v1/api-keys, /v1/sessions, /v1/usage) once the dashboard moves past scaffolding into a wired state — gated on the customer-dashboard-stack proposal in docs/architecture/customer-dashboard-stack.md.'", () => {
    expect(body).toMatch(
      /\/\/ Mock data for customer-dashboard scaffolding\. Swap to live API\s*\n?\s*\/\/ reads \(`\/v1\/billing`, `\/v1\/profiles`, `\/v1\/api-keys`, `\/v1\/sessions`,\s*\n?\s*\/\/ `\/v1\/usage`\) once the dashboard moves past scaffolding into a wired\s*\n?\s*\/\/ state — gated on the customer-dashboard-stack proposal in\s*\n?\s*\/\/ docs\/architecture\/customer-dashboard-stack\.md\./,
    );
  });

  it('5 api-types imports: TIER_CONCURRENT_SESSION_LIMITS value + AccountTier + Profile + Subscription + TrialPackState types via single combined import block', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*TIER_CONCURRENT_SESSION_LIMITS,\s*\n?\s*type AccountTier,\s*\n?\s*type Profile,\s*\n?\s*type Subscription,\s*\n?\s*type TrialPackState,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
  });

  it("MockAccount 6-field interface + MOCK_ACCOUNT seeded with tier:'api_builder' + email 'tester@driftstack.local' + emailVerifiedAt set", () => {
    expect(body).toMatch(
      /export interface MockAccount \{\s*\n?\s*id: string;\s*\n?\s*email: string;\s*\n?\s*name: string \| null;\s*\n?\s*tier: AccountTier;\s*\n?\s*emailVerifiedAt: string \| null;\s*\n?\s*createdAt: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export const MOCK_ACCOUNT: MockAccount = \{\s*\n?\s*id: 'acc_00000000-0000-4000-8000-000000000001',\s*\n?\s*email: 'tester@driftstack\.local',\s*\n?\s*name: 'Tester',\s*\n?\s*tier: 'api_builder',\s*\n?\s*emailVerifiedAt: '2026-04-15T09:00:00Z',\s*\n?\s*createdAt: '2026-04-15T08:55:00Z',\s*\n?\s*\};/,
    );
  });

  it("MOCK_SUBSCRIPTION Subscription | null typed as non-null mock: tier='api_builder' + status='active' + cancel_at_period_end=false + canceled_at=null", () => {
    expect(body).toMatch(
      /export const MOCK_SUBSCRIPTION: Subscription \| null = \{\s*\n?\s*tier: 'api_builder',\s*\n?\s*status: 'active',\s*\n?\s*stripe_subscription_id: 'sub_test_dashboard_mock',\s*\n?\s*current_period_end: '2026-06-15T08:55:00Z',\s*\n?\s*cancel_at_period_end: false,\s*\n?\s*canceled_at: null,/,
    );
  });

  it('MOCK_TRIAL_PACK_STATE: post-trial state with active=false + credit_cents_remaining=null + expires_at=null + redeemed=true', () => {
    expect(body).toMatch(
      /export const MOCK_TRIAL_PACK_STATE: TrialPackState = \{\s*\n?\s*active: false,\s*\n?\s*credit_cents_remaining: null,\s*\n?\s*expires_at: null,\s*\n?\s*redeemed: true,\s*\n?\s*\};/,
    );
  });

  it("MOCK_PROFILES: 2 Profile entries with archetype 'iphone16pro_ios18_7_safari26_4' for both + names 'work-laptop' + 'staging-tester'", () => {
    expect(body).toMatch(/export const MOCK_PROFILES: Profile\[\] = \[/);
    expect(body).toMatch(
      /name: 'work-laptop',\s*\n?\s*archetype: 'iphone16pro_ios18_7_safari26_4',/,
    );
    expect(body).toMatch(
      /name: 'staging-tester',\s*\n?\s*archetype: 'iphone16pro_ios18_7_safari26_4',/,
    );
  });

  it("MockApiKey scopes 4-value union ('read'|'write'|'admin'|'gui_control') + MOCK_API_KEYS single production entry with ['read','write'] scopes + 'ds_live_' prefix format", () => {
    expect(body).toMatch(/scopes: ReadonlyArray<'read' \| 'write' \| 'admin' \| 'gui_control'>;/);
    expect(body).toMatch(
      /name: 'production',\s*\n?\s*key_prefix: 'ds_live_a1b2c3d4',\s*\n?\s*scopes: \['read', 'write'\],/,
    );
  });

  it('MockUsageSummary + MOCK_USAGE_SUMMARY 5-totals shape (session_minute + navigate + interact + state_capture + screenshot_capture) + concurrent_limit pulled from TIER_CONCURRENT_SESSION_LIMITS.api_builder by KEY (not hardcoded number)', () => {
    expect(body).toMatch(
      /totals: \{\s*\n?\s*session_minute: number;\s*\n?\s*navigate: number;\s*\n?\s*interact: number;\s*\n?\s*state_capture: number;\s*\n?\s*screenshot_capture: number;\s*\n?\s*\};\s*\n?\s*concurrent_now: number;\s*\n?\s*concurrent_limit: number;/,
    );
    expect(body).toMatch(/concurrent_limit: TIER_CONCURRENT_SESSION_LIMITS\.api_builder,/);
  });

  it("MockSession 7-field with 5-value status union ('creating'|'ready'|'busy'|'destroyed'|'errored') + MOCK_SESSIONS 2 entries (ready + destroyed) + duration_ms 30 * 60 * 1000 (30 min) on the destroyed entry", () => {
    expect(body).toMatch(/status: 'creating' \| 'ready' \| 'busy' \| 'destroyed' \| 'errored';/);
    expect(body).toMatch(/duration_ms: 30 \* 60 \* 1000,/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

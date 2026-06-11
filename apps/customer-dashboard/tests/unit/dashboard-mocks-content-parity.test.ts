// W383.B — drift guard for customer-dashboard src/data/mocks.ts.
// The dashboard scaffolding renders every page from this mocks
// file pre-wiring. Drift in mock shapes desyncs the rendered UI
// from the future live /v1/* contracts. Pins the load-bearing
// fixture shapes:
//
//   • Pre-wiring framing pinned (swap to live /v1/billing /
//     /v1/profiles / /v1/api-keys / /v1/sessions / /v1/usage on
//     scaffolding exit).
//   • Imports from @driftstack/api-types: AccountTier + Profile +
//     Subscription + TIER_CONCURRENT_SESSION_LIMITS. (TrialPackState
//     was dropped 2026-05-27 — the type no longer exists in
//     @driftstack/api-types after the one-time trial pack was
//     replaced by the perpetual free tier.)
//   • MockAccount (id, email, name, tier, emailVerifiedAt, createdAt).
//   • MOCK_ACCOUNT fixture: api_builder tier, email-verified.
//   • MOCK_SUBSCRIPTION fixture: api_builder/active/no-cancel.
//   • MOCK_PROFILES: 2 profiles, archetype iphone17_ios18_7_safari26_4.
//   • MockApiKey: 4 scope literals (read/write/admin/gui_control).
//   • MOCK_USAGE_SUMMARY: 5 usage totals (session_minute / navigate
//     / interact / state_capture / screenshot_capture).
//   • MOCK_SESSIONS: 2 sessions with ready / destroyed statuses.
//   • SessionStatus union: creating / ready / busy / destroyed /
//     errored.
//   • concurrent_limit derived from TIER_CONCURRENT_SESSION_LIMITS
//     (single source of truth — no hardcoded number).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MOCKS = resolve(REPO_ROOT, 'apps/customer-dashboard/src/data/mocks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W383.B customer-dashboard src/data/mocks.ts content parity', () => {
  const body = read(MOCKS);

  it('pre-wiring framing pinned (mock-data for scaffolding, swap to live /v1/* later)', () => {
    expect(body).toMatch(
      /Mock data for customer-dashboard scaffolding\. Swap to live API\s*\n?\s*\/\/\s*reads/,
    );
    expect(body).toMatch(
      /`\/v1\/billing`, `\/v1\/profiles`, `\/v1\/api-keys`, `\/v1\/sessions`,\s*\n?\s*\/\/\s*`\/v1\/usage`/,
    );
    expect(body).toMatch(
      /customer-dashboard-stack proposal in\s*\n?\s*\/\/\s*docs\/architecture\/customer-dashboard-stack\.md/,
    );
  });

  it('imports 4 symbols from @driftstack/api-types (TIER_CONCURRENT_SESSION_LIMITS + 3 types)', () => {
    expect(body).toMatch(
      /import \{[\s\S]+?TIER_CONCURRENT_SESSION_LIMITS,[\s\S]+?type AccountTier,[\s\S]+?type Profile,[\s\S]+?type Subscription,[\s\S]+?\} from '@driftstack\/api-types';/,
    );
    // TrialPackState was removed from @driftstack/api-types.
    expect(body).not.toContain('TrialPackState');
  });

  it('MockAccount interface: 6 fields (id, email, name, tier, emailVerifiedAt, createdAt)', () => {
    expect(body).toMatch(/export interface MockAccount \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/email: string;/);
    expect(body).toMatch(/name: string \| null;/);
    expect(body).toMatch(/tier: AccountTier;/);
    expect(body).toMatch(/emailVerifiedAt: string \| null;/);
    expect(body).toMatch(/createdAt: string;/);
  });

  it('MOCK_ACCOUNT fixture: api_builder tier + email-verified + Tester name', () => {
    expect(body).toMatch(/tier: 'api_builder',/);
    expect(body).toMatch(/email: 'tester@driftstack\.local',/);
    expect(body).toMatch(/name: 'Tester',/);
    expect(body).toMatch(/emailVerifiedAt: '2026-04-15T09:00:00Z',/);
  });

  it('MOCK_SUBSCRIPTION fixture: api_builder/active/no-cancel/test stripe id', () => {
    expect(body).toMatch(
      /export const MOCK_SUBSCRIPTION: Subscription \| null = \{\s*\n?\s*tier: 'api_builder',\s*\n?\s*status: 'active',/,
    );
    expect(body).toMatch(/stripe_subscription_id: 'sub_test_dashboard_mock',/);
    expect(body).toMatch(/cancel_at_period_end: false,/);
    expect(body).toMatch(/canceled_at: null,/);
  });

  it('no MOCK_TRIAL_PACK_STATE fixture (trial pack removed 2026-05-27)', () => {
    expect(body).not.toContain('MOCK_TRIAL_PACK_STATE');
  });

  it('MOCK_PROFILES: 2 profiles with iphone17_ios18_7_safari26_4 archetype', () => {
    expect(body).toMatch(/name: 'work-laptop',/);
    expect(body).toMatch(/name: 'staging-tester',/);
    const archetypeMatches = body.match(/archetype: 'iphone17_ios18_7_safari26_4'/g);
    expect(archetypeMatches).not.toBeNull();
    expect(archetypeMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it('MockApiKey scopes union: 4 literals (read / write / admin / gui_control)', () => {
    expect(body).toMatch(/scopes: ReadonlyArray<'read' \| 'write' \| 'admin' \| 'gui_control'>;/);
  });

  it('MOCK_API_KEYS fixture: production key with ds_live_ prefix + read+write scopes', () => {
    expect(body).toMatch(/name: 'production',/);
    expect(body).toMatch(/key_prefix: 'ds_live_a1b2c3d4',/);
    expect(body).toMatch(/scopes: \['read', 'write'\],/);
  });

  it('MockUsageSummary totals: 5 keys (session_minute / navigate / interact / state_capture / screenshot_capture)', () => {
    expect(body).toMatch(/session_minute: number;/);
    expect(body).toMatch(/navigate: number;/);
    expect(body).toMatch(/interact: number;/);
    expect(body).toMatch(/state_capture: number;/);
    expect(body).toMatch(/screenshot_capture: number;/);
  });

  it('MOCK_USAGE_SUMMARY: api_builder tier + concurrent_limit derived from TIER_CONCURRENT_SESSION_LIMITS (no hardcoded number)', () => {
    expect(body).toMatch(/concurrent_limit: TIER_CONCURRENT_SESSION_LIMITS\.api_builder,/);
    expect(body).toMatch(/concurrent_now: 2,/);
    expect(body).toMatch(/period_start: '2026-05-01T00:00:00Z',/);
    expect(body).toMatch(/period_end: '2026-05-31T23:59:59Z',/);
  });

  it('MockSession status union: 5 literals (creating / ready / busy / destroyed / errored)', () => {
    expect(body).toMatch(/status: 'creating' \| 'ready' \| 'busy' \| 'destroyed' \| 'errored';/);
  });

  it('MOCK_SESSIONS: 2 fixtures (ready + destroyed-with-30min-duration_ms)', () => {
    expect(body).toMatch(/status: 'ready',[\s\S]+?destroyed_at: null,[\s\S]+?duration_ms: null,/);
    expect(body).toMatch(/status: 'destroyed',[\s\S]+?duration_ms: 30 \* 60 \* 1000,/);
  });

  it('@driftstack/api-types package exists (canonical source)', () => {
    expect(existsSync(resolve(REPO_ROOT, 'packages/api-types/package.json'))).toBe(true);
  });

  it('TIER_DISPLAY_NAMES: canonical id→human-label map (all 8 tiers; Manual ladder = Personal/Team/Agency)', () => {
    // Single source of truth so overview + billing show "Personal" not
    // the raw "solo_manual". Pin the renamed Manual-ladder labels so they
    // can't silently drift back to the ids or the old names.
    expect(body).toMatch(/export const TIER_DISPLAY_NAMES: Record<AccountTier, string> = \{/);
    expect(body).toMatch(/solo_manual: 'Personal'/);
    expect(body).toMatch(/team_manual: 'Team'/);
    expect(body).toMatch(/agency_manual: 'Agency'/);
    expect(body).toMatch(/free: 'Free'/);
    expect(body).toMatch(/enterprise: 'Enterprise'/);
  });
});

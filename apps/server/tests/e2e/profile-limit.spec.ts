// E2E profile-count limits — placeholder for the per-tier profile cap
// enforcement that lands at the /v1/profiles route in a future
// Workstream. PROFILES_PER_TIER + profileLimitFor() helper landed in
// V-073 as the data-layer surface; this test exercises the helper
// directly until the route exists, then converts to a real HTTP test
// (create N profiles → N+1 fails with 429 + the tier-limit problem type;
// V-814 corrected this from 402 + a profile-cap-reached body, neither of
// which the server has ever produced).
//
// ⛔ 2026-08-26 — THE ROUTE LANDED, AND THE CONVERSION THIS DESCRIBES IS ALREADY
// DONE ELSEWHERE. `POST /v1/profiles` is registered in `routes/profiles.ts`, and
// the cap it applies is enforced under a lock rather than by the count-then-insert
// this header anticipated. Following the instruction above would rebuild coverage
// that exists:
//
//   • `db-profile-cap-lock-is-taken-drizzle` — insertWithLimit BLOCKS while another
//     session holds the account row lock, against real Postgres. That is the
//     property an HTTP-level "create N, then N+1" test cannot observe, because the
//     count-to-insert window is too narrow to hit by racing requests.
//   • `db-profiles-repo-keyset-drizzle` — the same cap under real concurrency.
//   • `every-tier-cap-has-an-atomic-backstop` — that every tier-limit helper is
//     paired with a conditional-insert method, derived rather than listed.
//
// What stays worth having HERE is exactly what is below: the published per-tier
// NUMBERS. Those are a contract with the pricing page, they are cheap to assert,
// and no locking test pins them. So this file is not a placeholder — it is the
// value half of a cap whose enforcement half lives against a real database.
//
// ⚠️ It makes no HTTP call, which is why it reads as unfinished. Left in the e2e
// project because moving it would change nothing about what it proves.
//
// Per ADR-004 + V-073:
//   free:    1
//   solo_manual:   10
//   team_manual:   50
//   agency_manual: 200
//   api_starter:   25
//   api_builder:   100
//   api_scale:     500
//   enterprise:    null (unlimited via per-account override)

import { test, expect } from '@playwright/test';
import type { AccountTier } from '@driftstack/api-types';
import { profileLimitFor } from '../../src/services/sessions.js';

interface TierProfileCap {
  tier: AccountTier;
  expected: number | null;
}

const PROFILE_CAPS: TierProfileCap[] = [
  { tier: 'free', expected: 1 },
  { tier: 'solo_manual', expected: 10 },
  { tier: 'team_manual', expected: 50 },
  { tier: 'agency_manual', expected: 200 },
  { tier: 'api_starter', expected: 25 },
  { tier: 'api_builder', expected: 100 },
  { tier: 'api_scale', expected: 500 },
  { tier: 'enterprise', expected: null },
];

test.describe('profileLimitFor (placeholder until /v1/profiles route lands)', () => {
  for (const { tier, expected } of PROFILE_CAPS) {
    test(`tier=${tier}: limit is ${expected === null ? 'unlimited (null)' : expected.toString()}`, () => {
      expect(profileLimitFor(tier)).toBe(expected);
    });
  }

  test('Manual ladder limits scale monotonically', () => {
    const ladder: AccountTier[] = ['solo_manual', 'team_manual', 'agency_manual'];
    const limits = ladder.map((t) => profileLimitFor(t));
    expect(limits).toEqual([10, 50, 200]);
    for (let i = 1; i < limits.length; i++) {
      expect(limits[i]).toBeGreaterThan(limits[i - 1] as number);
    }
  });

  test('API ladder limits scale monotonically (excluding null Enterprise)', () => {
    const ladder: AccountTier[] = ['api_starter', 'api_builder', 'api_scale'];
    const limits = ladder.map((t) => profileLimitFor(t)) as number[];
    expect(limits).toEqual([25, 100, 500]);
    for (let i = 1; i < limits.length; i++) {
      expect(limits[i]).toBeGreaterThan(limits[i - 1] as number);
    }
  });

  test('enterprise is unlimited (null sentinel)', () => {
    expect(profileLimitFor('enterprise')).toBeNull();
  });
});

// TODO (Workstream F or Manual-tier-specific Workstream): when /v1/profiles
// route lands, replace these unit-style assertions with real HTTP tests:
//   - POST /v1/profiles N times for tier with limit N → all 201
//   - POST /v1/profiles N+1th time → 429 with the tier-limit problem type +
//     upgrade link
//   - DELETE /v1/profiles/{id} frees a slot; next POST 201
//   - Enterprise account → unlimited (no tier-limit error at any count;
//     bound by per-account override only)

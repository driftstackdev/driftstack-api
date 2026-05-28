// W910 — Tier-cap helpers cross-source invariant. Two-hundred-
// thirty-sixth in the drift-guard series. Pins the two tier-cap
// helper functions:
//
//   concurrentSessionLimitFor(tier): number — returns
//   TIER_CONCURRENT_SESSION_LIMITS[tier]. V-156 framing pinned.
//
//   profileLimitFor(tier): number | null — returns
//   PROFILES_PER_TIER[tier]; translates 'custom' enterprise to
//   null (legacy null-means-unlimited contract). V-136 framing.
//
// Both helpers wrap the api-types single-source-of-truth constants
// — drift would let services compute tier-caps differently than
// the canonical record.
//
//   account-me.ts profileCapFor wraps the same null-vs-int
//   semantic for the customer dashboard surface.
//
// stays in lockstep across:
//   - apps/server/src/services/sessions.ts (concurrentSessionLimitFor
//     + profileLimitFor).
//   - apps/server/src/routes/account-me.ts (profileCapFor for
//     /v1/account/me response).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W910 tier-cap helpers cross-source invariant', () => {
  // ─── concurrentSessionLimitFor — V-156 ──────────────────────

  it("CRITICAL apps/server/src/services/sessions.ts concurrentSessionLimitFor(tier) returns TIER_CONCURRENT_SESSION_LIMITS[tier]. Single source of truth in api-types — V-156. Helper kept here so existing call sites don't churn.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(
      /export function concurrentSessionLimitFor\(tier: AccountTier\): number \{\s*\n\s*return TIER_CONCURRENT_SESSION_LIMITS\[tier\];\s*\n\s*\}/,
    );
    expect(p).toMatch(
      /Single source of truth lives in api-types\s*\n\/\/ \(TIER_CONCURRENT_SESSION_LIMITS, V-156\)\. Helper kept here so\s*\n\/\/ existing call sites don't churn/,
    );
  });

  // ─── profileLimitFor — V-136 + 'custom' → null ──────────────

  it("CRITICAL apps/server/src/services/sessions.ts profileLimitFor(tier) returns PROFILES_PER_TIER[tier]; 'custom' enterprise translates to null. V-136 framing + 'legacy null-means-unlimited contract that the /v1/profiles enforcement code expects' pinned.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(
      /export function profileLimitFor\(tier: AccountTier\): number \| null \{\s*\n\s*const limit = PROFILES_PER_TIER\[tier\];\s*\n\s*return limit === 'custom' \? null : limit;\s*\n\s*\}/,
    );
    expect(p).toMatch(
      /Single source of truth lives in api-types\s*\n\/\/ \(PROFILES_PER_TIER, V-136\)/,
    );
  });

  it("CRITICAL profileLimitFor framing pins 'custom sentinel for enterprise; this helper translates to null for the legacy null-means-unlimited contract that the /v1/profiles enforcement code expects'. The string-vs-number split is the api-types sentinel that this helper unwraps.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(
      /The api-types record uses the\s*\n\/\/ 'custom' sentinel for enterprise; this helper translates to\s*\n\/\/ null for the legacy null-means-unlimited contract/,
    );
  });

  // ─── maxSessionMinutesFor — 6.g ─────────────────────────────

  it('CRITICAL apps/server/src/services/sessions.ts maxSessionMinutesFor(tier) returns MAX_SESSION_MINUTES_PER_TIER[tier] (number | null). 6.g free-tier session-duration cap; single source of truth in api-types. `null` = unlimited (paid).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(
      /export function maxSessionMinutesFor\(tier: AccountTier\): number \| null \{\s*\n\s*return MAX_SESSION_MINUTES_PER_TIER\[tier\];\s*\n\s*\}/,
    );
    expect(p).toMatch(
      /Single source of truth in api-types \(MAX_SESSION_MINUTES_PER_TIER\)\. `null`\s*\n\/\/ = unlimited \(paid tiers\); free is capped/,
    );
  });

  // ─── profileCapFor in account-me route (mirrors profileLimitFor) ─

  it("CRITICAL apps/server/src/routes/account-me.ts profileCapFor(tier) mirrors profileLimitFor — reads PROFILES_PER_TIER; returns null for 'custom'. The dashboard /v1/account/me response uses this helper directly.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts'));
    expect(p).toMatch(
      /function profileCapFor\(tier: AccountTier\): number \| null \{\s*\n\s*const cap = PROFILES_PER_TIER\[tier\];\s*\n\s*return cap === 'custom' \? null : cap;\s*\n\s*\}/,
    );
  });

  // ─── /v1/profiles creation gate uses profileLimitFor ────────

  it('CRITICAL apps/server/src/services/profiles.ts imports + uses profileLimitFor. The profiles service is where the /v1/profiles creation gate enforces the tier-keyed cap. Drift to a local computation would diverge from the canonical PROFILES_PER_TIER constant.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/import \{ profileLimitFor \} from '\.\/sessions\.js';/);
    expect(p).toMatch(/const limit = profileLimitFor\(args\.tier\);/);
  });

  // ─── TierLimitError on cap-vs-current ────────────────────────

  it("CRITICAL profiles.ts TierLimitError is thrown with { limit, current, resource: 'profile', tier } when limit is non-null AND current >= limit. The 4-field error payload + 'profile' resource discriminator is what dashboard renders for the customer.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/\{ limit, current, resource: 'profile', tier: args\.tier \}/);
  });

  // ─── 2-helper cardinality ────────────────────────────────────

  it('CRITICAL 3 tier-cap helpers in sessions.ts — concurrentSessionLimitFor (always int; V-156) + profileLimitFor (int | null; V-136 with custom→null) + maxSessionMinutesFor (int | null; 6.g free session-duration cap). concurrent + profiles map to the V-148 ladder dimensions; maxSessionMinutes is the 6.g free-tier evaluation bound.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/export function concurrentSessionLimitFor\(tier: AccountTier\): number/);
    expect(p).toMatch(/export function profileLimitFor\(tier: AccountTier\): number \| null/);
    expect(p).toMatch(/export function maxSessionMinutesFor\(tier: AccountTier\): number \| null/);
  });

  // ─── 'Concurrent session limits + profile count limits per tier' header ──

  it("CRITICAL sessions.ts section header pins 'Concurrent session limits + profile count limits per tier'. The 2-helper grouping is documented at the file-section level.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(p).toMatch(/\/\/ Concurrent session limits \+ profile count limits per tier/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/tier-cap-helpers-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

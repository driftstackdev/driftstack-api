// W308.C — drift guard for /sessions page concurrent-cap narrative.
// The page is the customer's primary view of their live concurrent
// usage. The narrative must say:
//   • sessions are the only billing meter
//   • the cap comes from the tier
//   • hitting it returns 429 with a retry-after hint
// Also pins the page to import TIER_CONCURRENT_SESSION_LIMITS from
// the canonical @driftstack/api-types module (rather than a hardcoded
// local copy that could drift).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/sessions.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W308.C /sessions concurrent-cap narrative parity', () => {
  const body = read(PAGE);

  it('imports TIER_CONCURRENT_SESSION_LIMITS from @driftstack/api-types', () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?TIER_CONCURRENT_SESSION_LIMITS[\s\S]*?\}\s+from\s+['"]@driftstack\/api-types['"]/,
    );
  });

  it('positions sessions as the only billing meter', () => {
    expect(body).toMatch(/only billing meter/i);
  });

  it('mentions 429 + retry-after when the cap is hit', () => {
    expect(body).toMatch(/429/);
    expect(body).toMatch(/retry[- ]after/i);
  });

  it('TIER_CONCURRENT_SESSION_LIMITS has all api tiers + enterprise (sanity vs source-of-truth)', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS).toMatchObject({
      api_starter: expect.any(Number),
      api_builder: expect.any(Number),
      api_scale: expect.any(Number),
      enterprise: expect.any(Number),
    });
  });

  it('caps grow monotonically across api tiers (sanity guard)', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS.api_builder).toBeGreaterThan(
      TIER_CONCURRENT_SESSION_LIMITS.api_starter,
    );
    expect(TIER_CONCURRENT_SESSION_LIMITS.api_scale).toBeGreaterThan(
      TIER_CONCURRENT_SESSION_LIMITS.api_builder,
    );
    expect(TIER_CONCURRENT_SESSION_LIMITS.enterprise).toBeGreaterThanOrEqual(
      TIER_CONCURRENT_SESSION_LIMITS.api_scale,
    );
  });
});

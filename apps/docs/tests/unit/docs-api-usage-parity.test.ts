// W253.C — drift-guard for docs.driftstack.io/api/usage. The
// previous revision had a tier table with Agency 10 / API Builder 5
// / API Scale 20 concurrent + Solo 5 / Builder 25 / Scale 100
// profile caps that didn't match the canonical constants. Pin both
// columns to the source-of-truth.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AccountTierSchema,
  PROFILES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/usage.md');

function read(): string {
  return readFileSync(DOC, 'utf8');
}

describe('W253.C docs/api/usage ↔ tier-constants parity', () => {
  const doc = read();
  const tiers = (AccountTierSchema._def.values as readonly string[]).slice();

  it('every concurrent-session column matches TIER_CONCURRENT_SESSION_LIMITS', () => {
    for (const t of tiers) {
      const cap = TIER_CONCURRENT_SESSION_LIMITS[t as keyof typeof TIER_CONCURRENT_SESSION_LIMITS];
      // Row format: | `tier` | NN | ... — concurrent is column 2.
      const re = new RegExp(`\`${t}\`\\s*\\|\\s*${cap.toString()}\\s*\\|`);
      expect(doc, `concurrent mismatch for ${t}`).toMatch(re);
    }
  });

  it('every profile-cap column matches PROFILES_PER_TIER (or "custom")', () => {
    for (const t of tiers) {
      const cap = PROFILES_PER_TIER[t as keyof typeof PROFILES_PER_TIER];
      const expected = cap === 'custom' ? 'custom' : cap.toString();
      // Row format: | `tier` | concurrent | profile | ... — profile is column 3.
      const re = new RegExp(`\`${t}\`\\s*\\|[^|]+\\|\\s*${expected}\\s*\\|`);
      expect(doc, `profile-cap mismatch for ${t} (expect ${expected})`).toMatch(re);
    }
  });

  it('does NOT advertise quota.* overage webhooks (2026-06-24, ADR-004)', () => {
    // Per ADR-004 (services/usage.ts retired hours metering — every
    // TIER_QUOTAS value is null), there is no per-meter cap and no
    // overage enforcement, so the usage doc must not claim quota-warning
    // webhooks fire on a session-minute cap (the previous revision did).
    expect(doc).not.toMatch(/quota\.warning_80pct/);
    expect(doc).not.toMatch(/quota\.exceeded/);
    expect(doc).not.toMatch(/Stripe overage billing/);
  });
});

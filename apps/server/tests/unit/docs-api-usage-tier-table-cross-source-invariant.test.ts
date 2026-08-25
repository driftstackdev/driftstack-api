// Cross-source invariant: docs/api/usage.md tier table CAP column
// MUST match TIER_CONCURRENT_SESSION_LIMITS + PROFILES_PER_TIER for
// every tier. Drift between docs + the @driftstack/api-types consts
// would silently over/under-promise quota caps to customers reading
// the API docs.

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

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/api/usage tier-table cross-source invariant', () => {
  const doc = read(DOC);
  const tiers = (AccountTierSchema._def.values as readonly string[]).slice();

  it('docs/api/usage tier-table lists every AccountTier from the schema', () => {
    for (const tier of tiers) {
      expect(doc).toMatch(new RegExp(`\\| \`${tier}\``));
    }
  });

  it('docs/api/usage tier-table concurrent-session column matches TIER_CONCURRENT_SESSION_LIMITS for every tier', () => {
    for (const tier of tiers) {
      const cap =
        TIER_CONCURRENT_SESSION_LIMITS[tier as keyof typeof TIER_CONCURRENT_SESSION_LIMITS];
      // Row format: | `tier` | NN | profiles | minutes |
      const re = new RegExp(`\\| \`${tier}\`\\s+\\|\\s+${cap.toString()}\\s+\\|`);
      expect(doc).toMatch(re);
    }
  });

  it('docs/api/usage tier-table profiles column matches PROFILES_PER_TIER for every tier', () => {
    for (const tier of tiers) {
      const profiles = PROFILES_PER_TIER[tier as keyof typeof PROFILES_PER_TIER];
      // Row format: | `tier` | NN | profiles | minutes |
      const profilesStr = profiles === 'custom' ? 'custom' : profiles.toString();
      const re = new RegExp(`\\| \`${tier}\`\\s+\\|\\s+\\d+\\s+\\|\\s+${profilesStr}\\s+\\|`);
      expect(doc).toMatch(re);
    }
  });

  it("docs/api/usage points operator at the canonical-source: 'driven by TIER_CONCURRENT_SESSION_LIMITS and PROFILES_PER_TIER in @driftstack/api-types' — pinned so the source-of-truth cross-reference stays documented (drift on the const-name would orphan the docs from the actual table)", () => {
    expect(doc).toMatch(
      /`TIER_CONCURRENT_SESSION_LIMITS`\s*and `PROFILES_PER_TIER` in `@driftstack\/api-types`/,
    );
  });
});

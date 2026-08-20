// W329.A — drift guard for /reference/rate-limits page. Pins:
//   • every bucket key the limiter defines (V-1091: was "two bucket keys
//     (global, sessions:create)" long after four were enforced)
//   • all 8 AccountTier slugs appear in the per-tier table
//   • RFC 7807 framing + rate-limited problem-type URI
//   • Retry-After header is cited

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema, PROBLEM_TYPES, TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/rate-limits.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W329.A /reference/rate-limits baseline', () => {
  const body = read(PAGE);

  it('declares every bucket key the limiter enforces', () => {
    const keys = Object.keys(
      TIER_RATE_LIMIT_DEFAULTS[
        Object.keys(TIER_RATE_LIMIT_DEFAULTS)[0] as keyof typeof TIER_RATE_LIMIT_DEFAULTS
      ],
    );
    expect(keys.length, 'bucket keys defined').toBeGreaterThanOrEqual(4);
    expect(
      keys.filter((k) => !body.includes(`\`${k}\``)),
      'bucket key(s) enforced but never named on the page:',
    ).toEqual([]);
  });

  for (const tier of AccountTierSchema.options) {
    it(`per-tier table lists ${tier}`, () => {
      expect(body).toContain(tier);
    });
  }

  it('cites the canonical rate-limited problem-type URI', () => {
    expect(body).toContain(PROBLEM_TYPES.RateLimited);
  });

  it('promises Retry-After header on 429', () => {
    expect(body).toMatch(/Retry-After/);
  });

  it('frames rate limits as anti-abuse, not pricing meter (ADR-004 consistency)', () => {
    expect(body).toMatch(/anti-abuse/i);
    expect(body).toMatch(/[Pp]ricing is concurrent-only/);
  });
});

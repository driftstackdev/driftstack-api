// W302.A — drift guard for /docs/concurrency table values. Each
// row in the tier-cap table must match TIER_CONCURRENT_SESSION_LIMITS
// from the live schema. Catches drift where a tier cap changes in
// the schema but the doc isn't updated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_CONCURRENT_SESSION_LIMITS, AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/concurrency.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W302.A /docs/concurrency ↔ TIER_CONCURRENT_SESSION_LIMITS parity', () => {
  const body = read(PAGE);

  it('page cites every AccountTier in the concurrency table', () => {
    const missing: string[] = [];
    for (const tier of AccountTierSchema.options) {
      if (!new RegExp(`<code>${tier}</code>`).test(body)) {
        missing.push(tier);
      }
    }
    expect(missing).toEqual([]);
  });

  it('each tier row carries the canonical concurrent limit', () => {
    const offenders: { tier: string; cap: number; cited: string | null }[] = [];
    for (const [tier, cap] of Object.entries(TIER_CONCURRENT_SESSION_LIMITS)) {
      // Look for a table row containing `<code>tier</code>` then a
      // numeric td. Be tolerant of whitespace.
      const re = new RegExp(`<code>${tier}</code>\\s*</td>\\s*<td>\\s*(\\d+)\\s*</td>`);
      const m = body.match(re);
      const cited = m ? Number(m[1]) : null;
      if (cited !== cap) {
        offenders.push({ tier, cap, cited: m?.[1] ?? null });
      }
    }
    expect(offenders).toEqual([]);
  });
});

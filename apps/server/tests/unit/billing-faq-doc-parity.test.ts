// W231.A — drift-guard for /docs/billing-faq.
//
// Pins:
//   - the free-tier concurrent-session cap (1, not 2)
//   - the API key prefix (`ds_live_`, no `ds_test_` namespace)
//   - the non-refundable crypto claim

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILES_PER_TIER, TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'billing-faq.astro');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W231.A billing-faq doc parity', () => {
  const doc = read(DOC_PATH);

  it('free-tier concurrent-session cap claim matches TIER_CONCURRENT_SESSION_LIMITS', () => {
    const freeConcurrent = TIER_CONCURRENT_SESSION_LIMITS.free;
    expect(freeConcurrent).toBe(1);
    expect(doc).toMatch(new RegExp(`<strong>${freeConcurrent} concurrent\\s+session`));
    // Rule out the stale "2 concurrent sessions" claim:
    expect(doc).not.toMatch(/2\s+concurrent sessions/);
  });

  it('free-tier profile cap matches PROFILES_PER_TIER', () => {
    expect(PROFILES_PER_TIER.free).toBe(1);
    expect(doc).toMatch(/<strong>1 profile<\/strong>/);
  });

  it('API key prefix claim is ds_live_, not the fictional ds_test_', () => {
    expect(doc).toMatch(/ds_live_/);
    // The ds_test_ prefix is mentioned only inside the explicit
    // disavowal phrase.
    const occurrences = doc.match(/ds_test_/g) ?? [];
    // One acceptable use: the doc explicitly says it doesn't exist.
    expect(occurrences.length).toBeLessThanOrEqual(1);
    if (occurrences.length === 1) {
      expect(doc).toMatch(/no separate\s+<code>ds_test_<\/code> namespace/i);
    }
  });

  it('crypto payments are flagged as non-refundable', () => {
    expect(doc).toMatch(/non-refundable/);
  });
});

// W231.A — drift-guard for /docs/billing-faq.
//
// Pins:
//   - the free-tier concurrent-session cap (1, not 2)
//   - the Free desktop (`ds_test_`) versus paid API (`ds_live_`) boundary
//   - the non-refundable crypto claim

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROFILES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
  TIER_FEATURES,
} from '@driftstack/api-types';

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

  it('documents the authoritative Free desktop and paid customer-key boundary', () => {
    expect(TIER_FEATURES.free.apiAccess).toBe(false);
    expect(doc).toMatch(/restricted\s+<code>ds_test_…<\/code> device credential/);
    expect(doc).toMatch(/<code>ds_live_…<\/code> customer API keys require a\s+paid tier/);
    expect(doc).toMatch(/not a\s+customer API key or a general sandbox key/);
    expect(doc).not.toMatch(/no separate\s+<code>ds_test_<\/code> namespace/i);
  });

  it('crypto payments are flagged as non-refundable', () => {
    expect(doc).toMatch(/non-refundable/);
  });
});

// W198 — drift guard between the customer-facing /docs/rate-limits
// page and the actual TIER_RATE_LIMIT_DEFAULTS table.
//
// Before this guard the doc listed fabricated bucket names
// (`sessions:start`, `sessions:read`, `profiles:write`) that don't
// exist in the rate-limit code, so customers reading the doc would
// build retry policies for buckets that never fire. This test reads
// the doc source + the live defaults and asserts that every bucket
// mentioned in the doc is one the rate limiter actually enforces.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES, TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = readFileSync(
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/rate-limits.astro'),
  'utf8',
);

// Pull the actual enforced bucket set from any one tier (they all
// share the same shape). `Object.keys()` is the canonical source of
// truth — if the rate-limit code adds a new bucket, this test sees
// it automatically.
const REAL_BUCKETS = new Set(Object.keys(TIER_RATE_LIMIT_DEFAULTS.solo_manual));

// Match every `name: 'X'` literal in the doc's BUCKETS array.
const BUCKET_NAME_RE = /name:\s*'([^']+)'/g;

describe('W198 rate-limits doc ↔ TIER_RATE_LIMIT_DEFAULTS parity', () => {
  it('every bucket name in the doc table is one the rate limiter actually enforces', () => {
    const docBuckets = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = BUCKET_NAME_RE.exec(DOC)) !== null) {
      docBuckets.add(m[1] as string);
    }
    expect(docBuckets.size, 'doc should declare at least one bucket').toBeGreaterThan(0);

    const fake = [...docBuckets].filter((b) => !REAL_BUCKETS.has(b));
    expect(
      fake,
      `Doc lists bucket name(s) the rate limiter doesn't enforce. ` +
        `Real buckets: ${[...REAL_BUCKETS].sort().join(', ')}. ` +
        `Fake: ${fake.join(', ')}`,
    ).toEqual([]);
  });

  // V-813 — the case above checks doc ⊆ enforced. That direction alone
  // catches a FABRICATED bucket and is structurally blind to a MISSING
  // one, which is the failure that actually happened: agent_sessions:
  // input_event was a live preHandler gate, published by GET /v1/account/
  // rate-limits, listed in the OpenAPI enum and named in the page's own
  // prose — and absent from the page's table, with this guard green the
  // whole time. A one-directional subset check reads like parity and is
  // half of one.
  it('V-813 CRITICAL every ENFORCED bucket appears in the doc table. The reverse of the case above, and the half that was missing: a bucket added to TIER_RATE_LIMIT_DEFAULTS and wired to a route is one customers can be 429ed by, so leaving it out of the table they size their clients against is the more damaging direction of the two.', () => {
    const docBuckets = new Set<string>();
    for (const m of DOC.matchAll(/name:\s*'([^']+)'/g)) docBuckets.add(m[1] as string);

    expect(REAL_BUCKETS.size, 'buckets read from the live defaults table').toBeGreaterThan(3);
    expect(docBuckets.size, 'bucket rows parsed out of the doc').toBeGreaterThan(3);

    const undocumented = [...REAL_BUCKETS].filter((b) => !docBuckets.has(b)).sort();
    expect(
      undocumented,
      `The rate limiter enforces bucket(s) the customer-facing table never mentions. ` +
        `Add a row to apps/marketing-site/src/pages/docs/rate-limits.astro with the ` +
        `capacity and refill for each. Undocumented: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  it('W201 — the 429 example references the real RateLimited problem-type URI', () => {
    // Customers parse `type` to dispatch on error class; if the doc
    // advertises a URI the server doesn't actually return, customer
    // retry logic breaks silently. Keep the doc in lockstep with
    // PROBLEM_TYPES.RateLimited.
    expect(DOC).toContain(PROBLEM_TYPES.RateLimited);
  });

  it('W201 — the 429 example carries Content-Type: application/problem+json', () => {
    // RFC 7807 media type. Older versions of this doc showed an
    // ad-hoc `{ "error": { ... } }` envelope under `application/json`
    // which doesn't match what the server returns.
    expect(DOC).toContain('application/problem+json');
  });
});

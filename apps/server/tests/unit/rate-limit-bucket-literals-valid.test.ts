// Drift-guard: every literal bucket key passed to `app.rateLimit('...')`
// must be a real bucket in TIER_RATE_LIMIT_DEFAULTS.
//
// Why this guard exists: the FastifyInstance.rateLimit decoration types
// its bucketKey param as plain `string` (apps/server/src/middleware/
// rate-limit.ts), so a typo'd literal — e.g. rateLimit('sessions.create')
// — type-checks fine. At runtime bucketConfigFor() silently falls back to
// the `global` bucket for any unknown key, so the route quietly gets the
// wrong (usually looser) limiter with no error. The V-219 cross-source
// test pins the bucket roster's *shape* in api-types; nothing validated
// the scattered call-site literals. This closes that gap.
//
// (The decoration param is intentionally left as `string` rather than a
// narrowed union — the inline TIER_RATE_LIMIT_DEFAULTS union is pinned
// verbatim as the V-219 closed roster by rate-limit-bucket-cross-source-
// invariant; this runtime scan is the call-site half of that invariant.)

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

// Valid bucket keys, derived from the source of truth (any tier carries
// the full closed roster).
const firstTier = Object.values(TIER_RATE_LIMIT_DEFAULTS)[0];
const VALID_BUCKETS = new Set<string>(firstTier ? Object.keys(firstTier) : []);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every (file, bucket) pair where `.rateLimit('<literal>')` is called. */
function bucketLiterals(): Array<{ file: string; bucket: string }> {
  const re = /\.rateLimit\('([a-z_:]+)'/g;
  const found: Array<{ file: string; bucket: string }> = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const bucket = m[1];
      if (bucket !== undefined) found.push({ file: file.replace(`${SRC}/`, ''), bucket });
    }
  }
  return found;
}

describe('rate-limit call-site bucket literals ↔ TIER_RATE_LIMIT_DEFAULTS', () => {
  const literals = bucketLiterals();

  it('derives the closed bucket roster from the source of truth (sanity)', () => {
    expect(VALID_BUCKETS.size).toBe(4);
    expect(VALID_BUCKETS.has('global')).toBe(true);
  });

  it('finds a healthy number of rateLimit() call sites (sanity)', () => {
    expect(literals.length).toBeGreaterThanOrEqual(5);
  });

  it('every rateLimit() bucket literal is a real TIER_RATE_LIMIT_DEFAULTS bucket', () => {
    const invalid = literals
      .filter((l) => !VALID_BUCKETS.has(l.bucket))
      .map((l) => `${l.file}: '${l.bucket}'`);
    expect(invalid, `invalid bucket literal(s): ${invalid.join('; ')}`).toEqual([]);
  });
});

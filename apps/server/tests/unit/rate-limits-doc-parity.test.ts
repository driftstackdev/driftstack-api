// W243.B — drift-guard for /docs/rate-limits. Previous revision
// asserted wrong concurrency caps (Team 5 / Agency 25 / API Starter
// 10 / API Builder 50 / API Scale 250 — all higher than what
// `TIER_CONCURRENT_SESSION_LIMITS` actually enforces) and claimed
// the concurrency-cap response was 409 Conflict (it's 429 with the
// `concurrency-limit` problem-type). This guard pins both.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROBLEM_TYPES,
  TIER_CONCURRENT_SESSION_LIMITS,
  TIER_RATE_LIMIT_DEFAULTS,
} from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'rate-limits.astro');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W243.B rate-limits doc parity', () => {
  const doc = read();

  it('does not invent concurrency caps that exceed live ceilings', () => {
    const max = Math.max(...Object.values(TIER_CONCURRENT_SESSION_LIMITS));
    // Forbidden literal caps from the prior revision — all higher than reality.
    expect(doc).not.toMatch(/Team:\s*5 concurrent/);
    expect(doc).not.toMatch(/Agency:\s*25 concurrent/);
    expect(doc).not.toMatch(/API Starter:\s*10 concurrent/);
    expect(doc).not.toMatch(/API Builder:\s*50 concurrent/);
    expect(doc).not.toMatch(/API Scale:\s*250 concurrent/);
    // Any explicit `N concurrent` mention should not exceed the live max.
    for (const m of doc.matchAll(/(\d+)\s+concurrent/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(max);
    }
  });

  it('cross-links to /docs/concurrency as the authoritative cap table', () => {
    expect(doc).toMatch(/\/docs\/concurrency/);
  });

  it('describes concurrency-cap exhaustion as 429 with concurrency-limit type, not 409', () => {
    expect(doc).not.toMatch(/concurrency cap returns 409/i);
    expect(doc).toMatch(/429/);
    expect(doc).toContain(PROBLEM_TYPES.ConcurrencyLimit);
  });

  it('V-813 every enforced bucket row carries the capacity TIER_RATE_LIMIT_DEFAULTS actually holds, matched ROW BY ROW. Two weaknesses fixed at once: this case checked only global and sessions:create, so the two buckets added later could print any number at all; and it searched the whole document for a bare "N burst" substring, which "360 burst" satisfies for a bucket whose real capacity is 60.', () => {
    const solo = TIER_RATE_LIMIT_DEFAULTS['solo_manual'];
    const builder = TIER_RATE_LIMIT_DEFAULTS['api_builder'];
    const keys = Object.keys(solo) as (keyof typeof solo)[];
    expect(keys.length, 'buckets read from the live defaults table').toBeGreaterThan(3);

    const arr = doc.match(/BUCKETS\s*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(arr.length, 'BUCKETS array parsed out of the page').toBeGreaterThan(200);

    const rows = new Map<string, { solo: string; builder: string }>();
    for (const m of arr.matchAll(
      /name:\s*'([^']+)'[\s\S]*?soloBurst:\s*'([^']+)'[\s\S]*?apiBuilderBurst:\s*'([^']+)'/g,
    )) {
      rows.set(m[1] as string, { solo: m[2] as string, builder: m[3] as string });
    }
    expect(rows.size, 'table rows parsed with all three fields').toBe(keys.length);

    for (const k of keys) {
      const row = rows.get(k);
      expect(row, `no table row for enforced bucket ${k}`).toBeDefined();
      expect(row?.solo, `solo_manual ${k} burst`).toBe(
        `${solo[k].capacity.toLocaleString()} burst`,
      );
      expect(row?.builder, `api_builder ${k} burst`).toBe(
        `${builder[k].capacity.toLocaleString()} burst`,
      );
    }
  });

  it('uses the canonical rate-limit problem-type URI', () => {
    expect(doc).toContain(PROBLEM_TYPES.RateLimited);
  });

  it('documents the x-ratelimit-* headers the server actually emits', () => {
    expect(doc).toMatch(/X-RateLimit-Limit/i);
    expect(doc).toMatch(/X-RateLimit-Remaining/i);
    expect(doc).toMatch(/X-RateLimit-Reset/i);
    expect(doc).toMatch(/X-RateLimit-Bucket/i);
  });
});

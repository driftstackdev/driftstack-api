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
    expect(doc).not.toMatch(/Team Manual:\s*5 concurrent/);
    expect(doc).not.toMatch(/Agency Manual:\s*25 concurrent/);
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

  it('rate-limit-bucket numbers line up with TIER_RATE_LIMIT_DEFAULTS', () => {
    // solo_manual / api_builder figures rendered in the table. Convert
    // refill/sec → req/min for the doc framing.
    const solo = TIER_RATE_LIMIT_DEFAULTS['solo_manual'];
    const builder = TIER_RATE_LIMIT_DEFAULTS['api_builder'];
    // Capacities (burst).
    expect(doc).toMatch(new RegExp(`${solo.global.capacity.toString()} burst`));
    expect(doc).toMatch(new RegExp(`${solo['sessions:create'].capacity.toString()} burst`));
    expect(doc).toMatch(new RegExp(`${builder.global.capacity.toLocaleString()} burst`));
    expect(doc).toMatch(new RegExp(`${builder['sessions:create'].capacity.toString()} burst`));
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

// W341.A — drift guard for /docs/rate-limits. The page hard-codes
// the burst + sustained columns for Personal and API Builder
// against the live TIER_RATE_LIMIT_DEFAULTS table. If somebody
// bumps the API Builder global capacity from 1,800 to 3,600 the
// page must follow.
//
// Math: schema stores capacity (burst) + refill_per_second; the
// page renders refill as "req/min" so we multiply by 60.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/rate-limits.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W341.A /docs/rate-limits ↔ TIER_RATE_LIMIT_DEFAULTS parity', () => {
  const body = read(PAGE);

  it('Personal global bucket: 120 burst / 120 req/min matches schema', () => {
    const cfg = TIER_RATE_LIMIT_DEFAULTS.solo_manual.global;
    expect(cfg.capacity).toBe(120);
    expect(Math.round(cfg.refill_per_second * 60)).toBe(120);
    expect(body).toContain("soloBurst: '120 burst'");
    expect(body).toContain("soloSustained: '120 req/min'");
  });

  it('API Builder global bucket: 1,800 burst / 1,800 req/min matches schema', () => {
    const cfg = TIER_RATE_LIMIT_DEFAULTS.api_builder.global;
    expect(cfg.capacity).toBe(1_800);
    expect(Math.round(cfg.refill_per_second * 60)).toBe(1_800);
    expect(body).toContain("apiBuilderBurst: '1,800 burst'");
    expect(body).toContain("apiBuilderSustained: '1,800 req/min'");
  });

  it('Personal sessions:create: 10 burst / 2 req/min matches schema', () => {
    const cfg = TIER_RATE_LIMIT_DEFAULTS.solo_manual['sessions:create'];
    expect(cfg.capacity).toBe(10);
    // 1/30 per second = 2 per minute.
    expect(Math.round(cfg.refill_per_second * 60)).toBe(2);
    expect(body).toMatch(/soloBurst:\s*'10 burst'/);
    expect(body).toMatch(/soloSustained:\s*'2 req\/min'/);
  });

  it('API Builder sessions:create: 60 burst / 60 req/min matches schema', () => {
    const cfg = TIER_RATE_LIMIT_DEFAULTS.api_builder['sessions:create'];
    expect(cfg.capacity).toBe(60);
    // 1 per second = 60 per minute.
    expect(Math.round(cfg.refill_per_second * 60)).toBe(60);
    expect(body).toMatch(/apiBuilderBurst:\s*'60 burst'/);
    expect(body).toMatch(/apiBuilderSustained:\s*'60 req\/min'/);
  });

  it('page enumerates exactly the three bucket keys (global + sessions:create + agent_sessions:message)', () => {
    // v2-#8 sub-slice 8.20 added agent_sessions:message as the 3rd
    // enforced bucket — isolated cap so LLM-driven message loops
    // can't drain the global cap.
    const bucketMatch = body.match(/BUCKETS\s*=\s*\[([\s\S]*?)\];/);
    expect(bucketMatch).not.toBeNull();
    const names = [...bucketMatch![1]!.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(names.sort()).toEqual(['agent_sessions:message', 'global', 'sessions:create']);
  });

  it('page declares the four canonical X-RateLimit-* response headers', () => {
    for (const h of [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-RateLimit-Bucket',
    ]) {
      expect(body).toContain(h);
    }
  });

  it('page documents the per-account (not per-key) bucket scoping', () => {
    expect(body).toMatch(/per account/);
    expect(body).toMatch(/not per API key/);
  });

  it('page frames 429 body as RFC 7807 application/problem\\+json with retry_after_seconds', () => {
    expect(body).toContain('RFC 7807');
    expect(body).toContain('application/problem+json');
    expect(body).toContain('retry_after_seconds');
  });
  // V-753 — this page claimed "Free uses the same bucket sizes as Solo Manual" while
  // every one of free's four buckets is smaller. It drifted precisely because nothing
  // pinned it: the assertions here covered only the Solo column. This is a CROSS-SOURCE
  // pin, not a text pin — it reads TIER_RATE_LIMIT_DEFAULTS.free and requires the page
  // to state those exact numbers, so a change on either side fails.
  it('V-753 the Free-tier bucket numbers on the page match TIER_RATE_LIMIT_DEFAULTS.free', () => {
    const body = readFileSync(PAGE, 'utf8');
    const free = TIER_RATE_LIMIT_DEFAULTS.free;

    // The false claim must not return.
    expect(body).not.toMatch(/Free uses the same bucket sizes as Solo/);
    expect(body).toMatch(/Free has its own, smaller buckets on every/);

    // Every free capacity the page quotes must be the real one.
    expect(body).toContain(`global
      ${String(free.global.capacity)} burst`);
    expect(body).toContain(`${String(free['sessions:create'].capacity)} burst / 1 per minute`);
    expect(body).toContain(
      `${String(free['agent_sessions:message'].capacity)} burst / 1 per 5 seconds`,
    );
    expect(body).toContain(`${String(free['agent_sessions:input_event'].capacity)}
      burst / 60 per second`);

    // And free must genuinely differ from solo on all four, or the prose is wrong again.
    const solo = TIER_RATE_LIMIT_DEFAULTS.solo_manual;
    for (const k of [
      'global',
      'sessions:create',
      'agent_sessions:message',
      'agent_sessions:input_event',
    ] as const) {
      expect(
        free[k].capacity,
        `free.${k} now equals solo_manual — if the tiers were unified, rewrite the page prose`,
      ).not.toBe(solo[k].capacity);
    }
  });
});

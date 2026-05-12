// W338.A — drift guard for the "What happened" cap claim on
// /quickstart. The page hard-codes "Trial pack: 1, API Starter: 2,
// API Builder: 8, API Scale: 24" inline in section 4. These must
// stay aligned with TIER_CONCURRENT_SESSION_LIMITS (the same
// constant the server reads at session-create time). If we ever
// raise the API Builder cap from 8 → 12 we should update the
// quickstart copy in the same change.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W338.A /quickstart tier-cap parity', () => {
  const body = read(PAGE);

  it('cites Trial pack cap (1) matching TIER_CONCURRENT_SESSION_LIMITS.trial_pack', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS.trial_pack).toBe(1);
    expect(body).toMatch(/Trial pack:\s*1\b/);
  });

  it('cites API Starter cap (2) matching TIER_CONCURRENT_SESSION_LIMITS.api_starter', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS.api_starter).toBe(2);
    expect(body).toMatch(/API Starter:\s*2\b/);
  });

  it('cites API Builder cap (8) matching TIER_CONCURRENT_SESSION_LIMITS.api_builder', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS.api_builder).toBe(8);
    expect(body).toMatch(/API Builder:\s*8\b/);
  });

  it('cites API Scale cap (24) matching TIER_CONCURRENT_SESSION_LIMITS.api_scale', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS.api_scale).toBe(24);
    expect(body).toMatch(/API Scale:\s*24\b/);
  });

  it('cites 429 as the failure mode when the cap is exceeded', () => {
    // Exceeded-cap behaviour is canonical — server returns 429,
    // not 400/403. Pin the doc so it stays consistent with the
    // problem+json error reference.
    expect(body).toMatch(/Exceeding the cap returns 429/);
  });

  it('cross-links to the /pricing page for the full tier table', () => {
    // The quickstart deliberately doesn't list every tier inline —
    // just the most relevant four. Marketing /pricing is the
    // source-of-truth for the full table; the link must exist so
    // readers can verify the smaller tiers (solo_manual, etc).
    expect(body).toContain('https://driftstack.dev/pricing');
  });
});

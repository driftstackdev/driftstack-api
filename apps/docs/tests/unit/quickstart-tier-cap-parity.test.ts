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
const CURL_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart-curl.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W338.A /quickstart tier-cap parity', () => {
  const body = read(PAGE);
  const curl = read(CURL_PAGE);

  it('cites Free cap (1) matching TIER_CONCURRENT_SESSION_LIMITS.free', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS.free).toBe(1);
    expect(body).toMatch(/Free:\s*1\b/);
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

  it('does not present the restricted Free desktop credential as a curl or sandbox key', () => {
    expect(body).toMatch(/This code quickstart requires a paid tier with API access/);
    expect(body).toMatch(/restricted\s*`ds_test_…` device credential/);
    expect(body).toMatch(/not a general sandbox or SDK key/);
    expect(curl).toMatch(/this HTTP quickstart is paid-only/i);
    expect(curl).toMatch(/not a general sandbox\/customer key/);
    expect(curl).toMatch(/Customer keys on every paid tier, including Manual/);
    expect(curl).toMatch(/This page uses `read` \+ `write`/);
    expect(curl).not.toMatch(/`write:sessions` is enough for everything/);
    expect(curl).toMatch(/A `403` after a downgrade to Free/);
  });

  it('does not claim streaming surfaces are plain HTTPS calls', () => {
    expect(curl).toMatch(
      /The core create, drive, capture, and destroy\s*\n?lifecycle uses plain HTTPS calls/,
    );
    expect(curl).toMatch(
      /Live video and event streams use their\s*\n?documented streaming transports/,
    );
    expect(curl).not.toMatch(/Every Driftstack feature is a plain HTTPS call/);
  });
});

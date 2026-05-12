// W312.A — drift guard for /api/profiles tier-limit numbers. The
// page hard-codes 25 / 100 / 500 for api_starter/builder/scale, and
// declares enterprise as 'custom'. These must match the canonical
// PROFILES_PER_TIER export in @driftstack/api-types — that constant
// is the source the service consults at create-time.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILES_PER_TIER } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/profiles.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W312.A /api/profiles ↔ PROFILES_PER_TIER parity', () => {
  const body = read(PAGE);

  it('cites PROFILES_PER_TIER as the source of truth', () => {
    expect(body).toContain('PROFILES_PER_TIER');
  });

  it('cites @driftstack/api-types as the package home for the constant', () => {
    expect(body).toContain('@driftstack/api-types');
  });

  it('lists api_starter cap', () => {
    expect(body).toMatch(new RegExp(`api_starter[\\s\\S]*?${PROFILES_PER_TIER.api_starter}`));
  });

  it('lists api_builder cap', () => {
    expect(body).toMatch(new RegExp(`api_builder[\\s\\S]*?${PROFILES_PER_TIER.api_builder}`));
  });

  it('lists api_scale cap', () => {
    expect(body).toMatch(new RegExp(`api_scale[\\s\\S]*?${PROFILES_PER_TIER.api_scale}`));
  });

  it('frames enterprise as negotiated / custom (matches PROFILES_PER_TIER.enterprise === "custom")', () => {
    expect(PROFILES_PER_TIER.enterprise).toBe('custom');
    expect(body).toMatch(/enterprise/i);
    expect(body).toMatch(/profile_cap:\s*null/);
  });

  it('429 Tier limit problem reference is present on the page', () => {
    expect(body).toMatch(/429\s+Tier limit/i);
  });
});

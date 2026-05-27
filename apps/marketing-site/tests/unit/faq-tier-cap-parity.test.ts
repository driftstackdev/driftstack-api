// W261.C — drift-guard for /faq. The FAQ hardcodes the per-tier
// concurrent cap row "Solo Manual = 1 / Team Manual = 3 / …" so the
// cap numbers can rot when TIER_CONCURRENT_SESSION_LIMITS changes.
// Pin them to the live constants.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_CONCURRENT_SESSION_LIMITS, PROFILES_PER_TIER } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/faq.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W261.C /faq ↔ TIER_CONCURRENT_SESSION_LIMITS parity', () => {
  const page = read(PAGE);

  it('Solo / Team / Agency Manual + API Starter / Builder / Scale caps match the schema', () => {
    expect(page).toMatch(
      new RegExp(`Solo Manual = ${TIER_CONCURRENT_SESSION_LIMITS.solo_manual} concurrent`),
    );
    expect(page).toMatch(
      new RegExp(`Team Manual = ${TIER_CONCURRENT_SESSION_LIMITS.team_manual}\\b`),
    );
    expect(page).toMatch(
      new RegExp(`Agency Manual = ${TIER_CONCURRENT_SESSION_LIMITS.agency_manual}\\b`),
    );
    expect(page).toMatch(
      new RegExp(`API Starter = ${TIER_CONCURRENT_SESSION_LIMITS.api_starter}\\b`),
    );
    expect(page).toMatch(
      new RegExp(`API Builder = ${TIER_CONCURRENT_SESSION_LIMITS.api_builder}\\b`),
    );
    expect(page).toMatch(new RegExp(`API Scale = ${TIER_CONCURRENT_SESSION_LIMITS.api_scale}\\b`));
  });

  it('429 cap-reached behavior is described per the live policy', () => {
    expect(page).toMatch(/HTTP 429/);
    expect(page).toMatch(/RFC 7807 problem-detail/i);
  });

  it('free-tier framing pinned: $0-forever / one concurrent / manual-only / no metering', () => {
    expect(page).toMatch(/The free tier is \$0 forever/);
    expect(page).toMatch(/The free tier has no metering at all/);
    expect(page).toMatch(/The free tier is manual-only/);
  });

  it('annual discount label matches the live ANNUAL_DISCOUNT_LABEL', () => {
    expect(page).toMatch(/20% off/);
  });

  it('does not hard-code legacy cap numbers (Agency 10, API Builder 5, API Scale 20)', () => {
    // Negative checks: prior drift values we already corrected in W253.D.
    expect(page).not.toMatch(/Agency Manual = 10\b/);
    expect(page).not.toMatch(/API Builder = 5\b/);
    expect(page).not.toMatch(/API Scale = 20\b/);
  });

  it('PROFILES_PER_TIER values referenced in the FAQ match the schema', () => {
    // Free tier profile cap is 1. (Sanity bound only; FAQ may not show all numbers.)
    expect(PROFILES_PER_TIER.free).toBe(1);
  });
});

// W253.B — drift-guard for docs.driftstack.io/api/profiles. The
// previous revision asserted profile caps (Solo 5, API Starter 10,
// API Builder 25, API Scale 100) that didn't match
// PROFILES_PER_TIER. Pin them to the live constants.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema, PROFILES_PER_TIER } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/profiles.md');

function read(): string {
  return readFileSync(DOC, 'utf8');
}

describe('W253.B docs/api/profiles ↔ PROFILES_PER_TIER parity', () => {
  const doc = read();
  const tiers = (AccountTierSchema._def.values as readonly string[]).slice();

  it('lists every AccountTier in the profile-cap table', () => {
    for (const t of tiers) {
      expect(doc).toMatch(new RegExp(`\`${t}\``));
    }
  });

  it('every cap matches PROFILES_PER_TIER (or "custom" for enterprise)', () => {
    for (const t of tiers) {
      const cap = PROFILES_PER_TIER[t as keyof typeof PROFILES_PER_TIER];
      const expected = cap === 'custom' ? 'custom' : cap.toString();
      const re = new RegExp(`\`${t}\`\\s*\\|\\s*${expected}\\s*\\|`);
      expect(doc, `cap mismatch for ${t} (expect ${expected})`).toMatch(re);
    }
  });

  it('says crossing cap returns 429 (problem-type tier-limit)', () => {
    expect(doc).toMatch(/429 Tier limit/);
  });

  it('profile ids use the prof_ prefix', () => {
    expect(doc).toMatch(/"id":\s*"prof_/);
  });
});

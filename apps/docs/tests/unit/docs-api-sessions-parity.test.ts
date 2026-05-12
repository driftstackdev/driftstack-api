// W253.A — drift-guard for docs.driftstack.dev/api/sessions. The
// previous revision asserted concurrency caps (Agency 10, API
// Builder 5, API Scale 20) that didn't match
// TIER_CONCURRENT_SESSION_LIMITS. This guard pins the table to the
// live constants.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema, TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/sessions.md');

function read(): string {
  return readFileSync(DOC, 'utf8');
}

describe('W253.A docs/api/sessions ↔ tier-cap parity', () => {
  const doc = read();
  const tiers = (AccountTierSchema._def.values as readonly string[]).slice();

  it('lists every AccountTier in the concurrency table', () => {
    for (const t of tiers) {
      expect(doc).toMatch(new RegExp(`\`${t}\``));
    }
  });

  it('every concurrency cap matches TIER_CONCURRENT_SESSION_LIMITS', () => {
    for (const t of tiers) {
      const cap = TIER_CONCURRENT_SESSION_LIMITS[t as keyof typeof TIER_CONCURRENT_SESSION_LIMITS];
      // Row format: | `tier` | N |
      const re = new RegExp(`\`${t}\`\\s*\\|\\s*${cap.toString()}\\s*\\|`);
      expect(doc, `cap mismatch for ${t} (expect ${cap.toString()})`).toMatch(re);
    }
  });

  it('says concurrency-cap exhaustion returns 429 (not 409)', () => {
    expect(doc).toMatch(/429 Too Many/);
    expect(doc).not.toMatch(/409\s+Conflict/i);
  });

  it('session ids use the ses_ prefix', () => {
    expect(doc).toMatch(/"id":\s*"ses_/);
  });
});

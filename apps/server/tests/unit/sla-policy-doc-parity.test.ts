// W234.A — drift-guard for /docs/sla-policy.
//
// The previous revision listed tier names that don't exist
// (`solo_automated`, `team_growth`). Customers reading the SLA
// table would see tiers they can't actually purchase. This guard
// pins the tier names to the AccountTier enum.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'sla-policy.astro');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W234.A sla-policy doc parity', () => {
  const doc = read(DOC_PATH);
  const tiers = (AccountTierSchema._def.values as readonly string[]).slice();

  it('only references tier names that exist in AccountTierSchema', () => {
    // Pull every <code>foo_bar</code> mention in the page, then check
    // that any that look like a tier-id (snake_case lowercase) appear
    // in the enum.
    const codes = Array.from(doc.matchAll(/<code>([a-z][a-z_]+)<\/code>/g)).map((m) => m[1]!);
    const tierLike = codes.filter((c) => c.includes('_'));
    expect(tierLike.length).toBeGreaterThan(0);
    const offenders = tierLike.filter(
      (c) =>
        !tiers.includes(c) &&
        // Allow a few known non-tier snake_case literals the page
        // can mention (e.g. `target_url` callouts).
        !['target_url'].includes(c),
    );
    expect(offenders).toEqual([]);
  });

  it('does not reference the fictional solo_automated / team_growth tiers', () => {
    expect(doc).not.toMatch(/\bsolo_automated\b/);
    expect(doc).not.toMatch(/\bteam_growth\b/);
  });
});

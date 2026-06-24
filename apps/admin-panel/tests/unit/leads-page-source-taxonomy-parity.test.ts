// W338.C — drift guard for the admin /leads source taxonomy in
// src/data/mocks.ts.
//
// The leads page is now an honest "coming soon" empty state (lead
// capture isn't wired — no /v1/admin/leads route, no leads table), so
// it no longer renders SOURCE_BADGE / SOURCE_LABEL maps or a source
// filter dropdown. The MockLead.source union still lives in mocks.ts
// as the canonical lead-source taxonomy for when the feature lands;
// this guard pins that union + the lead-id convention. When the
// endpoint + a real leads page land, re-add the page-side badge/label/
// filter parity checks alongside them.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MOCKS = resolve(REPO_ROOT, 'apps/admin-panel/src/data/mocks.ts');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/leads.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W338.C admin /leads source-taxonomy parity', () => {
  const mocks = read(MOCKS);
  const page = read(PAGE);

  // Extract the source: union from mocks.ts. The union literal lives
  // inline in the MockLead interface, so we grep for the line.
  const unionMatch = mocks.match(/source:\s*((?:'[a-z_]+'\s*\|\s*)*'[a-z_]+');/);
  expect(unionMatch).not.toBeNull();
  const union = unionMatch![1]!
    .split('|')
    .map((s) =>
      s
        .trim()
        .replace(/^'|';?$/g, '')
        .replace(/'$/g, ''),
    )
    .sort();

  it('MockLead.source union holds the canonical 4 sources', () => {
    expect(union).toEqual(['docs_signup', 'email_inbound', 'other', 'pricing_cta'].sort());
  });

  it('every lead in MOCK_LEADS has a "lead_" id prefix (convention)', () => {
    const ids = [...mocks.matchAll(/id:\s*'(lead_[^']+)'/g)].map((m) => m[1]!);
    // At least one row exists; all rows use the convention.
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith('lead_')).toBe(true);
    }
  });

  it('leads page is the honest "coming soon" placeholder (no fabricated source rows until the endpoint lands)', () => {
    // The page no longer renders the source taxonomy; pin that it
    // stays a placeholder + carries no fabricated demo rows / dead
    // backend claim, so a future "live" wire-up has to be deliberate.
    expect(page).toMatch(/Coming soon/);
    expect(page).not.toMatch(/MOCK_LEADS/);
    expect(page).not.toMatch(/magic-link signup email/);
  });
});

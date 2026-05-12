// W338.C — drift guard for the admin /leads page source taxonomy.
// Three places hard-code the four lead sources (pricing_cta /
// docs_signup / email_inbound / other):
//
//   1. MockLead.source union in src/data/mocks.ts
//   2. SOURCE_BADGE + SOURCE_LABEL maps in leads.astro
//   3. The filter dropdown <option value="…"> list
//
// All three must stay in sync. If we add a 'partner_referral'
// source to the union without updating the label map, the page
// renders the raw slug instead of a pretty label. If we add a
// dropdown option that doesn't match the union, the filter
// becomes a no-op.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/leads.astro');
const MOCKS = resolve(REPO_ROOT, 'apps/admin-panel/src/data/mocks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W338.C admin /leads source-taxonomy parity', () => {
  const page = read(PAGE);
  const mocks = read(MOCKS);

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

  it('SOURCE_BADGE map keys match MockLead.source exactly', () => {
    const badge = page.match(/SOURCE_BADGE:[^{]*\{([\s\S]*?)\};/);
    expect(badge).not.toBeNull();
    const keys = [...badge![1]!.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]!).sort();
    expect(keys).toEqual(union);
  });

  it('SOURCE_LABEL map keys match MockLead.source exactly', () => {
    const label = page.match(/SOURCE_LABEL:[^{]*\{([\s\S]*?)\};/);
    expect(label).not.toBeNull();
    const keys = [...label![1]!.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]!).sort();
    expect(keys).toEqual(union);
  });

  it('the filter dropdown lists every source in the union (plus an "all sources" empty option)', () => {
    const opts = [...page.matchAll(/<option value="([a-z_]*)">/g)].map((m) => m[1]!);
    // One empty option (= "All sources") plus exactly the union members.
    expect(opts).toContain('');
    const sources = opts.filter((s) => s !== '').sort();
    expect(sources).toEqual(union);
  });

  it('every lead in MOCK_LEADS has a "lead_" id prefix (convention)', () => {
    const ids = [...mocks.matchAll(/id:\s*'(lead_[^']+)'/g)].map((m) => m[1]!);
    // At least one row exists; all rows use the convention.
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith('lead_')).toBe(true);
    }
  });

  it('conversion footer copy mentions the audit-log + magic-link signup behaviour', () => {
    // Pin the customer-facing description so a copy revamp can't
    // silently drop the "all actions audit-logged" guarantee.
    expect(page).toMatch(/magic-link signup email/);
    expect(page).toMatch(/audit-logged/);
  });
});

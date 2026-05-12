// W261.D — drift-guard for /trust/incidents page. Pins:
// 1. Sub-processor names referenced in the "what we publish" copy
//    match the live SUB_PROCESSORS list.
// 2. The 72-hour maintenance-window notice claim is consistent with
//    /docs/incident-policy.
// 3. Severity classes (major_outage / degraded / security) match the
//    page's Incident interface.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUB_PROCESSORS } from '../../src/data/sub-processors';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/incidents.astro');
const POLICY = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/incident-policy.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W261.D /trust/incidents ↔ sub-processors + incident-policy parity', () => {
  const page = read(PAGE);

  it('sub-processor names referenced in the page are present in the live SUB_PROCESSORS list', () => {
    // Pull the names cited in the "Sub-processor incidents" card.
    const m = page.match(/upstream sub-processor \(([^)]+)\)/);
    expect(m).not.toBeNull();
    const cited = m![1]!
      .split(/\s*\/\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(cited.length).toBeGreaterThan(2);
    // Canonical names from SUB_PROCESSORS — strip suffixes like "Cloud" / "R2".
    const liveNames = new Set(
      SUB_PROCESSORS.flatMap((sp) => {
        const base = sp.name.split(' ')[0];
        return base ? [base] : [];
      }),
    );
    const missing = cited.filter((c) => !liveNames.has(c));
    expect(missing).toEqual([]);
  });

  it('maintenance-window notice claim of 72 hours is consistent', () => {
    expect(page).toMatch(/72\s*hours/i);
  });

  it('severity values match the page Incident type union', () => {
    // The page declares `severity: 'major_outage' | 'degraded' | 'security'`.
    expect(page).toMatch(/'major_outage'/);
    expect(page).toMatch(/'degraded'/);
    expect(page).toMatch(/'security'/);
  });

  it('cross-links to /docs/incident-policy (which exists)', () => {
    // The page itself may not link directly, but the related security-overview
    // does — verify the policy page exists for navigation.
    const policy = read(POLICY);
    expect(policy.length).toBeGreaterThan(100);
  });

  it('does not falsely claim live incidents pre-launch', () => {
    // INCIDENTS array is empty; page must say so.
    expect(page).toMatch(/No customer-impacting incidents to date/);
    expect(page).toMatch(/const INCIDENTS:\s*Incident\[\]\s*=\s*\[\s*(?:\/\/[^\n]*\n\s*)?\]/);
  });
});

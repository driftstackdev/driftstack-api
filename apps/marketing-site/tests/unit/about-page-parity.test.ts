// W262.B — drift-guard for /about page. Pins:
// 1. EU-resident sub-processor names match the live SUB_PROCESSORS list.
// 2. Customer-configurable egress is framed as ROADMAP, not shipped.
// 3. /trust/security-overview cross-link exists.
// 4. No fictional SOC 2 / SOC2 marketing claim.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUB_PROCESSORS } from '../../src/data/sub-processors';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/about.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W262.B /about ↔ live posture parity', () => {
  const page = read(PAGE);

  it('EU-resident sub-processor names cited match the live SUB_PROCESSORS list', () => {
    // The "EU-resident, by default" card mentions Hetzner, Neon, Cloudflare, Postmark.
    const cited = ['Hetzner', 'Neon', 'Cloudflare', 'Postmark'];
    const liveBases = new Set(SUB_PROCESSORS.map((sp) => sp.name.split(' ')[0]!).filter(Boolean));
    for (const name of cited) {
      expect(page).toContain(name);
      expect(liveBases.has(name)).toBe(true);
    }
  });

  it('customer-configurable egress is framed as roadmap, not shipped', () => {
    // The page must explicitly say it's on the roadmap and not advertise it as live.
    expect(page).toMatch(/customer-configurable\s+egress/);
    expect(page).toMatch(/on (?:our|the) roadmap/i);
  });

  it('does not advertise SOC 2 as a live certification', () => {
    // Marketing posture rule: SOC 2 stays a "future-revenue milestone".
    expect(page).toMatch(/SOC 2/);
    expect(page).toMatch(/future-revenue milestone|not today/i);
    // No active "SOC 2 certified" / "SOC 2 compliant" claims.
    expect(page).not.toMatch(/SOC 2 certified/i);
    expect(page).not.toMatch(/SOC 2 compliant/i);
  });

  it('cross-link /trust/security-overview resolves to a real page', () => {
    expect(page).toContain('/trust/security-overview');
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/security-overview.astro')),
    ).toBe(true);
  });

  it('does not advertise behavioural data collection', () => {
    expect(page).toMatch(/No behavioural data collection/);
  });
});

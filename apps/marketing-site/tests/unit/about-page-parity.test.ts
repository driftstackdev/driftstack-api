// W262.B — drift-guard for /about page. Pins:
// 1. EU-resident sub-processor names match the live SUB_PROCESSORS list.
// 2. Customer-configurable egress is described as shipped.
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

  it('F-5 (Issue 6) about page links to /trust/sub-processors for the live SUB_PROCESSORS list (vendor names moved off the about page splash); the sub-processor data module is still the source of truth and must contain the four vendors that previously appeared inline', () => {
    // The about page now points to /trust/sub-processors rather than
    // enumerating vendors inline. Verify the link exists.
    expect(page).toContain('/trust/sub-processors');
    // And the source-of-truth data still includes the four cited vendors
    // (so the cross-page sub-processor surface stays consistent).
    const expected = ['Hetzner', 'Neon', 'Cloudflare', 'Postmark'];
    const liveBases = new Set(SUB_PROCESSORS.map((sp) => sp.name.split(' ')[0]!).filter(Boolean));
    for (const name of expected) {
      expect(liveBases.has(name)).toBe(true);
    }
  });

  it('F-5 (Issue 5) customer-configurable egress framing on the about page: the prior "on the roadmap" parenthetical was replaced (commit 87e37383) with explicit SOCKS5/WireGuard/OpenVPN listing + cross-link to /trust/security-overview for "the security posture". The honest-disclosure surface for the impl state has moved to security.astro (gated by W499.D against actual server source).', () => {
    expect(page).toMatch(/customer-configurable\s+egress \(SOCKS5 · WireGuard · OpenVPN/);
    expect(page).not.toMatch(/customer-configurable\s+egress[\s\S]{0,80}on (?:our|the) roadmap/i);
  });

  it('does not advertise SOC 2 as a live certification', () => {
    expect(page).not.toMatch(/SOC 2/i);
    expect(page).not.toMatch(/ISO 27001/i);
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

// Cross-source invariant: the sub-processor roster appears in both
// legal/dpa.md (DPA Appendix 2) AND legal/sub-processors.md
// (canonical list). Every entity that processes customer data MUST
// appear in both. Drift (sub-processor added in one but not the
// other) creates a GDPR-compliance gap — Customers must be able
// to verify the complete list from a single source.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DPA = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/dpa.md');
const SUBP = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/sub-processors.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sub-processor list cross-source invariant (DPA + sub-processors.md)', () => {
  const dpa = read(DPA);
  const subp = read(SUBP);

  it('Stripe appears in both DPA + sub-processors.md', () => {
    expect(dpa).toMatch(/Stripe Payments Europe Ltd/);
    expect(dpa).toMatch(/Stripe, Inc\./);
    expect(subp).toMatch(/\*\*Stripe, Inc\.\*\*/);
  });

  it('Hetzner appears in both DPA + sub-processors.md (or via the dev/staging-narrowed disclaimer)', () => {
    expect(dpa).toMatch(/Hetzner Online GmbH/);
    // sub-processors.md narrowed Hetzner to dev/staging only (per
    // the R4 changelog post-2026-05-12)
    expect(subp).toMatch(/\*\*Hetzner narrowed\*\*/);
  });

  it('Cloudflare appears in both DPA + sub-processors.md', () => {
    expect(dpa).toMatch(/Cloudflare, Inc\./);
    expect(subp).toMatch(/\*\*Cloudflare, Inc\.\*\*/);
  });

  it('Postmark appears in both DPA + sub-processors.md', () => {
    expect(dpa).toMatch(/Postmark \(ActiveCampaign LLC\)/);
    expect(subp).toMatch(/Postmark/);
  });

  it('NowPayments appears in both DPA + sub-processors.md (conditional opt-in via crypto-tier)', () => {
    expect(dpa).toMatch(/NowPayments OÜ \(conditional, opt-in only\)/);
    expect(subp).toMatch(/\*\*NowPayments OÜ\*\*/);
  });

  it('AWS appears in sub-processors.md (primary compute) — pinned so the canonical-list reflects production-state (AWS is the post-Hetzner-narrowing primary)', () => {
    expect(subp).toMatch(/\*\*Amazon Web Services, Inc\.\*\* \(AWS\)/);
  });

  it("LiveKit appears in sub-processors.md (Browser Theatre opt-in feature) — pinned so the LK.1/LK.2 fleet-side-LiveKit addition isn't orphaned from the legal disclosure surface", () => {
    expect(subp).toMatch(/\*\*LiveKit, Inc\.\*\*/);
  });
});

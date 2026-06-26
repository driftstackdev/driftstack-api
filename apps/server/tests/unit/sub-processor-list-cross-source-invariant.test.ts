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
    expect(subp).toMatch(/\*\*Stripe\*\*/);
  });

  it('Hetzner appears in both DPA + sub-processors.md (production compute, EU-resident)', () => {
    expect(dpa).toMatch(/Hetzner Online GmbH/);
    // Production runs on Hetzner; sub-processors.md lists it as the
    // production control-plane compute host (no AWS-narrowing claim).
    expect(subp).toMatch(/\*\*Hetzner Cloud\*\*/);
  });

  it('Cloudflare appears in both DPA + sub-processors.md', () => {
    expect(dpa).toMatch(/Cloudflare, Inc\./);
    expect(subp).toMatch(/\*\*Cloudflare R2\*\*/);
  });

  it('Postmark appears in both DPA + sub-processors.md', () => {
    expect(dpa).toMatch(/Postmark \(ActiveCampaign LLC\)/);
    expect(subp).toMatch(/\*\*Postmark\*\*/);
  });

  it('NowPayments appears in both DPA + sub-processors.md (conditional opt-in via crypto-tier)', () => {
    expect(dpa).toMatch(/NowPayments OÜ \(conditional, opt-in only\)/);
    expect(subp).toMatch(/\*\*NowPayments OÜ\*\*/);
  });

  it('AWS does NOT appear — production runs on Hetzner/Neon/Upstash/R2/MacStadium, not AWS', () => {
    expect(subp).not.toMatch(/Amazon Web Services|\bAWS\b/);
    expect(dpa).not.toMatch(/Amazon Web Services|\bAWS\b/);
  });

  it('Neon + Upstash + MacStadium + Anthropic + Moneybird + Sentry appear in both DPA + sub-processors.md', () => {
    expect(dpa).toMatch(/Neon, Inc\./);
    expect(subp).toMatch(/\*\*Neon, Inc\.\*\*/);
    expect(dpa).toMatch(/Upstash, Inc\./);
    expect(subp).toMatch(/\*\*Upstash, Inc\.\*\*/);
    expect(dpa).toMatch(/MacStadium, Inc\./);
    expect(subp).toMatch(/\*\*MacStadium\*\*/);
    expect(dpa).toMatch(/Anthropic, PBC/);
    expect(subp).toMatch(/\*\*Anthropic\*\*/);
    expect(dpa).toMatch(/Moneybird B\.V\./);
    expect(subp).toMatch(/\*\*Moneybird\*\*/);
    expect(dpa).toMatch(/Sentry \(Functional Software, Inc\.\)/);
    expect(subp).toMatch(/\*\*Sentry\*\*/);
  });

  it("LiveKit appears in both DPA + sub-processors.md (opt-in live-session feature) — pinned so the LK.1/LK.2 fleet-side-LiveKit addition isn't orphaned from the legal disclosure surface", () => {
    expect(dpa).toMatch(/LiveKit \(conditional, opt-in only\)/);
    expect(subp).toMatch(/\*\*LiveKit, Inc\.\*\*/);
  });
});

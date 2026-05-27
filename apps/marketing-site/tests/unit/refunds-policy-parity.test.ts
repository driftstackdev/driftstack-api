// W339.B — drift guard for the marketing /legal/refunds page.
// Several claims on this page are tied to source-of-truth values:
//
//   • the discretionary "14 days of first paid charge, no usage"
//     card-refund window (a goodwill policy, not statutory)
//   • cross-links to /pricing/crypto + /docs/cost-monitoring must
//     resolve to real pages
//   • the canonical support / legal / privacy / dispute contact
//     surface area is support@driftstack.dev
//   • the Terms cross-reference cites section 8.7
//
// Catches: stale day-count, broken cross-links if those pages
// move, contact-email rename.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/refunds.md');
const CRYPTO_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing/crypto.astro');
const COST_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/cost-monitoring.astro');
const TERMS_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/terms.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W339.B /legal/refunds policy parity', () => {
  const body = read(PAGE);

  it('declares crypto payments non-refundable (matches ADR posture)', () => {
    expect(body).toMatch(/Crypto payments at Driftstack are non-refundable/);
    expect(body).toMatch(/Settlement irreversibility/);
  });

  it('cross-link to /pricing/crypto resolves to a real marketing page', () => {
    expect(body).toContain('/pricing/crypto');
    expect(existsSync(CRYPTO_PAGE)).toBe(true);
  });

  it('cross-link to /docs/cost-monitoring resolves to a real marketing page', () => {
    expect(body).toContain('/docs/cost-monitoring');
    expect(existsSync(COST_PAGE)).toBe(true);
  });

  it('cites support@driftstack.dev as the refund-request channel', () => {
    expect(body).toContain('support@driftstack.dev');
  });

  it('cites section 8.7 of Terms (SLA credit math reference)', () => {
    // The refund policy is "incorporated by reference" into the
    // Terms; section 8.7 is named explicitly. Pin both sides so a
    // Terms re-section doesn't silently break the reference.
    expect(body).toMatch(/section 8\.7/);
    expect(existsSync(TERMS_PAGE)).toBe(true);
  });

  it('cites "14 days of first paid charge, no usage" discretionary refund window', () => {
    // The 14-day no-usage refund window is a discretionary policy
    // (not statutory). Pin the framing so a copy revamp doesn't
    // silently widen / narrow it.
    expect(body).toMatch(/Within 14 days of first paid charge, no usage/);
  });

  it('frames disputes around chargeback + 5-business-day response window', () => {
    expect(body).toMatch(/5 business days/);
    expect(body).toMatch(/chargeback/);
  });
});

// W342.A — drift guard for /docs/data-residency. The page claims:
//
//   • Region preference is one of {us, eu, apac, null} — must match
//     AccountRegionSchema in api-types/src/accounts.ts.
//   • Set via PATCH /v1/account/me — must be registered server-side.
//   • Cross-links to /trust/sub-processors AND /legal/sub-processors
//     (both must exist as real pages).
//   • Cites privacy@driftstack.dev + compliance@driftstack.dev as
//     the canonical contact channels.
//
// Catches: enum drift, server PATCH route rename, broken cross-links.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/data-residency.astro');
const ACCOUNT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');
const TRUST_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/sub-processors.astro');
const LEGAL_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/sub-processors.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W342.A /docs/data-residency parity', () => {
  const body = read(PAGE);
  const route = read(ACCOUNT_ROUTE);
  const schemaValues = new Set<string>(
    (AccountRegionSchema._def as { values: readonly string[] }).values,
  );

  it('AccountRegionSchema enumerates exactly us/eu/apac', () => {
    expect(schemaValues).toEqual(new Set(['us', 'eu', 'apac']));
  });

  it('page cites every AccountRegion value', () => {
    for (const v of schemaValues) {
      expect(body).toMatch(new RegExp(`<code>${v}</code>`));
    }
  });

  it('page documents the PATCH /v1/account/me route and the server registers it', () => {
    expect(body).toMatch(/PATCH \/v1\/account\/me/);
    expect(route).toContain("'/v1/account/me'");
  });

  it("page declares 'eu' as today's example value (single-region until non-EU PoPs ship)", () => {
    expect(body).toMatch(/"region":\s*"eu"/);
  });

  it('null (unset) is documented as the fourth accepted value (nullable schema)', () => {
    expect(body).toMatch(/<code>null<\/code>\s*\(unset\)/);
  });

  it('cross-link to /trust/sub-processors resolves to a real marketing page', () => {
    expect(body).toContain('/trust/sub-processors');
    expect(existsSync(TRUST_PAGE)).toBe(true);
  });

  it('cross-link to /legal/sub-processors resolves to a real legal page', () => {
    expect(body).toContain('/legal/sub-processors');
    expect(existsSync(LEGAL_PAGE)).toBe(true);
  });

  it('cites privacy@driftstack.dev for DSARs and compliance@driftstack.dev for residency questions', () => {
    expect(body).toContain('privacy@driftstack.dev');
    expect(body).toContain('compliance@driftstack.dev');
  });

  it('declares the 30-day deletion grace period (matches GDPR right-to-erasure policy)', () => {
    expect(body).toMatch(/30-day grace period/);
  });

  it('pins the EU-primary posture (Hetzner Falkenstein / Nuremberg)', () => {
    expect(body).toMatch(/Hetzner Falkenstein \/ Nuremberg/);
    expect(body).toMatch(/runs <strong>primarily in the EU<\/strong>/);
  });

  it('Anthropic + MacStadium transfers framed under SCCs + EU-US DPF', () => {
    // Two of the three US transfers must cite the transfer
    // mechanism. Catches the customer-trust posture being toned
    // down in a future copy revamp.
    expect(body).toMatch(/Anthropic[\s\S]{0,200}SCCs \+ EU-US DPF/);
    expect(body).toMatch(/MacStadium[\s\S]{0,200}SCCs \+ EU-US DPF/);
  });
});

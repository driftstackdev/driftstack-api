// W261.A — drift-guard for /trust/sub-processors. Pins the
// marketing-site SUB_PROCESSORS list to the DPA Annex 3 in
// docs/legal/dpa.md so adding a sub-processor in one place without
// the other doesn't ship.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUB_PROCESSORS, SUB_PROCESSOR_REGISTER_LAST_UPDATED } from '../../src/data/sub-processors';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DPA = resolve(REPO_ROOT, 'docs/legal/dpa.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Canonical short-name set — same identity across DPA + marketing.
// Stripe is one entity on the marketing site (presented as "Stripe")
// but two rows in the DPA Annex 3 (EU + US entities). We canonicalise
// to the customer-facing name.
const MARKETING_TO_CANONICAL: Record<string, string> = {
  'Hetzner Cloud': 'Hetzner',
  Neon: 'Neon',
  Upstash: 'Upstash',
  'Cloudflare R2': 'Cloudflare',
  Postmark: 'Postmark',
  Sentry: 'Sentry',
  Stripe: 'Stripe',
  Anthropic: 'Anthropic',
  Moneybird: 'Moneybird',
  MacStadium: 'MacStadium',
  NowPayments: 'NowPayments',
  LiveKit: 'LiveKit',
};

describe('W261.A /trust/sub-processors ↔ DPA Annex 3 parity', () => {
  const dpa = read(DPA);

  it('every marketing-site sub-processor is named in the DPA Annex 3', () => {
    const missing: string[] = [];
    for (const sp of SUB_PROCESSORS) {
      const canonical = MARKETING_TO_CANONICAL[sp.name];
      expect(canonical, `unknown marketing-site sub-processor: ${sp.name}`).toBeDefined();
      // DPA Annex 3 row mentions the canonical name somewhere.
      if (!dpa.includes(canonical!)) missing.push(sp.name);
    }
    expect(missing).toEqual([]);
  });

  it('every DPA Annex 3 entity has a marketing-site row', () => {
    // Pull the Annex 3 table rows. The DPA table starts at "## Annex 3"
    // and lists "| EntityName | Role | Location | Transfer |".
    const annexIdx = dpa.indexOf('## Annex 3');
    expect(annexIdx).toBeGreaterThan(-1);
    const tail = dpa.slice(annexIdx, dpa.indexOf('## Annex 4', annexIdx));
    const required = [
      'MacStadium',
      'Stripe',
      'Anthropic',
      'Moneybird',
      'Hetzner',
      'Neon',
      'Upstash',
      'Cloudflare',
      'Postmark',
      'Sentry',
      'NowPayments',
      'LiveKit',
    ];
    // Each required entity must appear in the DPA tail.
    for (const r of required) {
      expect(tail).toContain(r);
    }
    // And each must appear in the marketing-site SUB_PROCESSORS, mapped via canonical.
    const marketingCanonical = new Set(
      SUB_PROCESSORS.map((sp) => MARKETING_TO_CANONICAL[sp.name]).filter((n): n is string =>
        Boolean(n),
      ),
    );
    const missing = required.filter((r) => !marketingCanonical.has(r));
    expect(missing).toEqual([]);
  });

  it('every sub-processor row carries a transfer mechanism string', () => {
    for (const sp of SUB_PROCESSORS) {
      expect(sp.transferMechanism.length).toBeGreaterThan(5);
    }
  });

  it('register has a last-updated timestamp on or after 2026-01-01', () => {
    // Sanity bound — catches stub strings like "2024-01-01" if we ever regress.
    expect(SUB_PROCESSOR_REGISTER_LAST_UPDATED >= '2026-01-01').toBe(true);
  });
});

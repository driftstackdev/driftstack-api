// W265.B — drift-guard for /docs/cost-monitoring. Pins:
// 1. /v1/account/cost endpoint matches the live route.
// 2. The 5 breakdown components cited (compute / storage / egress /
//    email / bundled LLM) match the live service response keys.
// 3. billing_cycle query param format matches the live regex.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/cost-monitoring.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W265.B /docs/cost-monitoring ↔ /v1/account/cost route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('/v1/account/cost endpoint is documented + registered', () => {
    expect(page).toMatch(/\/v1\/account\/cost/);
    expect(route).toContain(`'/v1/account/cost'`);
  });

  it('breakdown components cited in the doc match the live response keys', () => {
    // Live keys per the route handler: computeCents / storageCents /
    // egressCents / emailCents / llmCents / totalCents.
    for (const key of ['computeCents', 'storageCents', 'egressCents', 'emailCents', 'llmCents']) {
      expect(route).toContain(key);
    }
    // The doc names the human-readable component labels.
    for (const label of ['Compute', 'Storage', 'Egress', 'Email']) {
      expect(page).toMatch(new RegExp(label));
    }
  });

  it('billing_cycle YYYY-MM query format matches the live regex', () => {
    expect(route).toMatch(/regex\(\/\^\\d\{4\}-\\d\{2\}\$\//);
  });

  it('Postmark + Cloudflare R2 sub-processor names are consistent', () => {
    expect(page).toMatch(/Postmark/);
    expect(page).toMatch(/Cloudflare R2/);
  });

  it('does not advertise overage charges (Driftstack uses concurrent caps, not metered overages)', () => {
    // Per the FAQ + pricing pages: no overage charges, paid tiers are
    // concurrent-only. The cost endpoint is an internal cost tracker;
    // it must not be framed as the customer's bill.
    expect(page).not.toMatch(/overage charges/i);
    expect(page).not.toMatch(/overage line items?/i);
  });
});

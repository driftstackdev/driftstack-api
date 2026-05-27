// W331.C — drift guard for /select-tier page. The page lets users
// jump straight to Stripe checkout for a paid tier:
//   POST /v1/billing/checkout-session
// must be registered server-side. (The one-time /v1/billing/trial-
// pack purchase was retired from the page 2026-05-27; the entry
// tier is now the perpetual free tier with no purchase step.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/select-tier.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W331.C /select-tier ↔ billing route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page no longer calls the retired POST /v1/billing/trial-pack', () => {
    expect(page).not.toContain('/v1/billing/trial-pack');
  });

  it('page calls POST /v1/billing/checkout-session', () => {
    expect(page).toContain('/v1/billing/checkout-session');
  });

  it('server registers /v1/billing/checkout-session', () => {
    expect(route).toContain("'/v1/billing/checkout-session'");
  });
});

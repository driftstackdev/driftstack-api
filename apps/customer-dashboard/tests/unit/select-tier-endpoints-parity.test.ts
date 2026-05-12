// W272.D — drift-guard for customer-dashboard /select-tier page.
// Pins the /v1/billing/trial-pack + /v1/billing/checkout-session
// actions to their live registrations in billing.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/select-tier.astro');
const BILLING = resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W272.D /select-tier page ↔ /v1/billing/* route parity', () => {
  const page = read(PAGE);
  const billing = read(BILLING);

  it('POST /v1/billing/trial-pack is registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/billing\/trial-pack/);
    expect(billing).toContain(`'/v1/billing/trial-pack'`);
  });

  it('POST /v1/billing/checkout-session is registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/billing\/checkout-session/);
    expect(billing).toContain(`'/v1/billing/checkout-session'`);
  });

  it('uses ds_web_session_token for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('does not advertise fictional tiers', () => {
    expect(page).not.toMatch(/team_growth/);
    expect(page).not.toMatch(/solo_pro/);
    expect(page).not.toMatch(/enterprise_plus/);
  });

  it('Stripe is the documented payment processor for checkout', () => {
    expect(page).toMatch(/Stripe|stripe/);
  });
});

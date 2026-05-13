// W592.A — drift guard for packages/sdk-go/billing.go.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/billing.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W592.A packages/sdk-go/billing.go content parity', () => {
  const body = read(LIB);

  it('BillingResource V-082 + 4 verbs (GetState subscription+trial / CreateCheckoutSession Stripe URL / StartTrialPack $2.99 once-per-account nil-body-default / CreatePortalSession Stripe Customer Portal) pinned', () => {
    expect(body).toMatch(/\/\/ BillingResource handles \/v1\/billing endpoints \(V-082\)\./);
    expect(body).toMatch(
      /\/\/ GetState returns the current subscription mirror \+ trial-pack state\./,
    );
    expect(body).toMatch(/\/\/ CreateCheckoutSession and StartTrialPack return Stripe Checkout/);
    expect(body).toMatch(/\/\/ URLs the customer redirects to\. CreatePortalSession returns a/);
    expect(body).toMatch(/\/\/ Stripe Customer Portal URL\./);
    expect(body).toMatch(/^type BillingResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
    expect(body).toMatch(
      /func \(r \*BillingResource\) GetState\(ctx context\.Context\) \(\*GetBillingStateResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/billing",/);
    expect(body).toMatch(/path:\s+"\/v1\/billing\/checkout-session",/);
    expect(body).toMatch(/\/\/ StartTrialPack returns a Stripe Checkout URL for the \$2\.99 trial/);
    expect(body).toMatch(/\/\/ pack purchase\. Once-per-account; calling on an account that has/);
    expect(body).toMatch(/\/\/ already redeemed returns an error\./);
    expect(body).toMatch(/if body == nil \{\s*\n\s*body = &StartTrialPackRequest\{\}\s*\n\s*\}/);
    expect(body).toMatch(/path:\s+"\/v1\/billing\/trial-pack",/);
    expect(body).toMatch(/path:\s+"\/v1\/billing\/portal-session",/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

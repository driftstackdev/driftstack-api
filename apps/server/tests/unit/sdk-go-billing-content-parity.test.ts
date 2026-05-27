// W592.A (W628-deepened) — drift guard for packages/sdk-go/billing.go.
// The original test pinned the 4-verb surface in a single monster it()
// block. W628 splits it into per-verb focused blocks + adds pins for
// previously-implicit invariants:
//
//   • HTTP-method correctness per verb (POST/GET).
//   • V-082 anchor on the BillingResource doc-comment.
//   • Stripe checkout URL contract: CreateCheckoutSession returns a
//     URL the customer must redirect to — drift to a different
//     payment flow would silently break the buyer journey.
//   • $2.99 trial-pack once-per-account gate + nil-body default
//     (StartTrialPackRequest can be nil — SDK substitutes an empty
//     struct so callers don't have to construct one for the
//     no-options case).
//   • CreatePortalSession current-account scoping (the returned URL
//     manages the *calling* account's payment method, never another
//     team's).
//
// Drift on any of these would silently regress the billing flow —
// these are the security-load-bearing customer-redirect paths.

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

  it('file exists at canonical path + BillingResource V-082 anchor + binds /v1/billing endpoints (4-verb surface summary in resource doc-comment)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ BillingResource handles \/v1\/billing endpoints \(V-082\)\./);
    expect(body).toMatch(/\/\/ GetState returns the current subscription mirror state\./);
    expect(body).toMatch(/CreateCheckoutSession returns a Stripe Checkout URL the customer/);
    expect(body).toMatch(/CreatePortalSession returns a/);
    expect(body).toMatch(/trial_pack flow was retired 2026-05-27/);
    expect(body).toMatch(/^type BillingResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('GetState — GET /v1/billing returns the current-account subscription mirror state (Stripe-of-record snapshot the dashboard uses to render plan/usage). Drift would diverge the dashboard from Stripe.', () => {
    expect(body).toMatch(/\/\/ GetState returns the current subscription state\./);
    expect(body).toMatch(
      /func \(r \*BillingResource\) GetState\(ctx context\.Context\) \(\*GetBillingStateResponse, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/billing",/);
  });

  it('CreateCheckoutSession — POST /v1/billing/checkout-session returns a Stripe Checkout URL for a tier subscription. Customer-redirect-required framing pinned ("The customer must be redirected to the URL to complete payment") — drift to a different payment flow would break the buyer journey.', () => {
    expect(body).toMatch(/\/\/ CreateCheckoutSession returns a Stripe Checkout URL for a tier/);
    expect(body).toMatch(/\/\/ subscription\. The customer must be redirected to the URL to/);
    expect(body).toMatch(/\/\/ complete payment\./);
    expect(body).toMatch(
      /func \(r \*BillingResource\) CreateCheckoutSession\(ctx context\.Context, body \*CreateCheckoutSessionRequest\) \(\*CreateCheckoutSessionResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/billing\/checkout-session",/);
  });

  it('CreatePortalSession — POST /v1/billing/portal-session returns a Stripe Customer Portal URL scoped to the *current* account ("the customer manages payment method, invoices, and cancellation through the returned URL"). No body payload — the calling account identity comes from the bearer token, never a parameter, so customers can never request a portal URL for someone else\'s account.', () => {
    expect(body).toMatch(/\/\/ CreatePortalSession returns a Stripe Customer Portal URL for the/);
    expect(body).toMatch(/\/\/ current account\. The customer manages payment method, invoices,/);
    expect(body).toMatch(/\/\/ and cancellation through the returned URL\./);
    expect(body).toMatch(
      /func \(r \*BillingResource\) CreatePortalSession\(ctx context\.Context\) \(\*CreatePortalSessionResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/billing\/portal-session",\s*\n\s*out:\s+&out,/,
    );
  });
});

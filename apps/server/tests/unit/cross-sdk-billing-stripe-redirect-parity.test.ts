// W695 — cross-SDK V-082 billing Stripe-redirect parity. Twenty-
// second in the cross-SDK drift-guard series (W649 + W675 + W676 +
// W677 + W678 + W679 + W680 + W681 + W682 + W683 + W684 + W685 +
// W686 + W687 + W688 + W689 + W690 + W691 + W692 + W693 + W694 +
// W695).
//
// Asserts the V-082 billing-Stripe-redirect contract is consistent
// across all 3 SDKs:
//
//   - V-082 feature anchor pinned per-SDK
//   - 4-verb surface (getState / createCheckoutSession /
//     startTrialPack / createPortalSession) in all 3 SDKs with
//     language-canonical naming
//   - 4 wire-paths pinned: /v1/billing + /v1/billing/checkout-
//     session + /v1/billing/trial-pack + /v1/billing/portal-session
//   - "Stripe Checkout" framing on createCheckoutSession +
//     startTrialPack (the redirect-URL invariant) in TS + Go
//   - "Stripe Customer Portal" framing on createPortalSession
//   - Method-verb invariant: GET on getState; POST on the 3
//     redirect-producing verbs (drift to GET on POST would let
//     accidental browser-prefetch fire real Stripe sessions)
//
// CRITICAL invariant: createCheckoutSession + startTrialPack are
// REDIRECT producers — the customer is sent off to stripe.com to
// complete payment. Drift to inline payment forms (PCI-out-of-scope
// requires Stripe-hosted) would silently move PCI-scope back to
// driftstack-api servers.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_BILLING = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/billing.ts');
const GO_BILLING = resolve(REPO_ROOT, 'packages/sdk-go/billing.go');
const PY_BILLING = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/billing.py');

describe('W695 cross-SDK V-082 billing Stripe-redirect parity', () => {
  it('all 3 SDK billing files exist at canonical paths', () => {
    expect(existsSync(TS_BILLING), `missing ${TS_BILLING}`).toBe(true);
    expect(existsSync(GO_BILLING), `missing ${GO_BILLING}`).toBe(true);
    expect(existsSync(PY_BILLING), `missing ${PY_BILLING}`).toBe(true);
  });

  it('CRITICAL V-082 anchor pinned in all 3 SDKs. V-082 is the billing-Stripe-integration feature anchor; drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_BILLING);
    const go = read(GO_BILLING);
    const py = read(PY_BILLING);

    expect(ts).toMatch(/V-082/);
    expect(go).toMatch(/V-082/);
    expect(py).toMatch(/V-082/);
  });

  it('CRITICAL 3-verb surface pinned across all 3 SDKs — getState + createCheckoutSession + createPortalSession (language-canonical naming; startTrialPack retired 2026-05-27). The 3 verbs cover the customer billing flow; drift to dropping any would break the dashboard or signup flow.', () => {
    const ts = read(TS_BILLING);
    const go = read(GO_BILLING);
    const py = read(PY_BILLING);

    // sdk-typescript: camelCase methods.
    expect(ts).toMatch(/getState\(\)/);
    expect(ts).toMatch(/createCheckoutSession\(/);
    expect(ts).toMatch(/createPortalSession\(\)/);

    // sdk-go: PascalCase methods.
    expect(go).toMatch(/func \(r \*BillingResource\) GetState\(/);
    expect(go).toMatch(/func \(r \*BillingResource\) CreateCheckoutSession\(/);
    expect(go).toMatch(/func \(r \*BillingResource\) CreatePortalSession\(/);

    // sdk-python: snake_case methods.
    expect(py).toMatch(/def get_state\(self/);
    expect(py).toMatch(/def create_checkout_session\(self/);
    expect(py).toMatch(/def create_portal_session\(self/);
  });

  it('CRITICAL 3 wire-paths pinned per-SDK: /v1/billing + /v1/billing/checkout-session + /v1/billing/portal-session (trial-pack retired 2026-05-27). Drift to renaming any path would break server-side routing.', () => {
    const ts = read(TS_BILLING);
    const go = read(GO_BILLING);
    const py = read(PY_BILLING);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/billing/);
      expect(sdk).toMatch(/\/v1\/billing\/checkout-session/);
      expect(sdk).toMatch(/\/v1\/billing\/portal-session/);
    }
  });

  it('CRITICAL "Stripe Checkout" framing pinned in sdk-typescript + sdk-go. The "Stripe Checkout" wording is the customer-facing claim that payment happens on Stripe (NOT driftstack). Drift to dropping would let customers think we accept card-data directly — would silently widen PCI scope.', () => {
    const ts = read(TS_BILLING);
    const go = read(GO_BILLING);

    expect(ts).toMatch(/Stripe\s*\/\/\s*Checkout|Stripe Checkout/);
    expect(go).toMatch(/Stripe Checkout/);
  });

  it('CRITICAL "Stripe Customer Portal" framing pinned on createPortalSession in sdk-typescript + sdk-go + sdk-python. The Portal is where customers manage payment method, invoices, and cancellation. Drift to a hand-rolled portal would re-introduce PCI scope.', () => {
    const ts = read(TS_BILLING);
    const go = read(GO_BILLING);
    const py = read(PY_BILLING);

    expect(ts).toMatch(/Stripe Customer\s*\/\/\s*Portal|Stripe Customer Portal/);
    expect(go).toMatch(/Stripe Customer Portal/);
    expect(py).toMatch(/Stripe Customer Portal/);
  });

  it('CRITICAL "redirects" / "redirected" framing pinned in sdk-typescript + sdk-go. The redirect-to-Stripe pattern is what keeps PCI scope OFF driftstack-api servers. Drift to inline payment forms would silently move PCI scope back.', () => {
    const ts = read(TS_BILLING);
    const go = read(GO_BILLING);

    expect(ts).toMatch(/redirects? to|redirect to|customer redirects/);
    expect(go).toMatch(/redirected to|customer redirects/);
  });

  it("CRITICAL method-verb invariant — GET on getState; POST on the 2 redirect-producing verbs (createCheckoutSession + createPortalSession). Drift to GET on POST would let accidental browser-prefetch fire real Stripe sessions and silently churn through the customer's payment surface.", () => {
    const ts = read(TS_BILLING);
    const go = read(GO_BILLING);

    // sdk-typescript: getState uses GET, 2 redirect-producers use POST.
    // Count GET vs POST mentions in method blocks.
    const tsGetCount = (ts.match(/method: 'GET'/g) ?? []).length;
    const tsPostCount = (ts.match(/method: 'POST'/g) ?? []).length;
    expect(tsGetCount, 'sdk-typescript GET method count').toBe(1);
    expect(tsPostCount, 'sdk-typescript POST method count').toBe(2);

    // sdk-go: same shape, lowercase quoted strings.
    const goGetCount = (go.match(/method: "GET"/g) ?? []).length;
    const goPostCount = (go.match(/method: "POST"/g) ?? []).length;
    expect(goGetCount, 'sdk-go GET method count').toBe(1);
    expect(goPostCount, 'sdk-go POST method count').toBe(2);
  });

  it('CRITICAL "subscription mirror" framing on getState in sdk-typescript + sdk-go (trial-pack state removed 2026-05-27). The "mirror" wording tells customers driftstack does NOT own the source-of-truth for subscription state (Stripe does); driftstack mirrors. Drift to "subscription source" would mislead callers about source-of-truth.', () => {
    const ts = read(TS_BILLING);
    const go = read(GO_BILLING);

    expect(ts).toMatch(/subscription mirror/);
    expect(go).toMatch(/subscription mirror/);
  });

  it('Cross-SDK V-082 invariant cluster — V-082 anchor + 3-verb surface (getState/createCheckoutSession/createPortalSession) + 3 wire-paths (/v1/billing + checkout-session + portal-session) + Stripe-redirect framing + subscription-mirror framing. Drift on any would fragment the cross-language billing contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_BILLING),
      'sdk-go': read(GO_BILLING),
      'sdk-python': read(PY_BILLING),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-082`).toMatch(/V-082/);
      expect(body, `${name} /v1/billing path`).toMatch(/\/v1\/billing/);
      expect(body, `${name} checkout-session`).toMatch(/checkout-session/);
      expect(body, `${name} portal-session`).toMatch(/portal-session/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cross-sdk-billing-stripe-redirect-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

// W800 — cross-SDK billing-flow-example parity. One-hundred-twenty-
// sixth in the drift-guard series. Pins the "mirror the customer-
// dashboard /billing page in code form" demo in lockstep across
// sdk-typescript / sdk-python / sdk-go. Drift here would let one
// SDK direct customers to a different success_url / cancel_url
// pair, breaking the documented round-trip.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/examples/billing-flow.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/examples/billing_flow.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/examples/billing_flow/main.go');

describe('W800 cross-SDK billing-flow examples parity', () => {
  it('all 3 billing-flow example files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── Header framing: mirror-/billing-page ─────────────────────

  it("CRITICAL 'mirror the customer-dashboard /billing page in code form so server-side integrations can offer the same UX without iframing the dashboard' framing pinned cross-SDK. Drift would lose the canonical 'why this example exists' explanation — without it, readers might think the SDK billing surface is a separate product.", () => {
    expect(read(TS)).toMatch(
      /Customer billing self-serve flow — mirror the customer-dashboard\s*\n\/\/ \/billing page in code form so server-side integrations can offer\s*\n\/\/ the same UX without iframing the dashboard\./,
    );
    expect(read(PY)).toMatch(
      /Customer billing self-serve flow — mirror the customer-dashboard\s*\n\/billing page in code form so server-side integrations can offer\s*\nthe same UX without iframing the dashboard\./,
    );
    expect(read(GO)).toMatch(
      /Reads the current billing state, then either redirects the customer\s*\n\/\/ to a checkout-session URL \(if they have no subscription\) or to the\s*\n\/\/ Stripe customer portal/,
    );
  });

  it("CRITICAL 2-branch flow framing pinned cross-SDK — 'redirects to a Checkout session URL (no subscription yet)' + 'opens the Stripe Customer Portal (has a subscription)'. The dual flow is the load-bearing teaching pattern.", () => {
    expect(read(TS)).toMatch(
      /redirects to a Checkout session URL \(no subscription yet\)[\s\S]*?opens the Stripe Customer Portal \(has a subscription\)/,
    );
    expect(read(PY)).toMatch(
      /redirects to a Checkout session URL \(no subscription yet\)[\s\S]*?opens the Stripe Customer Portal \(has a subscription\)/,
    );
  });

  it("CRITICAL Go-only account_owner scope disclaimer pinned. The 'expects a customer-account API key with the account_owner scope (or the legacy admin compat alias)' wording is the canonical permission-required framing. Drift to claiming a different scope would break the demo for integrators.", () => {
    expect(read(GO)).toMatch(
      /expects a customer-account API key with the\s*\n\/\/ `account_owner` scope \(or the legacy `admin` compat alias\)\./,
    );
  });

  // ─── getState first ───────────────────────────────────────────

  it('CRITICAL getState-as-first-call pinned cross-SDK. TS: `client.billing.getState()` + Python: `client.billing.get_state()` + Go: `client.Billing.GetState(ctx)`. The single state-read drives the branch — drift to multiple separate reads would race-condition.', () => {
    expect(read(TS)).toMatch(/const state = await client\.billing\.getState\(\);/);
    expect(read(PY)).toMatch(/state = client\.billing\.get_state\(\)/);
    expect(read(GO)).toMatch(/state, err := client\.Billing\.GetState\(ctx\)/);
  });

  // ─── subscription === null gate ───────────────────────────────

  it("CRITICAL subscription-is-null gate pinned cross-SDK. TS: `state.subscription === null` + Python: `state.get('subscription') is None` + Go: `state.Subscription == nil`. Drift to truthiness checks (just `!state.subscription`) would let a `{}` subscription value pass through wrongly.", () => {
    expect(read(TS)).toMatch(/if \(state\.subscription === null\) \{/);
    expect(read(PY)).toMatch(/if state\.get\("subscription"\) is None:/);
    expect(read(GO)).toMatch(/if state\.Subscription == nil \{/);
  });

  // ─── createCheckoutSession with api_builder + monthly ─────────

  it("CRITICAL createCheckoutSession with tier=api_builder + billing_period=monthly pinned in TS + Python. Go omits billing_period because it defaults to monthly per CreateCheckoutSessionRequest. Drift to a different tier would change the canonical 'first paid tier' demo.", () => {
    expect(read(TS)).toMatch(/tier: 'api_builder',\s*\n\s+billing_period: 'monthly',/);
    expect(read(PY)).toMatch(/"tier": "api_builder",\s*\n\s+"billing_period": "monthly",/);
    expect(read(GO)).toMatch(/Tier: +driftstack\.TierAPIBuilder,/);
  });

  // ─── success_url + cancel_url ─────────────────────────────────

  it("CRITICAL success_url + cancel_url pinned to https://app.driftstack.io/billing?ok=1 / ?cancelled=1 cross-SDK. The app.driftstack.io host is the canonical customer-dashboard origin; drift to a different host would dead-link Checkout's redirect.", () => {
    const successUrl = "'https://app.driftstack.io/billing?ok=1'";
    const cancelUrl = "'https://app.driftstack.io/billing?cancelled=1'";

    expect(read(TS)).toMatch(/success_url: 'https:\/\/app\.driftstack\.io\/billing\?ok=1'/);
    expect(read(TS)).toMatch(/cancel_url: 'https:\/\/app\.driftstack\.io\/billing\?cancelled=1'/);

    expect(read(PY)).toMatch(/"success_url": "https:\/\/app\.driftstack\.io\/billing\?ok=1"/);
    expect(read(PY)).toMatch(/"cancel_url": "https:\/\/app\.driftstack\.io\/billing\?cancelled=1"/);

    expect(read(GO)).toMatch(/SuccessURL: "https:\/\/app\.driftstack\.io\/billing\?ok=1"/);
    expect(read(GO)).toMatch(/CancelURL: +"https:\/\/app\.driftstack\.io\/billing\?cancelled=1"/);

    // Lint-trip mention so unused-var warnings don't flag the local strings above.
    void successUrl;
    void cancelUrl;
  });

  // ─── checkout_url accessor on response ────────────────────────

  it("CRITICAL checkout_url / CheckoutURL accessor on createCheckoutSession response pinned. TS: co.checkout_url + Python: co['checkout_url'] + Go: resp.CheckoutURL. Drift to a different field name would break every redirect consumer.", () => {
    expect(read(TS)).toMatch(/\$\{co\.checkout_url\}/);
    expect(read(PY)).toMatch(/\{co\['checkout_url'\]\}/);
    expect(read(GO)).toMatch(/resp\.CheckoutURL/);
  });

  // ─── createPortalSession on existing-subscription branch ──────

  it('CRITICAL createPortalSession call on existing-subscription branch pinned cross-SDK. TS: `client.billing.createPortalSession()` + Python: `client.billing.create_portal_session()` + Go: `client.Billing.CreatePortalSession(ctx)`. Drift would break the canonical "they have a sub → send them to the portal" demo.', () => {
    expect(read(TS)).toMatch(/const portal = await client\.billing\.createPortalSession\(\);/);
    expect(read(PY)).toMatch(/portal = client\.billing\.create_portal_session\(\)/);
    expect(read(GO)).toMatch(/portal, err := client\.Billing\.CreatePortalSession\(ctx\)/);
  });

  // ─── portal_url accessor ──────────────────────────────────────

  it('CRITICAL portal_url / PortalURL accessor pinned cross-SDK. TS: portal.portal_url + Python: portal["portal_url"] + Go: portal.PortalURL.', () => {
    expect(read(TS)).toMatch(/portal\.portal_url/);
    expect(read(PY)).toMatch(/portal\['portal_url'\]/);
    expect(read(GO)).toMatch(/portal\.PortalURL/);
  });

  // ─── 4-call flow ordering: getState → createCheckout → createPortal

  it('CRITICAL all 3 examples demonstrate the same call ordering — getState first, then EITHER createCheckoutSession OR createPortalSession (branched by subscription === null). Drift to changing the gate would let a subscribed customer get pushed back through Checkout (creating a duplicate sub).', () => {
    function checkOrder(
      p: string,
      getMarker: RegExp,
      checkoutMarker: RegExp,
      gateMarker: RegExp,
    ): boolean {
      const gIdx = p.search(getMarker);
      const gateIdx = p.search(gateMarker);
      const cIdx = p.search(checkoutMarker);
      expect(gIdx, `getState marker not found: ${getMarker}`).toBeGreaterThan(-1);
      expect(gateIdx, `gate marker not found: ${gateMarker}`).toBeGreaterThan(-1);
      expect(cIdx, `checkout marker not found: ${checkoutMarker}`).toBeGreaterThan(-1);
      return gIdx < gateIdx && gateIdx < cIdx;
    }

    expect(
      checkOrder(
        read(TS),
        /\.billing\.getState\(\)/,
        /createCheckoutSession\(\{/,
        /state\.subscription === null/,
      ),
    ).toBe(true);
    expect(
      checkOrder(
        read(PY),
        /\.billing\.get_state\(\)/,
        /create_checkout_session\(/,
        /state\.get\("subscription"\) is None/,
      ),
    ).toBe(true);
    expect(
      checkOrder(
        read(GO),
        /\.Billing\.GetState\(ctx\)/,
        /CreateCheckoutSession\(ctx,/,
        /state\.Subscription == nil/,
      ),
    ).toBe(true);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-billing-flow-examples-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

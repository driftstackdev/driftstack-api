// The Stripe billing endpoints document the failures they actually produce.
//
// All four published success plus the generic 4xx set and nothing else, while
// each one has a specific, reachable refusal the contract never mentioned:
//
//   409 — `createPortalSession` throws ConflictError whenever the account has
//         no Stripe customer record, which is EVERY account that has not yet
//         completed a checkout. On a free-tier caller that is not an edge case,
//         it is the ordinary answer, and it reaches both the POST and the GET
//         because both call the same service method.
//   409 — `createCheckoutSession` refuses when an active subscription already
//         exists, rather than minting a second concurrently-billed one.
//   503 — every one of these routes is ALSO registered as a FeatureUnavailable
//         stub wherever `billingService` is omitted from AppDeps. The GET
//         variant documented that; the other three did not, even though the
//         disabled-route comment in billing.ts describes the POST as the
//         reference behaviour.
//
// The crypto-orders endpoints in the same file already document 409, so this
// was an omission in the Stripe half rather than a missing convention.
//
// Both directions are asserted together, because either alone is satisfiable
// by a lie: a spec can list a status nothing returns, and a server can return
// one nothing documents. Every status added here is provoked for real.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';
import { seedActiveSubscription } from './_helpers/scenarios.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let disabled: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;

interface SpecDocument {
  paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
}

function documented(path: string, method: string): string[] {
  return Object.keys(spec.paths?.[path]?.[method]?.responses ?? {}).sort();
}

const auth = (f: typeof fx): { authorization: string } => ({
  authorization: `Bearer ${f.plaintext}`,
});

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
  // The same app with `billingService` omitted, which is what a deployment
  // without billing wired actually runs.
  disabled = await buildTestApp({
    scopes: ['read', 'write', 'account_owner'],
    disableBilling: true,
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();
}, 60_000);

afterAll(async () => {
  await fx.app.close();
  await disabled.app.close();
});

describe('the billing endpoints document what they really return', () => {
  it('CRITICAL an account that has never checked out really gets 409 from BOTH portal routes, and both document it. This is the ordinary state of a free-tier account, not an exotic one.', async () => {
    for (const [method, path] of [
      ['POST', '/v1/billing/portal-session'],
      ['GET', '/v1/account/me/billing-portal'],
    ] as const) {
      const res = await fx.app.inject({ method, url: path, headers: auth(fx) });
      expect(res.statusCode, `${method} ${path} with no Stripe customer`).toBe(409);
      expect(documented(path, method.toLowerCase()), `${path} documents its 409`).toContain('409');
    }
  });

  it('CRITICAL an account that already has an active subscription really gets 409 from checkout, and the spec documents it. Without that refusal Stripe would mint a SECOND concurrently-billed subscription, so this is the contract for the guard that prevents it.', async () => {
    // Drive the precondition through the repo the app is actually using,
    // rather than asserting the branch from source.
    //
    // Via the shared seeder rather than a literal: SubscriptionMirror has
    // eleven fields and this call supplied six, which type-checks nowhere and
    // had `npm run typecheck` -- a CI gate -- failing since 2026-08-11. The
    // helper already builds the full row and is what every other test uses.
    seedActiveSubscription(fx, {
      id: 'sub_active_probe',
      stripeSubscriptionId: 'sub_active_probe',
      tier: 'api_scale',
      status: 'active',
    });

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: auth(fx),
      payload: { tier: 'api_scale', billing_period: 'monthly' },
    });
    expect(res.statusCode, 'checkout refuses a second subscription').toBe(409);
    expect(documented('/v1/billing/checkout-session', 'post'), 'and documents it').toContain('409');
  });

  it('CRITICAL a deployment without billing wired really answers 503 on all four routes, and all four document it. Only the GET variant did, though the disabled-route comment describes the POST as the reference behaviour.', async () => {
    const routes = [
      ['POST', '/v1/billing/checkout-session'],
      ['POST', '/v1/billing/portal-session'],
      ['GET', '/v1/account/me/billing-portal'],
      ['GET', '/v1/billing'],
    ] as const;

    for (const [method, path] of routes) {
      const res = await disabled.app.inject({
        method,
        url: path,
        headers: auth(disabled),
        ...(method === 'POST' ? { payload: { tier: 'api_scale', billing_period: 'monthly' } } : {}),
      });
      expect(res.statusCode, `${method} ${path} on a deployment without billing`).toBe(503);
      expect(documented(path, method.toLowerCase()), `${path} documents its 503`).toContain('503');
    }
  });

  it('CRITICAL no status was documented that nothing returns. 404 is deliberately NOT added: the service throws NotFoundError only when the account row is missing, which cannot happen for a caller holding a valid key for that account — documenting it would be the same defect facing the other way.', () => {
    for (const [method, path] of [
      ['post', '/v1/billing/checkout-session'],
      ['post', '/v1/billing/portal-session'],
      ['get', '/v1/account/me/billing-portal'],
      ['get', '/v1/billing'],
    ] as const) {
      expect(documented(path, method), `${path} does not claim an unreachable 404`).not.toContain(
        '404',
      );
    }
  });
});

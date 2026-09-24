// The Stripe portal refuses a request made for another member's workspace
// (live-billing audit #5).
//
// `GET /v1/billing` honours the "acting as" header, so a team member viewing the
// owner's workspace sees the OWNER's plan on the billing page. The two portal
// routes ignored the header and opened the portal for the CALLER's own Stripe
// customer — so "Manage / Cancel in Stripe portal", pressed under the owner's
// plan, let the member cancel their OWN plan believing it was the team's.
//
// Both portal routes now refuse a header naming another account, with the same
// refusal crypto checkout uses: the portal is a Self-workspace action. A header
// naming the caller's own account is the Self workspace and is allowed; no
// header works as before; a header naming an account the caller does not
// belong to is refused by the membership resolver, as everywhere else.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const TEAM_OWNER_ID = '00000000-0000-4000-8000-000000000e01';
const TEAM_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000e02';
const STRANGER_ID = '00000000-0000-4000-8000-000000000e03';

type Route = { method: 'POST' | 'GET'; url: string; okStatus: number };
const ROUTES: readonly Route[] = [
  { method: 'POST', url: '/v1/billing/portal-session', okStatus: 200 },
  { method: 'GET', url: '/v1/account/me/billing-portal', okStatus: 302 },
];

describe("the Stripe portal refuses a request made for another member's workspace", () => {
  let fx: TestAppFixture | null = null;

  afterEach(async () => {
    await fx?.cleanup();
    fx = null;
  });

  /** A team member with a Stripe customer of their own. */
  async function memberWithOwnCustomer(): Promise<TestAppFixture> {
    const app = await buildTestApp();
    app.authRepo.setTeamMemberships(app.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'member' },
    ]);
    const checkout = await app.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${app.plaintext}` },
      payload: { tier: 'api_starter', billing_period: 'monthly' },
    });
    expect(checkout.statusCode).toBe(200);
    return app;
  }

  for (const route of ROUTES) {
    it(`CRITICAL ${route.method} ${route.url} refuses a header naming the owner's workspace and opens no portal session`, async () => {
      fx = await memberWithOwnCustomer();
      const res = await fx.app.inject({
        method: route.method,
        url: route.url,
        headers: {
          authorization: `Bearer ${fx.plaintext}`,
          'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
        },
      });

      expect(res.statusCode, "the member's OWN portal opened under the owner's workspace").toBe(
        400,
      );
      expect(res.json<{ detail: string }>().detail).toMatch(/Self workspace/);
      expect(fx.billingProvider.state.portalSessions).toEqual([]);
    });

    it(`CONTROL ${route.method} ${route.url} with no header, or a header naming the caller's own account, opens the caller's portal as before`, async () => {
      fx = await memberWithOwnCustomer();
      const bare = await fx.app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(bare.statusCode).toBe(route.okStatus);

      const self = await fx.app.inject({
        method: route.method,
        url: route.url,
        headers: {
          authorization: `Bearer ${fx.plaintext}`,
          'x-driftstack-account': `acc_${fx.accountId}`,
        },
      });
      expect(self.statusCode).toBe(route.okStatus);
      expect(fx.billingProvider.state.portalSessions).toHaveLength(2);
    });

    it(`${route.method} ${route.url} refuses a header naming an account the caller does not belong to`, async () => {
      fx = await memberWithOwnCustomer();
      const res = await fx.app.inject({
        method: route.method,
        url: route.url,
        headers: {
          authorization: `Bearer ${fx.plaintext}`,
          'x-driftstack-account': `acc_${STRANGER_ID}`,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(fx.billingProvider.state.portalSessions).toEqual([]);
    });
  }
});

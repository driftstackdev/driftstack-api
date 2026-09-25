// Card checkout refuses a request made for another member's workspace
// (security sweep #13).
//
// `GET /v1/billing` honours the "acting as" header, so a member working in the
// owner's workspace sees the OWNER's plan. The two Stripe portal routes and crypto
// checkout refuse that header as a Self-workspace action; card checkout never read
// it. An SDK client configured to act for the owner sends the header on every
// request, so `createCheckoutSession` answered 200 and started a Stripe Checkout —
// for the MEMBER's own account, while the caller believed it was buying the team's
// plan. The member paid and the member's account was upgraded.
//
// Card checkout now refuses the header the way its siblings do, before a Stripe
// customer or session is created. No header, or a header naming the caller's own
// account, works as before; a header naming an account the caller does not belong
// to is refused by the membership resolver.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const TEAM_OWNER_ID = '00000000-0000-4000-8000-000000000c11';
const TEAM_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000c12';
const STRANGER_ID = '00000000-0000-4000-8000-000000000c13';

const PLAN = { tier: 'api_starter', billing_period: 'monthly' } as const;

describe("card checkout refuses a request made for another member's workspace", () => {
  let fx: TestAppFixture | null = null;

  afterEach(async () => {
    await fx?.cleanup();
    fx = null;
  });

  /** An admin member of a team — the role with the most reach into the owner's workspace. */
  async function adminMember(): Promise<TestAppFixture> {
    const app = await buildTestApp();
    app.authRepo.setTeamMemberships(app.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'admin' },
    ]);
    return app;
  }

  it("CRITICAL a header naming the owner's workspace is refused and no Stripe customer or checkout is created", async () => {
    fx = await adminMember();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
      },
      payload: PLAN,
    });

    expect(res.statusCode, "the member's OWN checkout opened under the owner's workspace").toBe(
      400,
    );
    expect(res.json<{ detail: string }>().detail).toMatch(/Self workspace/);
    expect(fx.billingProvider.state.checkoutSessions).toEqual([]);
    expect(fx.billingProvider.state.customers.size).toBe(0);
  });

  it("CONTROL no header, or a header naming the caller's own account, starts the caller's checkout as before", async () => {
    fx = await adminMember();
    const bare = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: PLAN,
    });
    expect(bare.statusCode, bare.body).toBe(200);

    const self = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${fx.accountId}`,
      },
      payload: PLAN,
    });
    expect(self.statusCode, self.body).toBe(200);
    expect(fx.billingProvider.state.checkoutSessions).toHaveLength(2);
  });

  it('a header naming an account the caller does not belong to is refused by the membership check', async () => {
    fx = await adminMember();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${STRANGER_ID}`,
      },
      payload: PLAN,
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(fx.billingProvider.state.checkoutSessions).toEqual([]);
  });
});

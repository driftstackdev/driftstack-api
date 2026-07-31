// Account B cannot reach account A's crypto order.
//
// This resource was MISSED when A2 first called the ownership sweep complete,
// and the correction is the reason this file exists. Six id-taking routes carry
// a customer's financial record — amount, currency, payment id, receipt — and
// disabling the route-level owner check reddened only two tests, one of which
// is a content-parity guard that reds merely because the SOURCE TEXT changed
// rather than because behaviour did. Effectively one real test for six routes.
//
// Worth noting as a measurement hazard generally: content-parity guards inflate
// a mutation count. They red on any edit to the file they pin, so a raw "N
// tests noticed" can overstate behavioural coverage. Read the list, not the
// number.
//
// Ownership here lives in two layers, like every other resource measured: an
// explicit `order.account_id !== ctx.account.id` on the read route, and
// `account_id`-scoped service calls behind the note, cancel and receipt routes.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/** Full rights over B's OWN account, so the scope gate cannot mask ownership. */
const FULL_SCOPES = ['read', 'write', 'account_owner'] as const;

const ORDER_ID = 'ord_ownedbyaaaa';
/** Markers that must never reach the wrong account, even inside an error. */
const A_PRODUCT = 'solo_manual';
const A_PRICE_CENTS = 4299;

const ORDER_ROUTES: ReadonlyArray<{
  method: 'GET' | 'PATCH' | 'POST';
  suffix: string;
  payload?: Record<string, unknown>;
}> = [
  { method: 'GET', suffix: '' },
  { method: 'GET', suffix: '/receipt' },
  { method: 'GET', suffix: '/receipt.txt' },
  { method: 'GET', suffix: '/receipt.pdf' },
  { method: 'PATCH', suffix: '', payload: { customer_note: 'edited by B' } },
  { method: 'POST', suffix: '/cancel', payload: {} },
];

async function seedOrderOwnedByA(fixture: TestAppFixture): Promise<void> {
  await fixture.cryptoOrdersService.create({
    order_id: ORDER_ID,
    account_id: fixture.accountId,
    product: A_PRODUCT,
    price_cents: A_PRICE_CENTS,
    price_currency: 'USD',
  });
}

describe("account B cannot reach account A's crypto order", () => {
  it.each(
    ORDER_ROUTES.map((r) => [`${r.method} /v1/billing/crypto-orders/:id${r.suffix}`, r] as const),
  )(
    'CRITICAL %s refuses an unrelated account. These routes expose a customer’s financial record — amount, currency, payment reference and receipt — and let it be annotated or cancelled.',
    async (_label, route) => {
      fx = await buildTestApp();
      await seedOrderOwnedByA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@order-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });

      const res = await fx.app.inject({
        method: route.method,
        url: `/v1/billing/crypto-orders/${ORDER_ID}${route.suffix}`,
        headers: { authorization: `Bearer ${other.plaintext}` },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });

      expect(
        res.statusCode,
        `${route.method} /v1/billing/crypto-orders/:id${route.suffix} returned ${res.statusCode} for an unrelated account`,
      ).toBe(404);
      // A refusal must not leak the order's contents through its detail either.
      expect(res.body).not.toContain(String(A_PRICE_CENTS));
    },
  );

  it("CRITICAL a foreign note edit does not modify the owner's order. The 404 proves the request was refused; this proves nothing was written before the refusal.", async () => {
    fx = await buildTestApp();
    await seedOrderOwnedByA(fx);
    const other = await seedAdditionalAccount(fx, {
      email: 'b@order-isolation.test',
      tier: 'api_builder',
      scopes: [...FULL_SCOPES],
    });

    await fx.app.inject({
      method: 'PATCH',
      url: `/v1/billing/crypto-orders/${ORDER_ID}`,
      headers: { authorization: `Bearer ${other.plaintext}` },
      payload: { customer_note: 'tampered-by-b' },
    });

    const ownerView = await fx.app.inject({
      method: 'GET',
      url: `/v1/billing/crypto-orders/${ORDER_ID}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(ownerView.statusCode).toBe(200);
    expect(ownerView.body, "the owner's order must be untouched").not.toContain('tampered-by-b');
  });
});

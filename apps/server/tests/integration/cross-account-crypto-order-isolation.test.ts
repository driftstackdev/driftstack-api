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
import { assertCensusSaw, opsUnder } from './_helpers/registered-ops.js';

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
      //
      // Checked against the problem document with `instance` removed rather
      // than the raw body. `instance` is a random request UUID, so its hex can
      // contain any short digit string by chance: a run that drew
      // a01445a4-fdb1-4299-8816-1a9920a4e3e5 red this arm on the very price it
      // exists to protect. Roughly one run in a few thousand, which is worse
      // than a clean failure — a leak detector that cries wolf gets read as
      // noise and then deleted. Every other field is still covered, so a real
      // leak through type/title/detail still fails here.
      const contentType = String(res.headers['content-type'] ?? '');
      let leakSurface = res.body;
      if (contentType.includes('json')) {
        const { instance: _instance, ...problem } = res.json<Record<string, unknown>>();
        leakSurface = JSON.stringify(problem);
      }
      expect(
        leakSurface,
        'the refusal echoed the order’s price back to an account that may not see the order',
      ).not.toContain(String(A_PRICE_CENTS));
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

// ─── the table is no longer allowed to drift ────────────────────────────────
//
// Every table in this family was hand-written, and hand-written tables have gone
// stale three times on record: `/launch` and `/transfer` were absent from the
// profile table because they register in a different FILE, `POST /profiles/:id/
// snapshots` was absent because it APPEARS in an isolation file as fixture setup,
// and five agent-session routes were absent for the reading-the-file reason. This
// table matches its registrations today; the arm is what keeps that true after the
// next route lands, because adding one fails nothing here on its own.
//
// these routes expose a customer’s financial record and let it be annotated or cancelled.
describe('every id-taking route in this family is in the isolation table', () => {
  it('CRITICAL a new /v1/billing/crypto-orders/:order_id route must be added to ORDER_ROUTES, or its ownership check ships untested', async () => {
    // Build our own fixture rather than reusing whatever the previous arm left in
    // `fx`. Reading a closed instance's route tree happens to work, so the
    // order-dependence would not have surfaced as a failure — it would have surfaced
    // as this arm throwing the day someone reordered the file.
    fx = await buildTestApp();
    const registered = opsUnder(
      fx.app.printRoutes({ commonPrefix: false }),
      '/v1/billing/crypto-orders/:order_id',
    );
    // A base path whose parameter name is wrong matches nothing and would pass
    // while checking nothing — the crypto-order routes register `:order_id`, not
    // `:id`, which is exactly the typo this refuses to make silently.
    assertCensusSaw(registered, '/v1/billing/crypto-orders/:order_id', 6);

    const covered = new Set(
      ORDER_ROUTES.map(
        (r) => `${r.method} /v1/billing/crypto-orders/:order_id${r.suffix.split('?')[0] ?? ''}`,
      ),
    );
    const missing = registered.filter((op) => !covered.has(op));
    expect(missing, `these routes have no cross-account arm:\n  ${missing.join('\n  ')}`).toEqual(
      [],
    );
  });
});

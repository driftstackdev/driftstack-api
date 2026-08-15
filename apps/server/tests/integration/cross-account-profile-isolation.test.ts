// Account B cannot reach account A's profile through ANY of its routes.
//
// Companion to `cross-account-session-isolation`. Measured the same way and the
// result was worse: disabling ALL SEVEN account predicates in the profiles repo
// reds exactly ONE test in the entire integration suite — `profile-transfer`,
// which notices incidentally while testing something else. Twelve profile
// routes, and cross-account isolation for the resource that holds a customer's
// saved browser identity rested on that.
//
// The two-predicate lesson from the session suite applies here in a stronger
// form: profiles do not have one ownership check, they have seven. A mutation
// that disables a single one under-reports the boundary, so the measurement
// above disables all of them at once.
//
// 404 rather than 403 is the contract: 403 confirms the profile exists and
// turns any of these routes into an enumeration oracle. Each route is therefore
// also asserted indistinguishable from a well-formed id owned by nobody.

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

/**
 * Account B holds FULL rights over its OWN account. A scope-poor key is refused
 * at the scope gate before ownership is consulted, which would make every case
 * below pass while testing nothing.
 */
const FULL_SCOPES = ['read', 'write', 'account_owner'] as const;

const PROFILE_ROUTES: ReadonlyArray<{
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  suffix: string;
  payload?: Record<string, unknown>;
}> = [
  { method: 'GET', suffix: '' },
  { method: 'PATCH', suffix: '', payload: { name: 'renamed-by-b' } },
  { method: 'GET', suffix: '/export' },
  { method: 'POST', suffix: '/clone', payload: { name: 'cloned-by-b' } },
  { method: 'POST', suffix: '/trim', payload: {} },
  { method: 'DELETE', suffix: '/purge' },
  { method: 'POST', suffix: '/restore', payload: {} },
  // Added 2026-08-15, from enumerating the routes the app actually registers and
  // diffing against this table. Twelve `/v1/profiles/:id…` routes are
  // registered; this list had ten.
  //
  // ⚠️ `/launch` is registered in `routes/sessions.ts`, not `routes/profiles.ts`
  // — which is exactly why reading the profiles route file could never have
  // produced it. A route's PATH decides whether it belongs to this boundary; the
  // file it lives in does not. The same enumeration found two agent-session
  // routes hiding in other files this morning.
  //
  // These two are also the two worst to have missed. `/launch` starts a live
  // browser ON the profile — its cookies, its logged-in sessions, its
  // fingerprint — so a 2xx is not a disclosure of the saved identity, it is USE
  // of it. `/transfer` moves ownership outright.
  //
  // BOTH were confirmed reachable before being trusted, because an arm that
  // 404s for everyone proves nothing: account A's own `/launch` answers 201 and
  // A's own `/transfer` to a real recipient answers 200. So B's 404 is the
  // ownership refusal and not an unwired route.
  //
  // LEDGER — control 20/20, mutating the profile lookup to drop its accountId
  // comparison (the fixture repo's mirror of production's
  // `and(eq(id), eq(accountId))`):
  //
  //   ownership scoping removed   15 red, including all four arms these two
  //                               routes contribute
  //
  // ⚠️ A first attempt at that mutation SURVIVED, and it was the mutation that
  // was wrong rather than the test: dropping `accountId` from the service's
  // findById call passes `undefined`, which the lookup compares and still
  // misses, so the "unscoped" version behaved identically. A mutation has to
  // actually grant the access it claims to grant before its survival means
  // anything.
  { method: 'POST', suffix: '/launch', payload: { label: 'launched-by-b' } },
  {
    method: 'POST',
    suffix: '/transfer',
    // Filled per-test with B's own account id — see TRANSFER_TO_B.
    // Filled per-test by payloadFor — see the note there.
    payload: { recipient_account_id: 'filled-per-test' },
  },
];

/**
 * The transfer probe needs a recipient that gets PAST validation, or it never
 * reaches the ownership check at all.
 *
 * ⚠️ Measured, because the obvious choice is wrong. The natural attack is B
 * naming its OWN account as recipient — steal the profile outright — and that
 * returns 400, not 404: the route refuses a self-transfer
 * (`recipientId === sourceAccountId`) before it ever looks up the source
 * profile, and under B's credential the source account IS B. So the probe would
 * have reported a refusal it never tested, the same trap as probing with an id
 * that was never created.
 *
 * Naming A as the recipient clears every earlier check — recipient differs from
 * the source, and the account exists — so the only thing left to refuse the
 * request is B not owning the profile. That is the check under test. It is also
 * still a real attack: moving another customer's profile anywhere, even to its
 * own owner, is a write B must not have.
 */
function payloadFor(
  route: { suffix: string; payload?: Record<string, unknown> },
  ownerAccountId: string,
): Record<string, unknown> | undefined {
  return route.suffix === '/transfer'
    ? { recipient_account_id: `acc_${ownerAccountId}` }
    : route.payload;
}

async function createProfileForAccountA(fixture: TestAppFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/profiles',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: { name: 'owned-by-a' },
  });
  expect(res.statusCode, 'account A must be able to create its own profile').toBe(200);
  return res.json<{ id: string }>().id;
}

/** Well-formed but owned by nobody, derived so it cannot fail id-format checks. */
function nonexistentLike(realId: string): string {
  const last = realId.slice(-1);
  return `${realId.slice(0, -1)}${last === '0' ? '1' : '0'}`;
}

const mask = (body: string): string =>
  body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID');

describe("account B cannot reach account A's profile on any route", () => {
  it.each(PROFILE_ROUTES.map((r) => [`${r.method} /v1/profiles/:id${r.suffix}`, r] as const))(
    'CRITICAL %s returns 404 for a different account. A 2xx here hands one customer another customer’s saved browser identity; a 403 confirms the profile exists and makes the route an enumeration oracle.',
    async (_label, route) => {
      fx = await buildTestApp({ tier: 'api_builder' });
      const profileId = await createProfileForAccountA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@profile-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });

      const res = await fx.app.inject({
        method: route.method,
        url: `/v1/profiles/${profileId}${route.suffix}`,
        headers: { authorization: `Bearer ${other.plaintext}` },
        ...(route.payload === undefined ? {} : { payload: payloadFor(route, fx.accountId) }),
      });

      expect(
        res.statusCode,
        `${route.method} /v1/profiles/:id${route.suffix} returned ${res.statusCode} for a foreign account`,
      ).toBe(404);
    },
  );

  it.each(PROFILE_ROUTES.map((r) => [`${r.method} /v1/profiles/:id${r.suffix}`, r] as const))(
    '%s is INDISTINGUISHABLE from a nonexistent id, so the 404 leaks nothing',
    async (_label, route) => {
      fx = await buildTestApp({ tier: 'api_builder' });
      const profileId = await createProfileForAccountA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@profile-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });

      const call = (id: string): Promise<{ statusCode: number; body: string }> =>
        fx.app
          .inject({
            method: route.method,
            url: `/v1/profiles/${id}${route.suffix}`,
            headers: { authorization: `Bearer ${other.plaintext}` },
            ...(route.payload === undefined ? {} : { payload: payloadFor(route, fx.accountId) }),
          })
          .then((r) => ({ statusCode: r.statusCode, body: r.body }));

      const foreign = await call(profileId);
      const missing = await call(nonexistentLike(profileId));

      expect(foreign.statusCode).toBe(missing.statusCode);
      expect(mask(foreign.body)).toBe(mask(missing.body));
    },
  );
});

/**
 * Three routes answer a foreign reference with something other than 404, and
 * each was verified to be safe rather than assumed:
 *
 *  - `DELETE /v1/profiles/:id` returns 204 whether or not the caller owns the
 *    profile. It is an idempotent no-op — the owner can still read the profile
 *    afterwards, which is the assertion below. Nothing is destroyed.
 *  - `GET /v1/profiles/:id/snapshots` returns 200 with an EMPTY page for a
 *    profile the caller does not own. No snapshot data crosses accounts.
 *  - `POST /v1/profiles/:id/snapshots` validates its body before consulting
 *    ownership, so it answers 400 first.
 *
 * All three are indistinguishable from a well-formed id owned by nobody, so
 * none of them is an enumeration oracle. They are asserted on the property that
 * actually matters — no effect and no data — rather than on a status code the
 * product does not promise.
 */
describe('routes whose foreign-reference contract is not 404 are still safe', () => {
  it('CRITICAL a foreign DELETE does NOT destroy the profile. The 204 is idempotent-delete semantics, not a successful deletion — if this ever regressed, one customer could wipe another customer’s saved browser identity and receive a success code for it.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const profileId = await createProfileForAccountA(fx);
    const other = await seedAdditionalAccount(fx, {
      email: 'b@profile-isolation.test',
      tier: 'api_builder',
      scopes: [...FULL_SCOPES],
    });

    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${profileId}`,
      headers: { authorization: `Bearer ${other.plaintext}` },
    });

    const ownerRead = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles/${profileId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(ownerRead.statusCode, "the owner's profile must survive a foreign delete").toBe(200);
  });

  it('CRITICAL a foreign snapshot listing is NOT FOUND, and carries no rows. This used to answer 200 with an empty page — safe, but it confirmed the profile existed, and this test said so: "a 200 is acceptable only because the page is empty". The parent is now resolved account-scoped before anything is listed, so a foreign id is indistinguishable from one that was never created. Both halves are asserted: the status, and the absence of any row in the body.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const profileId = await createProfileForAccountA(fx);
    const other = await seedAdditionalAccount(fx, {
      email: 'b@profile-isolation.test',
      tier: 'api_builder',
      scopes: [...FULL_SCOPES],
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles/${profileId}/snapshots`,
      headers: { authorization: `Bearer ${other.plaintext}` },
    });
    expect(res.statusCode, 'a foreign profile id must not resolve').toBe(404);
    // The status is the new half; this is the original guarantee and it still
    // has to hold. Asserting only the 404 would stop checking the body, which
    // is where a leak would actually appear.
    expect(
      res.json<{ data?: unknown[] }>().data ?? [],
      'no snapshot may cross an account boundary',
    ).toEqual([]);
  });
});

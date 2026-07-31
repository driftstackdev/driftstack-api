// Account B cannot reach account A's saved proxy.
//
// Measured like the other resources: disabling the account predicate in the
// proxies repo lookup reds exactly TWO tests, and both are unit tests of the
// repo and service. Nothing exercised the ROUTE boundary, so a regression in
// the routes — the layer a customer actually reaches — would have gone unseen.
//
// This resource is worth the attention. A saved proxy carries the customer's
// own egress credentials: host, port, username and a write-only password
// wrapped under their account key. Handing one to another account hands over
// paid third-party infrastructure and whatever that proxy can reach.
//
// The password is never echoed back by design, so the strongest assertion here
// is not only "404" but "no proxy field crosses the boundary at all".
//
// Proxies enforce ownership in THREE places, not one: the `findById` lookup,
// the update path and the delete path. Disabling only `findById` reds 2 of the
// 4 cases below, which looks like half the file is vacuous — it is not, the
// other two are held by the predicates it did not touch. Disabling all three
// reds 4 of 4. Third resource in a row where a single-line mutation
// under-reports its own boundary, so mutate the SET, not a line.

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

/** A marker that must never appear in a response to the wrong account. */
const A_PROXY_LABEL = 'a-secret-egress-label';
const A_PROXY_HOST = 'proxy-owned-by-a.internal.test';

const PROXY_ROUTES: ReadonlyArray<{
  method: 'PUT' | 'DELETE' | 'POST';
  suffix: string;
  payload?: Record<string, unknown>;
}> = [
  {
    method: 'PUT',
    suffix: '',
    payload: {
      scheme: 'socks5',
      label: 'renamed-by-b',
      host: 'attacker.test',
      port: 1080,
      username: null,
      password: null,
    },
  },
  { method: 'DELETE', suffix: '' },
  { method: 'POST', suffix: '/test', payload: {} },
];

async function createProxyForAccountA(fixture: TestAppFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: {
      scheme: 'socks5',
      label: A_PROXY_LABEL,
      host: A_PROXY_HOST,
      port: 1080,
      username: 'a-user',
      password: 'a-password',
    },
  });
  expect(
    [200, 201],
    `proxy create returned ${res.statusCode}: ${res.body.slice(0, 200)}`,
  ).toContain(res.statusCode);
  return res.json<{ id: string }>().id;
}

describe("account B cannot reach account A's saved proxy", () => {
  it.each(
    PROXY_ROUTES.map((r) => [`${r.method} /v1/account/me/proxies/:id${r.suffix}`, r] as const),
  )(
    'CRITICAL %s refuses an unrelated account. A saved proxy is the customer’s own paid egress credential; a 2xx here lets one customer use, alter or delete another customer’s infrastructure.',
    async (_label, route) => {
      fx = await buildTestApp({ tier: 'api_builder' });
      const proxyId = await createProxyForAccountA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@proxy-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });

      const res = await fx.app.inject({
        method: route.method,
        url: `/v1/account/me/proxies/${proxyId}${route.suffix}`,
        headers: { authorization: `Bearer ${other.plaintext}` },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });

      expect(
        res.statusCode,
        `${route.method} /v1/account/me/proxies/:id${route.suffix} returned ${res.statusCode} for an unrelated account`,
      ).toBe(404);
      // Even a refusal must not echo the owner's proxy back in its detail.
      expect(res.body).not.toContain(A_PROXY_LABEL);
      expect(res.body).not.toContain(A_PROXY_HOST);
    },
  );

  it("CRITICAL a foreign PUT does not overwrite the owner's proxy. The 404 above proves the request is refused; this proves nothing was written before the refusal.", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const proxyId = await createProxyForAccountA(fx);
    const other = await seedAdditionalAccount(fx, {
      email: 'b@proxy-isolation.test',
      tier: 'api_builder',
      scopes: [...FULL_SCOPES],
    });

    await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${proxyId}`,
      headers: { authorization: `Bearer ${other.plaintext}` },
      payload: {
        scheme: 'socks5',
        label: 'hijacked',
        host: 'attacker.test',
        port: 1080,
        username: null,
        password: null,
      },
    });

    const ownerView = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(ownerView.statusCode).toBe(200);
    expect(ownerView.body, "the owner's proxy must be untouched").toContain(A_PROXY_LABEL);
    expect(ownerView.body).not.toContain('attacker.test');
  });
});

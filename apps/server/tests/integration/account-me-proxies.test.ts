// ARC A slice 2 — integration tests for the /v1/account/me/proxies CRUD surface.
//
// Verifies the customer-facing contract + the security invariants that matter at
// the API edge: the password is WRITE-ONLY (never echoed — responses carry
// has_password), the routes are account_owner-scoped (403 otherwise), and a
// proxy is addressable only within its own account (404 on unknown id; the
// repo-level cross-account isolation is unit-tested separately).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface ProxyMeta {
  id: string;
  label: string;
  scheme: string;
  host: string;
  port: number;
  username: string | null;
  has_password: boolean;
  created_at: string;
  updated_at: string;
}

describe('POST/GET /v1/account/me/proxies', () => {
  it('creates a proxy and lists it — password is NEVER echoed (has_password instead)', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'home', host: '1.2.3.4', port: 1080, username: 'u', password: 'hunter2' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<ProxyMeta>();
    expect(created.id).toBeTruthy();
    expect(created.scheme).toBe('socks5'); // default
    expect(created.has_password).toBe(true);
    // The plaintext password must not appear anywhere in the response.
    expect(create.body).not.toContain('hunter2');
    expect(created).not.toHaveProperty('password');
    expect(created).not.toHaveProperty('wrapped_password');

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ data: ProxyMeta[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.host).toBe('1.2.3.4');
    expect(list.body).not.toContain('hunter2');
  });

  it('a proxy with no password has has_password=false', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'open', host: 'p.example', port: 8080, scheme: 'http' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json<ProxyMeta>().has_password).toBe(false);
    expect(create.json<ProxyMeta>().scheme).toBe('http');
  });
});

describe('PUT /v1/account/me/proxies/:id', () => {
  it('updates fields; omitting password keeps it, null clears it', async () => {
    fx = await buildTestApp();
    const created = (
      await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { label: 'a', host: 'h', port: 1080, password: 'secret' },
      })
    ).json<ProxyMeta>();

    // Omit password → kept (still has_password).
    const renamed = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<ProxyMeta>().label).toBe('renamed');
    expect(renamed.json<ProxyMeta>().has_password).toBe(true);

    // Explicit null → cleared.
    const cleared = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { password: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<ProxyMeta>().has_password).toBe(false);
  });

  it('404 on unknown id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/proxies/00000000-0000-0000-0000-000000000000',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/account/me/proxies/:id', () => {
  it('deletes an owned proxy (204) then 404 on re-delete', async () => {
    fx = await buildTestApp();
    const created = (
      await fx.app.inject({
        method: 'POST',
        url: '/v1/account/me/proxies',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { label: 'a', host: 'h', port: 1080 },
      })
    ).json<ProxyMeta>();
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);
    const again = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/account/me/proxies/${created.id}`,
      headers: auth(fx),
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('account_owner scope', () => {
  it('403 when the key lacks account_owner scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});

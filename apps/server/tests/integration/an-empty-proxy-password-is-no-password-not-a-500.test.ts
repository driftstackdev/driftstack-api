// One clause in `wrapProxyPassword` is all that stands between an empty-string proxy
// password and a 500.
//
// Found by carrying the recipe-label defect forward as a class rather than an incident.
// That one was: a bound enforced at two layers, agreeing on the NUMBER, where the outer
// layer counted raw characters and the inner one trimmed first — so a value the route
// accepted reached a bare `throw new Error(...)` and became an internal server error.
//
// The mechanism generalises to "a validation-shaped `throw new Error` in a layer a route
// calls into". Censused: 431 bare throws in apps/server/src, 50 whose message reads like
// input validation. Most are internal invariants — migration batch sizes, key lengths,
// boot config — but four sit on the customer-supplied proxy path, and this is the one
// that is genuinely reachable:
//
//   packages/api-types  `password: z.string().max(1024).nullable().default(null)`
//                       — no `.min(1)`, so "" is a valid password as far as the route
//                       schema is concerned.
//   lib/account-proxy-secret-encryption.ts
//                       `if (value.length < 1 || value.length > 1024) throw new Error(
//                        'Account proxy password must contain 1-1024 characters.')`
//
// Between them, `wrapProxyPassword` in routes/account-me.ts:
//
//   if (password === null || password.length === 0) return null;
//
// `password.length === 0` is the whole defence. Delete it and an empty string reaches the
// encryptor, which throws a bare Error, which is a 500 — for a customer who left the
// password field blank in a form that posts "" rather than omitting the key. Nothing in
// the suite posted an empty password, so nothing would have noticed.
//
// ⚠️ Measured before writing, and the first hypothesis was WRONG. I expected the 500 to
// already be live; it is not — the coercion is there and works. Two other candidates on
// the same path were checked and are unreachable: the route's zod bounds host to
// `min(1).max(255)` and port to `int().min(1).max(65535)`, both strictly tighter than the
// socks5 backend's own `host must be non-empty` / `port in [1, 65535]` throws. Layered
// validation is safe exactly while the outer layer is strictly tighter, and here it is.
//
// So this pins the clause that makes it safe, on BOTH paths that call it — create and
// update — because one-of-two is how a shared coercion half-disappears.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  fx = await buildTestApp({ tier: 'api_builder' });
}, 120_000);

afterAll(async () => {
  await fx.cleanup();
});

function createProxy(overrides: Record<string, unknown>): Promise<{
  statusCode: number;
  body: string;
  json: <T>() => T;
}> {
  return fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: {
      label: `p-${randomUUID().slice(0, 8)}`,
      scheme: 'socks5',
      host: 'proxy.example.com',
      port: 1080,
      username: 'u',
      ...overrides,
    },
  });
}

describe('an empty proxy password is no password, not a 500', () => {
  it('CRITICAL a real password is stored, so the arms below distinguish "coerced to none" from "the route never stores one". Without this every has_password:false assertion would pass on a route that had stopped wrapping passwords entirely.', async () => {
    const res = await createProxy({ password: 'a-real-secret' });
    expect(res.statusCode, `create with a real password failed: ${res.body}`).toBe(201);
    expect(
      res.json<{ has_password: boolean }>().has_password,
      'a real password was not stored',
    ).toBe(true);
  });

  it('CRITICAL an EMPTY password answers 201 with has_password:false, never a 5xx. The route schema has no `.min(1)`, so "" is valid input; the encryptor refuses it with a bare Error that becomes a 500. One clause in wrapProxyPassword — `password.length === 0` — turns that into "no password", and nothing had ever sent the value it exists for.', async () => {
    const res = await createProxy({ password: '' });
    expect(res.statusCode, `an empty password produced ${res.statusCode}: ${res.body}`).toBe(201);
    expect(
      res.json<{ has_password: boolean }>().has_password,
      'an empty password was stored as a password',
    ).toBe(false);
  });

  it('CRITICAL an explicit null password is also no password. `null` and `""` arrive from different clients — an SDK omitting the field versus a form posting a blank input — and both have to land on the same behaviour, because the difference is invisible to the person filling in the form.', async () => {
    const res = await createProxy({ password: null });
    expect(res.statusCode, `a null password produced ${res.statusCode}: ${res.body}`).toBe(201);
    expect(res.json<{ has_password: boolean }>().has_password).toBe(false);
  });

  it('CRITICAL the UPDATE path coerces an empty password too. It calls the same helper, which is exactly why one-of-two matters: a shared coercion that half-disappears leaves one route answering 500 while the other keeps working, and the difference shows up as "it fails when I edit it, not when I create it".', async () => {
    const created = await createProxy({ password: 'initial-secret' });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const res = await fx.app.inject({
      method: 'PUT',
      url: `/v1/account/me/proxies/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        scheme: 'socks5',
        label: 'renamed',
        host: 'proxy.example.com',
        port: 1080,
        username: 'u',
        password: '',
      },
    });
    expect(
      res.statusCode,
      `an empty password on update produced ${res.statusCode}: ${res.body}`,
    ).toBeLessThan(500);
  });

  it('CRITICAL a password at the 1024 bound is accepted and 1025 is a 400, not a 500. The two layers agree on 1024 today, which is what keeps the over-long case a clean validation failure — the encryptor refuses >1024 with the same bare Error, so the moment the route bound is raised above it, one character too many becomes an internal server error.', async () => {
    const atBound = await createProxy({ password: 'p'.repeat(1024) });
    expect(atBound.statusCode, `a 1024-character password was refused: ${atBound.body}`).toBe(201);

    const over = await createProxy({ password: 'p'.repeat(1025) });
    expect(
      over.statusCode,
      `a 1025-character password produced ${over.statusCode}: ${over.body}`,
    ).toBe(400);
  });
});

// C1 — device-key deny-gate integration tests.
//
// A key minted by the cli-authorize device-code flow carries
// provenance='cli_device'. The central deny-gate (middleware/
// device-key-deny.ts) bars such a key from the account-takeover /
// persistence / exfil routes while leaving the desktop client's genuine
// device-need routes untouched. These tests mint a REAL device key
// through the full flow (which also proves the mint stamps the
// provenance and that bind requires a web session), then drive the gate
// behaviorally:
//   - a device key 403s on EVERY deny-set route (concrete path → Fastify
//     resolves the template → the gate fires; a typo'd template would
//     silently fail open and this catches it),
//   - a normal account_owner key never gets the device-key 403,
//   - a device key is NOT denied on representative device-need routes,
//   - /bind rejects API-key auth (web-session-only), and
//   - the deny-set is disjoint from the known device-need templates.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { DEVICE_KEY_DENY_ROUTES } from '../../src/middleware/device-key-deny.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const json = { 'content-type': 'application/json' };
const STATE = 'device-deny-state-1234567890abcdef';

interface SignupResponse {
  debug_token: string;
}
interface SessionResponse {
  session: { token: string; account_id: string };
}

async function freshSession(f: TestAppFixture): Promise<{ token: string; accountId: string }> {
  const email = `dk-${Date.now().toString()}-${Math.random().toString(36).slice(2)}@example.test`;
  const signup = await f.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: json,
    payload: { email, password: 'correct horse battery staple' },
  });
  const { debug_token } = signup.json<SignupResponse>();
  const verify = await f.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    headers: json,
    payload: { token: debug_token },
  });
  const { session } = verify.json<SessionResponse>();
  return { token: session.token, accountId: session.account_id };
}

async function acceptAllLegal(f: TestAppFixture, sessionToken: string): Promise<void> {
  const docs = await f.app.inject({
    method: 'GET',
    url: '/v1/legal/documents',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const body = docs.json<{
    data: Array<{ document_key: string; version: string; content_hash: string }>;
  }>();
  for (const doc of body.data) {
    await f.app.inject({
      method: 'POST',
      url: '/v1/legal/accept',
      headers: { ...json, authorization: `Bearer ${sessionToken}` },
      payload: {
        document_key: doc.document_key,
        version: doc.version,
        content_hash: doc.content_hash,
      },
    });
  }
}

/** Mint a REAL device key by walking initiate → bind (web session) →
 *  exchange, and a sibling ordinary account_owner key via POST
 *  /v1/api-keys. Returns both plaintexts + the web-session token. */
async function setup(
  f: TestAppFixture,
): Promise<{ deviceKey: string; ordinaryKey: string; sessionToken: string }> {
  const { token } = await freshSession(f);
  await acceptAllLegal(f, token);

  const initiate = await f.app.inject({
    method: 'POST',
    url: '/v1/auth/cli-authorize/initiate',
    headers: json,
    payload: { state: STATE, client_label: 'Test device' },
  });
  const { code } = initiate.json<{ code: string }>();

  const bind = await f.app.inject({
    method: 'POST',
    url: '/v1/auth/cli-authorize/bind',
    headers: { ...json, authorization: `Bearer ${token}` },
    payload: { code, state: STATE },
  });
  expect(bind.statusCode, `bind failed: ${bind.body}`).toBe(200);

  const exchange = await f.app.inject({
    method: 'POST',
    url: '/v1/auth/cli-authorize/exchange',
    headers: json,
    payload: { code, state: STATE },
  });
  const ex = exchange.json<{ status: string; api_key?: string }>();
  expect(ex.status).toBe('bound');
  const deviceKey = ex.api_key as string;

  // A sibling ORDINARY account_owner key (minted via a web session, so
  // provenance is null) — the control that must NOT be deny-gated.
  const created = await f.app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { ...json, authorization: `Bearer ${token}` },
    payload: { name: 'ordinary', scopes: ['account_owner'] },
  });
  expect(created.statusCode, `api-key mint failed: ${created.body}`).toBe(201);
  const ordinaryKey = created.json<{ plaintext: string }>().plaintext;

  return { deviceKey, ordinaryKey, sessionToken: token };
}

// Every deny template → a concrete, injectable request. Fastify resolves
// the concrete path back to the registered template, which is what the
// gate matches on.
const DENY_REQUESTS: Array<{ method: string; url: string; template: string }> = [
  { method: 'POST', url: '/v1/api-keys', template: 'POST:/v1/api-keys' },
  { method: 'DELETE', url: '/v1/api-keys/key_x', template: 'DELETE:/v1/api-keys/:id' },
  { method: 'POST', url: '/v1/api-keys/key_x/rotate', template: 'POST:/v1/api-keys/:id/rotate' },
  {
    method: 'POST',
    url: '/v1/auth/cli-authorize/bind',
    template: 'POST:/v1/auth/cli-authorize/bind',
  },
  { method: 'POST', url: '/v1/account/mfa/enroll', template: 'POST:/v1/account/mfa/enroll' },
  { method: 'POST', url: '/v1/account/mfa/verify', template: 'POST:/v1/account/mfa/verify' },
  { method: 'DELETE', url: '/v1/account/mfa', template: 'DELETE:/v1/account/mfa' },
  { method: 'POST', url: '/v1/account/mfa/disable', template: 'POST:/v1/account/mfa/disable' },
  {
    method: 'POST',
    url: '/v1/account/mfa/recovery-codes/regenerate',
    template: 'POST:/v1/account/mfa/recovery-codes/regenerate',
  },
  { method: 'POST', url: '/v1/team/invites', template: 'POST:/v1/team/invites' },
  { method: 'DELETE', url: '/v1/team/members/mem_x', template: 'DELETE:/v1/team/members/:id' },
  {
    method: 'POST',
    url: '/v1/billing/checkout-session',
    template: 'POST:/v1/billing/checkout-session',
  },
  {
    method: 'POST',
    url: '/v1/billing/portal-session',
    template: 'POST:/v1/billing/portal-session',
  },
  {
    method: 'GET',
    url: '/v1/account/me/billing-portal',
    template: 'GET:/v1/account/me/billing-portal',
  },
  { method: 'POST', url: '/v1/webhooks', template: 'POST:/v1/webhooks' },
  { method: 'PATCH', url: '/v1/webhooks/wh_x', template: 'PATCH:/v1/webhooks/:id' },
  { method: 'DELETE', url: '/v1/webhooks/wh_x', template: 'DELETE:/v1/webhooks/:id' },
  {
    method: 'POST',
    url: '/v1/webhooks/wh_x/rotate-secret',
    template: 'POST:/v1/webhooks/:id/rotate-secret',
  },
  {
    method: 'POST',
    url: '/v1/webhook-deliveries/del_x/replay',
    template: 'POST:/v1/webhook-deliveries/:deliveryId/replay',
  },
  {
    method: 'PUT',
    url: '/v1/account/me/byok-anthropic-key',
    template: 'PUT:/v1/account/me/byok-anthropic-key',
  },
  {
    method: 'DELETE',
    url: '/v1/account/me/byok-anthropic-key',
    template: 'DELETE:/v1/account/me/byok-anthropic-key',
  },
  {
    method: 'POST',
    url: '/v1/account/me/byok-anthropic-key/test',
    template: 'POST:/v1/account/me/byok-anthropic-key/test',
  },
  {
    method: 'DELETE',
    url: '/v1/account/web-sessions',
    template: 'DELETE:/v1/account/web-sessions',
  },
  {
    method: 'DELETE',
    url: '/v1/account/web-sessions/sess_x',
    template: 'DELETE:/v1/account/web-sessions/:id',
  },
];

function isDeviceDenied(res: { statusCode: number; body: string }): boolean {
  if (res.statusCode !== 403) return false;
  try {
    const b = JSON.parse(res.body) as { detail?: string };
    return typeof b.detail === 'string' && b.detail.includes('device-provisioned key');
  } catch {
    return false;
  }
}

describe('C1 device-key deny-gate — every deny-set route 403s a device key', () => {
  it('the request table covers exactly the deny-set (no drift)', () => {
    const covered = new Set(DENY_REQUESTS.map((r) => r.template));
    // Every configured deny route must be exercised by the table, and the
    // table must not exercise anything outside the deny-set.
    expect([...DEVICE_KEY_DENY_ROUTES].sort()).toEqual([...covered].sort());
  });

  for (const req of DENY_REQUESTS) {
    it(`device key → ${req.template} → 403`, async () => {
      fx = await buildTestApp();
      const { deviceKey } = await setup(fx);
      const res = await fx.app.inject({
        method: req.method as 'GET',
        url: req.url,
        headers: { ...json, authorization: `Bearer ${deviceKey}` },
        payload: {},
      });
      expect(
        isDeviceDenied(res),
        `${req.template} did not 403 the device key (status ${res.statusCode}: ${res.body}) — the deny template may not match the registered route (fail-open).`,
      ).toBe(true);
    });
  }
});

describe('C1 device-key deny-gate — ordinary account_owner key is never device-denied', () => {
  for (const req of DENY_REQUESTS.filter((r) =>
    // A representative route per deny class (keep this test fast).
    [
      'POST:/v1/api-keys',
      'POST:/v1/account/mfa/enroll',
      'POST:/v1/team/invites',
      'POST:/v1/billing/checkout-session',
      'POST:/v1/webhooks',
      'PUT:/v1/account/me/byok-anthropic-key',
      'DELETE:/v1/account/web-sessions',
    ].includes(r.template),
  )) {
    it(`ordinary key → ${req.template} → not the device 403`, async () => {
      fx = await buildTestApp();
      const { ordinaryKey } = await setup(fx);
      const res = await fx.app.inject({
        method: req.method as 'GET',
        url: req.url,
        headers: { ...json, authorization: `Bearer ${ordinaryKey}` },
        payload: {},
      });
      // The ordinary key may still fail for OTHER reasons (400/404/402),
      // but it must never hit the device-provisioned 403.
      expect(isDeviceDenied(res)).toBe(false);
    });
  }
});

describe('C1 device-key deny-gate — device-need routes stay open to a device key', () => {
  const DEVICE_NEED: Array<{ method: string; url: string }> = [
    { method: 'GET', url: '/v1/account/me' },
    { method: 'GET', url: '/v1/webhooks' }, // READ allowed (only writes are denied)
    { method: 'POST', url: '/v1/account/me/proxies' }, // account_owner-gated device write
    { method: 'GET', url: '/v1/agent-sessions' },
  ];
  for (const r of DEVICE_NEED) {
    it(`device key → ${r.method} ${r.url} → not device-denied`, async () => {
      fx = await buildTestApp();
      const { deviceKey } = await setup(fx);
      const res = await fx.app.inject({
        method: r.method as 'GET',
        url: r.url,
        headers: { ...json, authorization: `Bearer ${deviceKey}` },
        payload: {},
      });
      expect(
        isDeviceDenied(res),
        `${r.method} ${r.url} wrongly device-denied (${res.statusCode}: ${res.body}) — the deny-gate must not touch device-need routes.`,
      ).toBe(false);
    });
  }
});

describe('C1 — /bind requires an interactive web session (self-mint laundering closed)', () => {
  it('an API-key-authed bind is rejected 403', async () => {
    fx = await buildTestApp();
    const { ordinaryKey } = await setup(fx);
    const initiate = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers: json,
      payload: { state: STATE },
    });
    const { code } = initiate.json<{ code: string }>();
    const bind = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/bind',
      headers: { ...json, authorization: `Bearer ${ordinaryKey}` },
      payload: { code, state: STATE },
    });
    expect(bind.statusCode).toBe(403);
    expect(bind.body).toContain('interactive dashboard session');
  });
});

describe('C1 — deny-set never overlaps a known device-need route', () => {
  it('is disjoint from the gui-client device-need templates', () => {
    const DEVICE_NEED_TEMPLATES = [
      'GET:/v1/account/me',
      'GET:/v1/webhooks',
      'POST:/v1/account/me/proxies',
      'PUT:/v1/account/me/organization',
      'PATCH:/v1/account/me/bundled-llm-settings',
      'POST:/v1/billing/crypto-checkout',
      'POST:/v1/billing/crypto-orders/:id/cancel',
      'GET:/v1/agent-sessions',
      'POST:/v1/agent-sessions',
      'GET:/v1/profiles',
    ];
    for (const t of DEVICE_NEED_TEMPLATES) {
      expect(DEVICE_KEY_DENY_ROUTES.has(t), `${t} must NOT be in the deny-set`).toBe(false);
    }
  });
});

// GUI audit #11 (MED) — Free desktop keys were refused on two routes the desktop
// app calls on every launch, and both refusals were swallowed:
//   · GET /v1/account/me/proxies — the proxy-list read behind ProxiesView and
//     Profiles, so server readings were never adopted;
//   · PATCH /v1/account/me — onboarding completion, so it was re-sent on every
//     launch and never recorded.
//
// Both are now on the Free desktop allowlist. The proxy Test route is NOT: the
// server-side tunnel test is a paid feature that spends resources, so a Free
// desktop key stays refused there and the desktop app changes its copy.
//
// Opening PATCH /v1/account/me to the device credential must not let it change
// anything a Free account may not. The route's body schema is name / timezone /
// slug / region / onboarding_completed — nothing else is read — and it always
// writes the CALLER's own account, never the workspace named by
// X-Driftstack-Account. Both are pinned below against the real route.

import { afterEach, describe, expect, it } from 'vitest';
import { FREE_DESKTOP_ROUTE_DENIED_DETAIL } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWNER_ID = '00000000-0000-4000-8000-00000000f311';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-00000000f312';

let fx: TestAppFixture | undefined;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = undefined;
});

async function freeDesktop(): Promise<TestAppFixture> {
  return buildTestApp({
    tier: 'free',
    keyProvenance: 'cli_device',
    // What the device-code mint grants (auth-cli.ts DEFAULT_SCOPES).
    scopes: ['account_owner'],
  });
}

const bearer = (f: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${f.plaintext}`,
});

function isFreeDesktopDenied(res: { statusCode: number; body: string }): boolean {
  if (res.statusCode !== 403) return false;
  return (JSON.parse(res.body) as { detail?: string }).detail === FREE_DESKTOP_ROUTE_DENIED_DETAIL;
}

interface AccountMe {
  id: string;
  email: string;
  name: string | null;
  tier: string;
  status: string;
  onboarding_completed_at: string | null;
}

async function me(f: TestAppFixture): Promise<AccountMe> {
  const res = await f.app.inject({ method: 'GET', url: '/v1/account/me', headers: bearer(f) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AccountMe>();
}

describe('a Free desktop key on the routes the desktop app calls at launch', () => {
  it('CRITICAL reads its saved proxies (GET /v1/account/me/proxies answers, not 403)', async () => {
    fx = await freeDesktop();
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: bearer(fx),
      payload: { label: 'home', host: '1.2.3.4', port: 1080, username: 'u', password: 'hunter2' },
    });
    expect(created.statusCode, created.body).toBe(201);

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/proxies',
      headers: bearer(fx),
    });

    expect(isFreeDesktopDenied(res), res.body).toBe(false);
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json<{ data: Array<{ label: string; has_password: boolean }> }>().data;
    expect(rows.map((r) => r.label)).toEqual(['home']);
    // The list is metadata: a password is only ever reported as present or not.
    expect(rows[0]?.has_password).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });

  it('CRITICAL records onboarding completion (PATCH /v1/account/me answers, and the next launch reads it back)', async () => {
    fx = await freeDesktop();
    expect((await me(fx)).onboarding_completed_at).toBeNull();

    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: bearer(fx),
      payload: { onboarding_completed: true },
    });

    expect(isFreeDesktopDenied(res), res.body).toBe(false);
    expect(res.statusCode, res.body).toBe(200);
    expect((await me(fx)).onboarding_completed_at).not.toBeNull();
  });

  it('CRITICAL the PATCH cannot change the tier, the email or the status — fields outside its schema are not applied', async () => {
    fx = await freeDesktop();
    const before = await me(fx);
    expect(before.tier).toBe('free');

    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: bearer(fx),
      payload: {
        name: 'Renamed',
        tier: 'api_scale',
        email: 'someone-else@example.test',
        status: 'active',
        stripe_customer_id: 'cus_x',
        scopes: ['driftstack_internal_admin'],
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await me(fx);
    expect(after.name).toBe('Renamed');
    expect(after.tier).toBe('free');
    expect(after.email).toBe(before.email);
    expect(after.status).toBe(before.status);
    // Straight from the store, not only the response shape.
    const row = await fx.authRepo.getAccount(fx.accountId);
    expect(row?.tier).toBe('free');
    expect(row?.email).toBe(before.email);
  });

  it('CRITICAL the PATCH writes only the caller’s own account, even with a paid owner’s workspace selected', async () => {
    fx = await freeDesktop();
    fx.authRepo.upsertAccount({
      id: OWNER_ID,
      email: 'paid-owner-11@driftstack.local',
      name: 'Paid Owner',
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ID, role: 'admin' },
    ]);

    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: { ...bearer(fx), 'x-driftstack-account': `acc_${OWNER_ID}` },
      payload: { name: 'Member Name' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<AccountMe>().id).toBe(`acc_${fx.accountId}`);

    const owner = await fx.authRepo.getAccount(OWNER_ID);
    expect(owner?.name).toBe('Paid Owner');
    expect(owner?.tier).toBe('api_scale');
    const self = await fx.authRepo.getAccount(fx.accountId);
    expect(self?.name).toBe('Member Name');
  });

  it('CRITICAL is still refused on the proxy Test route — the server tunnel test stays a paid feature', async () => {
    fx = await freeDesktop();
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: bearer(fx),
      payload: { label: 'home', host: '1.2.3.4', port: 1080, username: 'u', password: 'hunter2' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json<{ id: string }>();

    for (const url of [
      `/v1/account/me/proxies/${id}/test`,
      `/v1/account/me/proxies/${id}/test?vantage=fleet`,
    ]) {
      const res = await fx.app.inject({ method: 'POST', url, headers: bearer(fx), payload: {} });
      expect(isFreeDesktopDenied(res), `${url} → ${String(res.statusCode)} ${res.body}`).toBe(true);
    }
  });

  it('every other refusal the Free desktop key had is intact', async () => {
    fx = await freeDesktop();
    for (const [method, url] of [
      ['GET', '/v1/api-keys'],
      ['GET', '/v1/webhooks'],
      ['GET', '/v1/account/web-sessions'],
      ['POST', '/v1/account/me/avatar'],
      ['DELETE', '/v1/account/me/avatar'],
    ] as const) {
      const res = await fx.app.inject({ method, url, headers: bearer(fx), payload: {} });
      expect(isFreeDesktopDenied(res), `${method} ${url} → ${String(res.statusCode)}`).toBe(true);
    }
  });
});

// GUI audit #3 (HIGH) — a Free teammate could start an AI task in a paid owner's
// workspace but could not stop it or see its screenshots.
//
// The desktop app's browser sign-in mints a `cli_device` key. On a Free account
// that key is bounded to FREE_DESKTOP_ALLOWED_ROUTES, and the bound reads the
// CALLER's own tier even when the request acts in a teammate's workspace. So a
// Free member working for a paid owner (the usual team shape: the owner pays)
// could create a task — `aiAgent` is checked on the owner's tier — and was then
// refused 403 on Stop, while the task ran on to completion on the owner's
// budget, and every step's screenshot read "Screenshot unavailable".
//
// Driven through the real auth chain: a Free `cli_device` key (scopes as the
// device mint grants them), an admin membership of an `api_scale` owner, and the
// `X-Driftstack-Account` header the GUI sends when a teammate's workspace is
// selected. The screenshot is real bytes in the real capture store, which the
// shared fixture does not wire, so `buildApp` is wrapped to add it (the same
// seam a-program-can-run-an-ai-task-end-to-end-through-the-public-api uses).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FREE_DESKTOP_ROUTE_DENIED_DETAIL } from '@driftstack/api-types';
import type * as AppModule from '../../src/lib/app.js';
import type { SessionCaptureStore } from '../../src/services/session-capture-store.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const capture = vi.hoisted(() => ({ store: undefined as SessionCaptureStore | undefined }));

vi.mock('../../src/lib/app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AppModule>();
  const { SessionCaptureStore } = await import('../../src/services/session-capture-store.js');
  return {
    ...actual,
    buildApp: (deps: Parameters<typeof actual.buildApp>[0]) => {
      capture.store = new SessionCaptureStore();
      return actual.buildApp({ ...deps, sessionCaptureStore: capture.store });
    },
  };
});

const OWNER_ID = '00000000-0000-4000-8000-00000000f301';
const MEMBERSHIP_ID = '00000000-0000-4000-8000-00000000f302';
// 1x1 PNG, base64.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let fx: TestAppFixture | undefined;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = undefined;
});

/** A Free desktop key whose account is an admin member of a paid owner. */
async function freeMemberOfPaidOwner(): Promise<TestAppFixture> {
  const f = await buildTestApp({
    enableAgentRuntime: true,
    tier: 'free',
    keyProvenance: 'cli_device',
    // What the device-code mint grants (auth-cli.ts DEFAULT_SCOPES).
    scopes: ['account_owner'],
  });
  f.authRepo.upsertAccount({
    id: OWNER_ID,
    email: 'paid-owner@driftstack.local',
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
  f.authRepo.setTeamMemberships(f.accountId, [
    { membershipId: MEMBERSHIP_ID, ownerAccountId: OWNER_ID, role: 'admin' },
  ]);
  return f;
}

const inOwnersWorkspace = (f: TestAppFixture): Record<string, string> => ({
  authorization: `Bearer ${f.plaintext}`,
  'x-driftstack-account': `acc_${OWNER_ID}`,
});

function isFreeDesktopDenied(res: { statusCode: number; body: string }): boolean {
  if (res.statusCode !== 403) return false;
  return (JSON.parse(res.body) as { detail?: string }).detail === FREE_DESKTOP_ROUTE_DENIED_DETAIL;
}

async function startTaskInOwnersWorkspace(f: TestAppFixture): Promise<string> {
  const res = await f.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: inOwnersWorkspace(f),
    payload: { token_budget: 50_000, mode: 'ai' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json<{ id: string; account_id: string }>();
  // The task belongs to the OWNER's workspace, which is what makes this case.
  expect(body.account_id).toBe(OWNER_ID);
  return body.id;
}

describe('a Free teammate working in a paid owner’s workspace', () => {
  it('CRITICAL can stop the task it started (not refused by the Free route policy)', async () => {
    fx = await freeMemberOfPaidOwner();
    const id = await startTaskInOwnersWorkspace(fx);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/stop`,
      headers: inOwnersWorkspace(fx),
      payload: {},
    });

    expect(isFreeDesktopDenied(res), res.body).toBe(false);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'no_turn_running', session_id: id });
  });

  it('CRITICAL can read the screenshot its task took', async () => {
    fx = await freeMemberOfPaidOwner();
    const id = await startTaskInOwnersWorkspace(fx);
    const store = capture.store;
    if (store === undefined) throw new Error('the capture store was not wired into the app');
    const captureId = store.put(id, PNG_1x1_B64, 'png');

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/captures/${captureId}`,
      headers: inOwnersWorkspace(fx),
    });

    expect(isFreeDesktopDenied(res), res.body).toBe(false);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(Buffer.from(PNG_1x1_B64, 'base64'))).toBe(true);
  });

  it('the same key is still refused on a session route the GUI does not use (positive control: the policy is still applied to this caller)', async () => {
    fx = await freeMemberOfPaidOwner();
    const id = await startTaskInOwnersWorkspace(fx);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/network`,
      headers: inOwnersWorkspace(fx),
    });
    expect(isFreeDesktopDenied(res), res.body).toBe(true);
  });

  it('opening the two routes did not open another workspace: a session of an owner it is not a member of stays hidden (404), for stop and for screenshots', async () => {
    fx = await freeMemberOfPaidOwner();
    const id = await startTaskInOwnersWorkspace(fx);
    const store = capture.store;
    if (store === undefined) throw new Error('the capture store was not wired into the app');
    const captureId = store.put(id, PNG_1x1_B64, 'png');
    // Revoke the membership: the same key, the same session, no longer a teammate.
    fx.authRepo.setTeamMemberships(fx.accountId, []);
    await fx.authCache.invalidateAccount(fx.accountId);

    const stop = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/stop`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const shot = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/captures/${captureId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(stop.statusCode, stop.body).toBe(404);
    expect(shot.statusCode, shot.body).toBe(404);
    expect(shot.rawPayload.equals(Buffer.from(PNG_1x1_B64, 'base64'))).toBe(false);
  });
});

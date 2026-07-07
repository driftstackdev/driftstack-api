// V-540.B-8 — E2E walkthrough of /v1/profile-snapshots + the
// per-profile capture / list endpoints.
//
// Covers:
//  - POST /v1/profiles/:id/snapshots captures a snapshot.
//  - GET /v1/profiles/:id/snapshots lists snapshots for a profile.
//  - GET /v1/profile-snapshots lists ALL snapshots across the account.
//  - GET /v1/profile-snapshots/:id returns a single snapshot.
//  - POST /v1/profile-snapshots/:id/restore creates a new profile
//    from the snapshot.
//  - DELETE /v1/profile-snapshots/:id removes the snapshot row.
//  - 401 on every route without auth.

import { test, expect, type APIRequestContext } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test.beforeEach(async () => {
  await server.resetState();
});

interface ProfileResponse {
  id: string;
  name: string;
  archetype?: string;
  description?: string | null;
}

interface SnapshotResponse {
  id: string;
  parent_profile_id: string;
  label: string;
  description: string | null;
  created_at: string;
}

interface SnapshotListResponse {
  data: SnapshotResponse[];
  has_more: boolean;
  next_cursor: string | null;
}

async function createProfile(
  request: APIRequestContext,
  seedPlaintext: string,
  name = 'p1',
): Promise<ProfileResponse> {
  const res = await request.post(`${server.baseUrl}/v1/profiles`, {
    headers: authHeader(seedPlaintext),
    data: { name },
  });
  // 2026-05-21 — POST /v1/profiles returns 200 (not 201) here; the
  // route's existing contract + 11 integration tests + the SDK
  // consumers all expect 200. Match it rather than diverging.
  expect(res.status()).toBe(200);
  return (await res.json()) as ProfileResponse;
}

test('POST /v1/profiles/:id/snapshots captures a snapshot', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const profile = await createProfile(request, seed.plaintext);

  const res = await request.post(`${server.baseUrl}/v1/profiles/${profile.id}/snapshots`, {
    headers: authHeader(seed.plaintext),
    data: { label: 'before-experiment-A', description: 'baseline' },
  });
  // S46 2026-07-07 (founder-approved) — capture is a create: the route now
  // replies 201, matching sibling create-POSTs + the docs/openapi contract.
  // (Superseded 2026-05-21 note: it returned an implicit 200 before S46.)
  expect(res.status()).toBe(201);
  const snap = (await res.json()) as SnapshotResponse;
  expect(snap.id).toMatch(/^psnap_/);
  expect(snap.parent_profile_id).toBe(profile.id);
  expect(snap.label).toBe('before-experiment-A');
  expect(snap.description).toBe('baseline');
});

test('GET /v1/profiles/:id/snapshots lists per-profile snapshots', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const profile = await createProfile(request, seed.plaintext);
  await request.post(`${server.baseUrl}/v1/profiles/${profile.id}/snapshots`, {
    headers: authHeader(seed.plaintext),
    data: { label: 'a' },
  });
  await request.post(`${server.baseUrl}/v1/profiles/${profile.id}/snapshots`, {
    headers: authHeader(seed.plaintext),
    data: { label: 'b' },
  });

  const res = await request.get(`${server.baseUrl}/v1/profiles/${profile.id}/snapshots`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as SnapshotListResponse;
  expect(body.data.length).toBe(2);
  for (const s of body.data) {
    expect(s.parent_profile_id).toBe(profile.id);
  }
});

test('GET /v1/profile-snapshots lists account-wide snapshots', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const profileA = await createProfile(request, seed.plaintext, 'pa');
  const profileB = await createProfile(request, seed.plaintext, 'pb');

  await request.post(`${server.baseUrl}/v1/profiles/${profileA.id}/snapshots`, {
    headers: authHeader(seed.plaintext),
    data: { label: 'a-snap' },
  });
  await request.post(`${server.baseUrl}/v1/profiles/${profileB.id}/snapshots`, {
    headers: authHeader(seed.plaintext),
    data: { label: 'b-snap' },
  });

  const res = await request.get(`${server.baseUrl}/v1/profile-snapshots`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as SnapshotListResponse;
  expect(body.data.length).toBe(2);
});

test('GET /v1/profile-snapshots/:id returns a single snapshot', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const profile = await createProfile(request, seed.plaintext);
  const captureRes = await request.post(`${server.baseUrl}/v1/profiles/${profile.id}/snapshots`, {
    headers: authHeader(seed.plaintext),
    data: { label: 'one' },
  });
  const snap = (await captureRes.json()) as SnapshotResponse;

  const res = await request.get(`${server.baseUrl}/v1/profile-snapshots/${snap.id}`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as SnapshotResponse;
  expect(body.id).toBe(snap.id);
  expect(body.label).toBe('one');
});

test('POST /v1/profile-snapshots/:id/restore creates a fresh profile', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const profile = await createProfile(request, seed.plaintext);
  const snap = (await (
    await request.post(`${server.baseUrl}/v1/profiles/${profile.id}/snapshots`, {
      headers: authHeader(seed.plaintext),
      data: { label: 'restore-from' },
    })
  ).json()) as SnapshotResponse;

  const restoreRes = await request.post(
    `${server.baseUrl}/v1/profile-snapshots/${snap.id}/restore`,
    {
      headers: authHeader(seed.plaintext),
      data: { name: 'restored-profile' },
    },
  );
  // 2026-05-21 — restore POST returns 200 (matches the rest of the family).
  expect(restoreRes.status()).toBe(200);
  const restored = (await restoreRes.json()) as ProfileResponse;
  expect(restored.id).toMatch(/^prof_/);
  expect(restored.id).not.toBe(profile.id);
  expect(restored.name).toBe('restored-profile');
});

test('DELETE /v1/profile-snapshots/:id removes the row', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const profile = await createProfile(request, seed.plaintext);
  const snap = (await (
    await request.post(`${server.baseUrl}/v1/profiles/${profile.id}/snapshots`, {
      headers: authHeader(seed.plaintext),
      data: { label: 'to-delete' },
    })
  ).json()) as SnapshotResponse;

  const delRes = await request.delete(`${server.baseUrl}/v1/profile-snapshots/${snap.id}`, {
    headers: authHeader(seed.plaintext),
  });
  expect(delRes.status()).toBe(204);

  const fetchAfter = await request.get(`${server.baseUrl}/v1/profile-snapshots/${snap.id}`, {
    headers: authHeader(seed.plaintext),
  });
  expect(fetchAfter.status()).toBe(404);
});

test('profile-snapshots routes return 401 without auth', async ({ request }) => {
  const eps = [
    { method: 'get' as const, path: '/v1/profile-snapshots' },
    { method: 'get' as const, path: '/v1/profile-snapshots/psnap_x' },
    {
      method: 'post' as const,
      path: '/v1/profile-snapshots/psnap_x/restore',
      data: { name: 'x' },
    },
    { method: 'delete' as const, path: '/v1/profile-snapshots/psnap_x' },
  ];
  for (const ep of eps) {
    const res = await request[ep.method](`${server.baseUrl}${ep.path}`, { data: ep.data });
    expect(res.status(), `${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
  }
});

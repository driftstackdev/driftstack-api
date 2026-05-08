// V-312 — integration tests for profile snapshots.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface ProfileResponse {
  id: string;
  name: string;
  archetype: string;
  description: string | null;
}
interface SnapshotResponse {
  id: string;
  parent_profile_id: string | null;
  label: string;
  description: string | null;
  parent_archetype: string;
  parent_name: string;
  captured_at: string;
  created_at: string;
}

async function mintProfile(
  fixture: TestAppFixture,
  name: string,
  archetype = 'iphone16pro_ios18_7_safari26_4',
): Promise<ProfileResponse> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/profiles',
    headers: { ...auth(fixture), 'content-type': 'application/json' },
    payload: { name, archetype, description: 'src for snapshot test' },
  });
  expect(res.statusCode).toBe(200);
  return res.json<ProfileResponse>();
}

describe('POST /v1/profiles/:id/snapshots (V-312)', () => {
  it('200 captures a snapshot carrying parent metadata', async () => {
    fx = await buildTestApp();
    const profile = await mintProfile(fx, 'src-prof');
    const cap = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'before-migration', description: 'pre-iOS-18 reference' },
    });
    expect(cap.statusCode).toBe(200);
    const body = cap.json<SnapshotResponse>();
    expect(body.id).toMatch(/^psnap_[0-9a-f-]{36}$/);
    expect(body.parent_profile_id).toBe(profile.id);
    expect(body.label).toBe('before-migration');
    expect(body.description).toBe('pre-iOS-18 reference');
    expect(body.parent_archetype).toBe(profile.archetype);
    expect(body.parent_name).toBe('src-prof');
    expect(new Date(body.captured_at).getTime()).toBeGreaterThan(0);
  });

  it('400 on missing label', async () => {
    fx = await buildTestApp();
    const profile = await mintProfile(fx, 'badreq');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 on unknown source profile', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-deadbeef0001/snapshots',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/profiles/:id/snapshots + /v1/profile-snapshots (V-312)', () => {
  it('lists per-profile snapshots newest-first', async () => {
    fx = await buildTestApp();
    const p = await mintProfile(fx, 'lister');
    for (const label of ['snap-1', 'snap-2', 'snap-3']) {
      await fx.app.inject({
        method: 'POST',
        url: `/v1/profiles/${p.id}/snapshots`,
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: { label },
      });
    }
    const list = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles/${p.id}/snapshots`,
      headers: auth(fx),
    });
    const body = list.json<{ data: SnapshotResponse[]; has_more: boolean }>();
    expect(body.data).toHaveLength(3);
    // Set-membership assertion — three rapid-fire captures can share
    // a millisecond-precision createdAt; the secondary id sort is a
    // non-deterministic uuid tiebreak. Real Postgres has microsecond
    // resolution + monotonic inserts so the production order is stable.
    expect(new Set(body.data.map((s) => s.label))).toEqual(new Set(['snap-1', 'snap-2', 'snap-3']));
    expect(body.has_more).toBe(false);
  });

  it('per-account listing covers snapshots across multiple profiles', async () => {
    fx = await buildTestApp();
    const a = await mintProfile(fx, 'a');
    const b = await mintProfile(fx, 'b');
    await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${a.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'A1' },
    });
    await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${b.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'B1' },
    });
    const cross = await fx.app.inject({
      method: 'GET',
      url: '/v1/profile-snapshots',
      headers: auth(fx),
    });
    const body = cross.json<{ data: SnapshotResponse[] }>();
    expect(body.data.length).toBe(2);
    expect(new Set(body.data.map((s) => s.label))).toEqual(new Set(['A1', 'B1']));
  });
});

describe('POST /v1/profile-snapshots/:id/restore (V-312)', () => {
  it('200 creates a NEW profile from snapshot data; original profile remains', async () => {
    fx = await buildTestApp();
    const src = await mintProfile(fx, 'src');
    const cap = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${src.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'baseline' },
    });
    const snap = cap.json<SnapshotResponse>();

    const restore = await fx.app.inject({
      method: 'POST',
      url: `/v1/profile-snapshots/${snap.id}/restore`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'restored-from-baseline' },
    });
    expect(restore.statusCode).toBe(200);
    const body = restore.json<ProfileResponse>();
    expect(body.id).toMatch(/^prof_[0-9a-f-]{36}$/);
    expect(body.id).not.toBe(src.id);
    expect(body.name).toBe('restored-from-baseline');
    expect(body.archetype).toBe(src.archetype);
    expect(body.description).toBe(snap.description);

    // Original profile + snapshot both still exist.
    const origList = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: auth(fx),
    });
    const origNames = origList.json<{ data: ProfileResponse[] }>().data.map((p) => p.name);
    expect(origNames).toContain('src');
    expect(origNames).toContain('restored-from-baseline');
  });

  it('409 when target name conflicts with an existing profile', async () => {
    fx = await buildTestApp();
    const src = await mintProfile(fx, 'src');
    await mintProfile(fx, 'taken-already');
    const cap = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${src.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'baseline' },
    });
    const snap = cap.json<SnapshotResponse>();

    const restore = await fx.app.inject({
      method: 'POST',
      url: `/v1/profile-snapshots/${snap.id}/restore`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'taken-already' },
    });
    expect(restore.statusCode).toBe(409);
  });

  it('404 on unknown snapshot id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profile-snapshots/psnap_00000000-0000-4000-8000-deadbeef0001/restore',
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/profile-snapshots/:id (V-312)', () => {
  it('204 deletes; subsequent get 404s', async () => {
    fx = await buildTestApp();
    const src = await mintProfile(fx, 'src');
    const cap = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${src.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'tmp' },
    });
    const snap = cap.json<SnapshotResponse>();

    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profile-snapshots/${snap.id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const get = await fx.app.inject({
      method: 'GET',
      url: `/v1/profile-snapshots/${snap.id}`,
      headers: auth(fx),
    });
    expect(get.statusCode).toBe(404);
  });
});

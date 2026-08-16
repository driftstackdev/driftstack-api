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
  // S46 2026-07-07 (founder-approved) — capture is a create: 201, matching
  // the docs/openapi contract and sibling create-POSTs (sessions, webhooks).
  it('201 captures a snapshot carrying parent metadata', async () => {
    fx = await buildTestApp();
    const profile = await mintProfile(fx, 'src-prof');
    const cap = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'before-migration', description: 'pre-iOS-18 reference' },
    });
    expect(cap.statusCode).toBe(201);
    const body = cap.json<SnapshotResponse>();
    expect(body.id).toMatch(/^psnap_[0-9a-f-]{36}$/);
    expect(body.parent_profile_id).toBe(profile.id);
    expect(body.label).toBe('before-migration');
    expect(body.description).toBe('pre-iOS-18 reference');
    expect(body.parent_archetype).toBe(profile.archetype);
    expect(body.parent_name).toBe('src-prof');
    expect(new Date(body.captured_at).getTime()).toBeGreaterThan(0);
  });

  // Item 6 — the wiring, not the helper. Reverting either snapshot route to a
  // plain safeParse leaves these suites green otherwise: silent stripping and
  // reporting produce identical bodies and status codes, so only the header
  // separates them.
  it('CRITICAL capture and restore report a mistyped field, and stay quiet when all are known', async () => {
    fx = await buildTestApp();
    const profile = await mintProfile(fx, 'typo-prof');

    const typo = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'snap-1', descrption: 'mistyped' },
    });
    expect(typo.statusCode, 'reporting, not rejecting').toBe(201);
    expect(typo.headers['x-driftstack-unknown-fields']).toBe('descrption');

    const clean = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'snap-2', description: 'spelled right' },
    });
    expect(clean.statusCode).toBe(201);
    expect(
      clean.headers['x-driftstack-unknown-fields'],
      'a well-formed request must not be tagged',
    ).toBeUndefined();

    // …and the restore route, which is wired separately and would otherwise go
    // unpinned exactly like capture.
    const snapshotId = clean.json<SnapshotResponse>().id;
    const restored = await fx.app.inject({
      method: 'POST',
      url: `/v1/profile-snapshots/${snapshotId}/restore`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'restored-prof', nmae: 'mistyped' },
    });
    expect(restored.statusCode, 'restore answers 200, like its sibling arm').toBe(200);
    expect(restored.headers['x-driftstack-unknown-fields']).toBe('nmae');
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

  it('404 on second delete (idempotent-on-missing)', async () => {
    fx = await buildTestApp();
    const src = await mintProfile(fx, 'src');
    const cap = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${src.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'tmp' },
    });
    const snap = cap.json<SnapshotResponse>();

    const first = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profile-snapshots/${snap.id}`,
      headers: auth(fx),
    });
    expect(first.statusCode).toBe(204);

    const second = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profile-snapshots/${snap.id}`,
      headers: auth(fx),
    });
    expect(second.statusCode).toBe(404);
  });
});

// V-394 — edge-case suite. Probes parent-deleted survival, cross-
// account isolation, restore audit payload, and chained restore-
// of-restored-from snapshot semantics.
describe('V-312 edge cases (V-394)', () => {
  it('snapshot survives parent profile deletion; restore creates new profile from frozen archetype', async () => {
    fx = await buildTestApp();
    const parent = await mintProfile(fx, 'parent-to-delete');
    const cap = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${parent.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'pre-delete' },
    });
    const snap = cap.json<SnapshotResponse>();
    expect(snap.parent_profile_id).toBe(parent.id);

    // Delete the parent; snapshot must survive.
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${parent.id}`,
      headers: auth(fx),
    });
    expect(del.statusCode).toBe(204);

    const after = await fx.app.inject({
      method: 'GET',
      url: `/v1/profile-snapshots/${snap.id}`,
      headers: auth(fx),
    });
    expect(after.statusCode).toBe(200);
    const orphan = after.json<SnapshotResponse>();
    // The architectural invariant: frozen parent metadata
    // (parent_archetype + parent_name) survives parent deletion,
    // captured at snapshot time. Production Postgres also nulls
    // parent_profile_id via ON DELETE SET NULL FK; in-memory test
    // repo intentionally doesn't replicate that cascade behavior
    // since the frozen-metadata invariant is the load-bearing one
    // for restore (architectural lock — see migration 0037).
    expect(orphan.parent_archetype).toBe(parent.archetype);
    expect(orphan.parent_name).toBe('parent-to-delete');

    // Restore still succeeds — the new profile carries the frozen
    // archetype + the customer-supplied name.
    const restore = await fx.app.inject({
      method: 'POST',
      url: `/v1/profile-snapshots/${snap.id}/restore`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'phoenix' },
    });
    expect(restore.statusCode).toBe(200);
    const restored = restore.json<ProfileResponse>();
    expect(restored.archetype).toBe(parent.archetype);
    expect(restored.id).not.toBe(parent.id);
  });

  it('snapshots are account-scoped; cross-account access returns 404', async () => {
    fx = await buildTestApp();
    const aProfile = await mintProfile(fx, 'a-prof');
    const cap = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${aProfile.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'A1' },
    });
    const snap = cap.json<SnapshotResponse>();

    const other = await buildTestApp();
    try {
      const otherAuth = { authorization: `Bearer ${other.plaintext}` };

      // Other account: cannot GET the snapshot.
      const get = await other.app.inject({
        method: 'GET',
        url: `/v1/profile-snapshots/${snap.id}`,
        headers: otherAuth,
      });
      expect(get.statusCode).toBe(404);

      // Other account: cannot list across original account's
      // snapshots — its own list is empty.
      const list = await other.app.inject({
        method: 'GET',
        url: '/v1/profile-snapshots',
        headers: otherAuth,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json<{ data: SnapshotResponse[] }>().data).toHaveLength(0);

      // Other account: cannot restore.
      const restore = await other.app.inject({
        method: 'POST',
        url: `/v1/profile-snapshots/${snap.id}/restore`,
        headers: { ...otherAuth, 'content-type': 'application/json' },
        payload: { name: 'thief' },
      });
      expect(restore.statusCode).toBe(404);

      // Other account: cannot delete.
      const del = await other.app.inject({
        method: 'DELETE',
        url: `/v1/profile-snapshots/${snap.id}`,
        headers: otherAuth,
      });
      expect(del.statusCode).toBe(404);
    } finally {
      await other.cleanup();
    }
  });

  it('restore audit emits profile.created with restored_from_snapshot tag', async () => {
    fx = await buildTestApp();
    const src = await mintProfile(fx, 'src-audit');
    const cap = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${src.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'audit-test' },
    });
    const snap = cap.json<SnapshotResponse>();

    const restore = await fx.app.inject({
      method: 'POST',
      url: `/v1/profile-snapshots/${snap.id}/restore`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'restored-from-audit-test' },
    });
    expect(restore.statusCode).toBe(200);
    const restored = restore.json<ProfileResponse>();

    const audit = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=profile.created&limit=10',
      headers: auth(fx),
    });
    expect(audit.statusCode).toBe(200);
    const entries = audit.json<{
      data: Array<{
        action: string;
        target_resource_id: string;
        payload: Record<string, unknown> | null;
      }>;
    }>().data;
    const matching = entries.find(
      (e) => e.target_resource_id === `profile_${restored.id.replace(/^prof_/, '')}`,
    );
    expect(matching).toBeDefined();
    expect(matching?.payload).toMatchObject({
      restored_from_snapshot: snap.id,
    });
  });

  it('snapshot of a snapshot-restored profile carries the new archetype, not the original parent', async () => {
    fx = await buildTestApp();
    const original = await mintProfile(fx, 'chain-src');
    const cap1 = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${original.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'gen-1' },
    });
    const snap1 = cap1.json<SnapshotResponse>();

    const restore = await fx.app.inject({
      method: 'POST',
      url: `/v1/profile-snapshots/${snap1.id}/restore`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'gen-2' },
    });
    const gen2 = restore.json<ProfileResponse>();

    // Snapshot the restored profile — parent metadata reflects the
    // restored profile, not the original parent of snap1.
    const cap2 = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${gen2.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'gen-2-snap' },
    });
    const snap2 = cap2.json<SnapshotResponse>();
    expect(snap2.parent_profile_id).toBe(gen2.id);
    expect(snap2.parent_name).toBe('gen-2');
    expect(snap2.parent_archetype).toBe(gen2.archetype);
  });
});

describe('profile-snapshot write ops require write:profiles scope', () => {
  // A read-scope key must not capture, restore, or delete snapshots —
  // those are profile mutations (restore creates a new profile). The
  // requireScope preHandler runs before the route body, so the 403
  // lands regardless of whether the referenced profile/snapshot exists.
  const READ_ONLY = { scopes: ['read'] as const };
  const SOME_PROF = 'prof_00000000-0000-4000-8000-00000000c001';
  const SOME_SNAP = 'psnap_00000000-0000-4000-8000-00000000c002';

  it('403 capture (POST /v1/profiles/:id/snapshots) with a read-only key', async () => {
    fx = await buildTestApp({ scopes: [...READ_ONLY.scopes] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${SOME_PROF}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('403 restore (POST /v1/profile-snapshots/:id/restore) with a read-only key', async () => {
    fx = await buildTestApp({ scopes: [...READ_ONLY.scopes] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profile-snapshots/${SOME_SNAP}/restore`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { name: 'escalated' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('403 delete (DELETE /v1/profile-snapshots/:id) with a read-only key', async () => {
    fx = await buildTestApp({ scopes: [...READ_ONLY.scopes] });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profile-snapshots/${SOME_SNAP}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });

  it('read-only key can still LIST snapshots (reads are not over-restricted)', async () => {
    fx = await buildTestApp({ scopes: [...READ_ONLY.scopes] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profile-snapshots',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown[] }>().data).toEqual([]);
  });

  // Fable last-hours audit 2026-07-07 (C9) — snapshot READS now require
  // read:profiles (the reference already documented it; enforcement was
  // missing). A key that can WRITE profiles/snapshots but has no read scope
  // must not read snapshot metadata — write:profiles "Does not include read".
  const WRITE_ONLY = { scopes: ['write:profiles'] as const };

  it('403 LIST (GET /v1/profile-snapshots) with a write:profiles-only key — C9', async () => {
    fx = await buildTestApp({ scopes: [...WRITE_ONLY.scopes] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profile-snapshots',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });

  it('403 per-profile LIST (GET /v1/profiles/:id/snapshots) with a write:profiles-only key — C9', async () => {
    fx = await buildTestApp({ scopes: [...WRITE_ONLY.scopes] });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles/${SOME_PROF}/snapshots`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });

  it('403 GET one (GET /v1/profile-snapshots/:id) with a write:profiles-only key — C9', async () => {
    fx = await buildTestApp({ scopes: [...WRITE_ONLY.scopes] });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/profile-snapshots/${SOME_SNAP}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });

  it('a read:profiles-scoped key CAN read snapshots (the granular read scope satisfies the C9 gate)', async () => {
    fx = await buildTestApp({ scopes: ['read:profiles'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profile-snapshots',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
  });

  it('a write-scoped key still captures a snapshot (no regression for the happy path)', async () => {
    fx = await buildTestApp();
    const profile = await mintProfile(fx, 'scope-happy');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/snapshots`,
      headers: { ...auth(fx), 'content-type': 'application/json' },
      payload: { label: 'ok' },
    });
    // S46 2026-07-07 — capture now returns 201 Created.
    expect(res.statusCode).toBe(201);
  });

  it('400s a well-formed-looking but non-UUID snapshot id instead of 500ing on the uuid column', async () => {
    // PUBLIC_ID_RE was `[a-z]+_([0-9a-fA-F-]{36})`, which accepts 36 characters
    // of hex-or-dash in ANY arrangement — including 36 hex digits with no dashes
    // — and handed them straight to a Postgres `uuid` column. Any authenticated
    // caller could turn a malformed id into a 500, which is both a bad customer
    // response and noise that masks real faults.
    const fx2 = await buildTestApp();
    try {
      const res = await fx2.app.inject({
        method: 'GET',
        url: '/v1/profile-snapshots/psnap_0123456789abcdef0123456789abcdef0123',
        headers: { authorization: `Bearer ${fx2.plaintext}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.statusCode).not.toBe(500);
    } finally {
      await fx2.cleanup();
    }
  });
});

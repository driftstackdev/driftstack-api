// Integration tests for the V-081 Profiles surface (/v1/profiles).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { seedProfiles } from './_helpers/scenarios.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

interface ProfileResponse {
  id: string;
  name: string;
  archetype: string;
  description: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

describe('POST /v1/profiles', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 creates a profile with default archetype', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'work-laptop' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProfileResponse>();
    expect(body.id).toMatch(/^prof_[0-9a-f-]{36}$/);
    expect(body.name).toBe('work-laptop');
    expect(body.archetype).toBe('iphone16pro_ios18_7_safari26_4');
    expect(body.description).toBeNull();
  });

  it('403 when the key lacks write:profiles scope (read-only key)', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'work-laptop' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('write:profiles');
  });

  it('200 honors explicit archetype + description', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        name: 'older-ios',
        archetype: 'iphone15_ios17_5_1',
        description: 'pinned to iOS 17 for stability',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProfileResponse>();
    expect(body.archetype).toBe('iphone15_ios17_5_1');
    expect(body.description).toBe('pinned to iOS 17 for stability');
  });

  it('429 TierLimit when profile count exceeds tier limit', async () => {
    // free permits 1 profile; create one then expect the second to fail.
    fx = await buildTestApp({ tier: 'free' });
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'one' },
    });
    expect(first.statusCode).toBe(200);

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'two' },
    });
    expect(second.statusCode).toBe(429);
    const body = second.json<{ type: string; limit: number; current: number }>();
    expect(body.type).toBe(PROBLEM_TYPES.TierLimit);
    expect(body.limit).toBe(1);
    expect(body.current).toBe(1);
  });

  it('409 Conflict on duplicate name within the same account', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'shared-name' },
    });
    const dup = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'shared-name' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Conflict);
  });

  it('400 ValidationFailed for invalid name format', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: '!!!invalid!!!' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('401 Unauthorized without bearer token', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      payload: { name: 'no-auth' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/profiles', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 lists profiles for the calling account', async () => {
    fx = await buildTestApp();
    await seedProfiles(fx, 3, { names: ['a', 'b', 'c'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: ProfileResponse[]; has_more: boolean }>();
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(false);
    expect(body.data.map((p) => p.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('200 paginates with cursor', async () => {
    fx = await buildTestApp();
    for (let i = 0; i < 5; i++) {
      await fx.app.inject({
        method: 'POST',
        url: '/v1/profiles',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { name: `p${i.toString()}` },
      });
    }
    const first = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles?limit=2',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const firstBody = first.json<{
      data: ProfileResponse[];
      has_more: boolean;
      next_cursor: string | null;
    }>();
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.has_more).toBe(true);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles?limit=2&cursor=${firstBody.next_cursor!}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const secondBody = second.json<{ data: ProfileResponse[] }>();
    expect(secondBody.data).toHaveLength(2);
    // No overlap with the first page.
    const firstIds = new Set(firstBody.data.map((p) => p.id));
    for (const p of secondBody.data) expect(firstIds.has(p.id)).toBe(false);
  });
});

describe('GET /v1/profiles/:id', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 returns the profile owned by the caller', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'gettable' },
    });
    const id = create.json<ProfileResponse>().id;

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProfileResponse>().name).toBe('gettable');
  });

  it('404 NotFound on unknown id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-000000000099',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 BadRequest on malformed id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles/not-a-prefixed-id',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /v1/profiles/:id', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 updates name + description', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'original' },
    });
    const id = create.json<ProfileResponse>().id;

    const patch = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'renamed', description: 'with description' },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json<ProfileResponse>();
    expect(body.name).toBe('renamed');
    expect(body.description).toBe('with description');
  });

  it('409 Conflict when renaming to an existing name', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'taken' },
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'will-rename' },
    });
    const id = create.json<ProfileResponse>().id;

    const patch = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'taken' },
    });
    expect(patch.statusCode).toBe(409);
  });
});

describe('DELETE /v1/profiles/:id', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('204 deletes the profile; subsequent GET returns 404', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'doomed' },
    });
    const id = create.json<ProfileResponse>().id;

    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(del.statusCode).toBe(204);

    // Idempotent: a second DELETE of the now-gone profile still 204s.
    const redel = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(redel.statusCode).toBe(204);

    const get = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(get.statusCode).toBe(404);
  });

  it('204 (idempotent) on unknown id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-000000000099',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(204);
  });
});

// ── V-313 — POST /v1/profiles/:id/clone ─────────────────────────────────

describe('POST /v1/profiles/:id/clone (V-313)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('201 clones a profile with auto-derived "(copy)" name', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: {
        name: 'production',
        archetype: 'iphone16pro_ios18_7_safari26_4',
        description: 'prod profile',
      },
    });
    expect(create.statusCode).toBe(200);
    const created = create.json<{ id: string }>();

    const clone = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${created.id}/clone`,
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(clone.statusCode).toBe(200);
    const body = clone.json<{
      id: string;
      name: string;
      archetype: string;
      description: string | null;
    }>();
    expect(body.id).not.toBe(created.id);
    expect(body.name).toBe('production (copy)');
    expect(body.archetype).toBe('iphone16pro_ios18_7_safari26_4');
    expect(body.description).toBe('prod profile');
  });

  it('201 increments the suffix when "(copy)" already exists', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { name: 'beta' },
    });
    const created = create.json<{ id: string }>();
    // First clone takes "(copy)".
    const c1 = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${created.id}/clone`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(c1.json<{ name: string }>().name).toBe('beta (copy)');
    // Second clone increments to "(copy 2)".
    const c2 = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${created.id}/clone`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(c2.json<{ name: string }>().name).toBe('beta (copy 2)');
  });

  it('201 accepts an explicit name override', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { name: 'src' },
    });
    const created = create.json<{ id: string }>();
    const clone = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${created.id}/clone`,
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { name: 'fork-staging' },
    });
    expect(clone.statusCode).toBe(200);
    expect(clone.json<{ name: string }>().name).toBe('fork-staging');
  });

  it('409 when the explicit name conflicts with an existing profile', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { name: 'taken-already' },
    });
    const src = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { name: 'src' },
    });
    const srcId = src.json<{ id: string }>().id;
    const clone = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${srcId}/clone`,
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { name: 'taken-already' },
    });
    expect(clone.statusCode).toBe(409);
  });

  it('404 when source id is unknown', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-deadbeef0001/clone',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // V-394 — V-313 clone edge cases.
  it('clone-of-clone: cloning an already-cloned profile inherits source archetype', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' };
    const orig = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'gen-0' },
    });
    const gen0 = orig.json<{ id: string; archetype: string }>();

    const c1 = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${gen0.id}/clone`,
      headers: auth,
      payload: { name: 'gen-1' },
    });
    const gen1 = c1.json<{ id: string; archetype: string; name: string }>();
    expect(gen1.archetype).toBe(gen0.archetype);
    expect(gen1.name).toBe('gen-1');

    const c2 = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${gen1.id}/clone`,
      headers: auth,
      payload: { name: 'gen-2' },
    });
    const gen2 = c2.json<{ id: string; archetype: string; name: string }>();
    expect(gen2.archetype).toBe(gen0.archetype);
    expect(gen2.id).not.toBe(gen0.id);
    expect(gen2.id).not.toBe(gen1.id);
  });

  it("cross-account: caller cannot clone another account's profile (404 not 403)", async () => {
    fx = await buildTestApp();
    const ownerAuth = {
      authorization: `Bearer ${fx.plaintext}`,
      'content-type': 'application/json',
    };
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: ownerAuth,
      payload: { name: 'owners-secret' },
    });
    const ownersProfileId = create.json<{ id: string }>().id;

    const other = await buildTestApp();
    try {
      const clone = await other.app.inject({
        method: 'POST',
        url: `/v1/profiles/${ownersProfileId}/clone`,
        headers: {
          authorization: `Bearer ${other.plaintext}`,
          'content-type': 'application/json',
        },
        payload: { name: 'thief' },
      });
      // 404 (not 403) — never confirm a profile exists in another
      // account's namespace. Same posture as snapshot cross-account.
      expect(clone.statusCode).toBe(404);
    } finally {
      await other.cleanup();
    }
  });

  it('audit emits profile.created with payload.cloned_from on clone', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' };
    const src = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'src-clone-audit' },
    });
    const srcId = src.json<{ id: string }>().id;

    const clone = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${srcId}/clone`,
      headers: auth,
      payload: { name: 'cloned-audit-target' },
    });
    expect(clone.statusCode).toBe(200);
    const cloned = clone.json<{ id: string }>();

    const audit = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=profile.created&limit=10',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(audit.statusCode).toBe(200);
    const entries = audit.json<{
      data: Array<{
        target_resource_id: string;
        payload: Record<string, unknown> | null;
      }>;
    }>().data;
    const matching = entries.find(
      (e) => e.target_resource_id === `profile_${cloned.id.replace(/^prof_/, '')}`,
    );
    expect(matching).toBeDefined();
    // V-313 audit emits cloned_from with the internal "profile_<uuid>"
    // prefix (services/profiles.ts:257); contrast with V-312 restore
    // which emits restored_from_snapshot with the public "psnap_<uuid>"
    // form. The asymmetry is pre-existing — the test pins the actual
    // wire format for consumers parsing audit payloads.
    expect(matching?.payload).toMatchObject({
      cloned_from: `profile_${srcId.replace(/^prof_/, '')}`,
    });
  });
});

// Integration tests for the V-081 Profiles surface (/v1/profiles).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { seedProfiles } from './_helpers/scenarios.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';

/** Mint a second, independent account + write-scoped API key directly in the
 *  fixture's in-memory auth repo so cross-account requests authenticate (and so
 *  resolve a *different* accountId) rather than 401-ing as an unknown key. */
async function seedSecondAccount(fx: TestAppFixture): Promise<string> {
  const accountId = 'acct_00000000-0000-4000-8000-0000000000b2';
  fx.authRepo.upsertAccount({
    id: accountId,
    email: 'other@driftstack.local',
    name: 'Other',
    tier: 'api_builder',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  const plaintext = generateApiKey('test');
  fx.authRepo.upsertApiKey({
    id: 'key_00000000-0000-4000-8000-0000000000b2',
    accountId,
    name: 'other-key',
    keyPrefix: keyPrefixFromPlaintext(plaintext),
    keyHash: await hashApiKey(plaintext),
    scopes: ['read', 'write'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  return plaintext;
}

interface ProfileResponse {
  id: string;
  name: string;
  archetype: string;
  description: string | null;
  folder: string | null;
  tags: string[];
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
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
    expect(body.archetype).toBe('iphone17_ios18_7_safari26_4');
    expect(body.description).toBeNull();
    expect(body.folder).toBeNull();
    expect(body.tags).toEqual([]);
  });

  // Item 6 — the route-level half. The helper has its own unit arms, but nothing
  // noticed if a ROUTE stopped calling it: reverting either handler to a plain
  // safeParse left all 906 profile tests green, because silent stripping and
  // reporting produce identical bodies and status codes. These pin the wiring.
  it('CRITICAL create reports a mistyped field instead of dropping it silently', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'typo-create', archetyp: 'iphone17_ios18_7_safari26_4' },
    });

    // Unchanged for the caller — this is the non-breaking half of the decision.
    expect(res.statusCode).toBe(200);
    expect(res.json<ProfileResponse>().archetype).toBe('iphone17_ios18_7_safari26_4');
    // …but the ignored key is no longer invisible.
    expect(res.headers['x-driftstack-unknown-fields']).toBe('archetyp');
  });

  it('CRITICAL update reports a mistyped field, and says nothing when all fields are known', async () => {
    fx = await buildTestApp();
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'typo-update' },
    });
    const id = created.json<ProfileResponse>().id;

    const typo = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { nam: 'renamed' },
    });
    expect(typo.statusCode).toBe(200);
    expect(typo.headers['x-driftstack-unknown-fields']).toBe('nam');

    // The negative arm matters as much: without it a header set unconditionally
    // would satisfy the assertions above and tag every well-formed request.
    const clean = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'renamed' },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.headers['x-driftstack-unknown-fields']).toBeUndefined();
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
        archetype: 'iphone13_ios18_6_safari18_6',
        description: 'pinned to an older selectable release for stability',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProfileResponse>();
    expect(body.archetype).toBe('iphone13_ios18_6_safari18_6');
    expect(body.description).toBe('pinned to an older selectable release for stability');
  });

  it('200 honors folder + tags at create (organization metadata)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'eu-shop', folder: 'EU accounts', tags: ['retail', 'warmup'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProfileResponse>();
    expect(body.folder).toBe('EU accounts');
    expect(body.tags).toEqual(['retail', 'warmup']);
  });

  it('400 ValidationFailed on over-cap organization metadata (folder >32 / >12 tags / duplicate tags)', async () => {
    fx = await buildTestApp();
    const cases = [
      { name: 'bad-folder', folder: 'x'.repeat(33) },
      { name: 'bad-tags', tags: Array.from({ length: 13 }, (_, i) => `t${i.toString()}`) },
      { name: 'dup-tags', tags: ['same', 'same'] },
    ];
    for (const payload of cases) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/profiles',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('429 TierLimit when profile count exceeds tier limit', async () => {
    // free permits 1 profile; create one then expect the second to fail.
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
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

  // V-553.B-21 — GET /v1/profiles had ZERO scope check (any authenticated
  // key, regardless of scope, could enumerate every profile on the
  // account). 'gui_control' is a real, narrow scope that satisfies
  // neither bare 'read' nor the broad-satisfies-granular rule.
  it('403 when the key lacks read:profiles (or a satisfying broad scope)', async () => {
    fx = await buildTestApp({ scopes: ['gui_control'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('read:profiles');
  });

  it('200 with a granular read:profiles key (granular satisfies the route)', async () => {
    fx = await buildTestApp({ scopes: ['read:profiles'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
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

  // V-553.B-21 — GET /v1/profiles/:id had ZERO scope check.
  it('403 when the key lacks read:profiles (or a satisfying broad scope)', async () => {
    fx = await buildTestApp({ scopes: ['gui_control'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-000000000099',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('read:profiles');
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

  it('200 sets then clears folder + tags (null folder / [] tags)', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'org-me', folder: 'Clients', tags: ['a', 'b'] },
    });
    const id = create.json<ProfileResponse>().id;

    const set = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { folder: 'Archive', tags: ['b', 'c'] },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<ProfileResponse>().folder).toBe('Archive');
    // Exact-set replace, not a merge.
    expect(set.json<ProfileResponse>().tags).toEqual(['b', 'c']);

    const clear = await fx.app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { folder: null, tags: [] },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json<ProfileResponse>().folder).toBeNull();
    expect(clear.json<ProfileResponse>().tags).toEqual([]);
    // Untouched fields survive the organization-only patch.
    expect(clear.json<ProfileResponse>().name).toBe('org-me');
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

  it('CRITICAL a malformed pagination query is refused rather than silently coerced. Coverage showed this refusal executed by no test while the `if` guarding it ran 18 times — the surrounding handler is heavily exercised, so the file reads as covered while the only check on a caller-supplied `limit` never fires. `limit` is bounded 1..100 with a default of 50, so a zero, an over-cap value or a non-number each fail the parse.', async () => {
    fx = await buildTestApp();
    for (const [label, qs] of [
      ['a limit below the floor', '?limit=0'],
      ['a limit past the cap', '?limit=999'],
      ['a non-numeric limit', '?limit=abc'],
      ['an empty cursor', '?cursor='],
    ] as const) {
      const res = await fx.app.inject({
        method: 'GET',
        url: `/v1/profiles${qs}`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode, `${label} is refused`).toBe(400);
    }
    // And a well-formed query is still served, so the arm refuses malformed input
    // rather than everything.
    const ok = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles?limit=5',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(ok.statusCode, 'a valid limit is accepted').toBe(200);
  });

  it('CRITICAL a malformed clone body is refused. `name` is ProfileNameSchema.optional() — trimmed, 1..120 — so an empty or over-long name fails while an absent one is the ordinary auto-derived-name path. Coverage showed this refusal executed by no test.', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'source' },
    });
    const id = created.json<ProfileResponse>().id;

    for (const [label, payload] of [
      ['an empty name', { name: '' }],
      ['a whitespace-only name', { name: '   ' }],
      ['an over-long name', { name: 'x'.repeat(121) }],
      ['a non-string name', { name: 7 }],
    ] as const) {
      const res = await fx.app.inject({
        method: 'POST',
        url: `/v1/profiles/${id}/clone`,
        headers: { ...auth, 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode, `clone rejects ${label}`).toBe(400);
    }

    // The absent-name path still works, so the arm refuses malformed input
    // rather than the endpoint.
    const ok = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${id}/clone`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {},
    });
    expect(ok.statusCode, 'an absent name auto-derives a copy name').toBe(200);
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

  it('L4b soft delete: a deleted profile drops out of the list and frees its name for a new profile (different id)', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'shopper' },
    });
    const firstId = first.json<ProfileResponse>().id;

    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${firstId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);

    // Gone from the list (not just unreachable by id).
    const list = await fx.app.inject({ method: 'GET', url: '/v1/profiles', headers: auth });
    const ids = list.json<{ data: ProfileResponse[] }>().data.map((p) => p.id);
    expect(ids).not.toContain(firstId);

    // The name is freed (partial unique index) — re-creating 'shopper' succeeds
    // (200) with a brand-new id rather than 409-ing on the trashed row's name.
    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'shopper' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<ProfileResponse>().id).not.toBe(firstId);
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

  it('clone copies organization metadata (folder + tags ride along in-account)', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'org-source', folder: 'Clients', tags: ['retail'] },
    });
    const id = create.json<ProfileResponse>().id;

    const clone = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${id}/clone`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(clone.statusCode).toBe(200);
    expect(clone.json<ProfileResponse>().folder).toBe('Clients');
    expect(clone.json<ProfileResponse>().tags).toEqual(['retail']);
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

describe('L4b recycle bin — GET /v1/profiles/trash + POST /v1/profiles/:id/restore', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('trash lists soft-deleted profiles (deleted_at set), excluding live ones', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const live = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'keep' },
    });
    const doomed = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'trash-me' },
    });
    const doomedId = doomed.json<ProfileResponse>().id;
    await fx.app.inject({ method: 'DELETE', url: `/v1/profiles/${doomedId}`, headers: auth });

    const trash = await fx.app.inject({ method: 'GET', url: '/v1/profiles/trash', headers: auth });
    expect(trash.statusCode).toBe(200);
    const data = trash.json<{ data: ProfileResponse[] }>().data;
    expect(data.map((p) => p.id)).toEqual([doomedId]);
    expect(data[0]!.deleted_at).not.toBeNull();
    // live profile stays out of the trash list and still has null deleted_at on the main list
    expect(data.map((p) => p.name)).not.toContain('keep');
    const list = await fx.app.inject({ method: 'GET', url: '/v1/profiles', headers: auth });
    expect(list.json<{ data: ProfileResponse[] }>().data.every((p) => p.deleted_at === null)).toBe(
      true,
    );
    expect(live.statusCode).toBe(200);
  });

  // V-553.B-21 — GET /v1/profiles/trash had ZERO scope check.
  it('403 when the key lacks read:profiles (or a satisfying broad scope)', async () => {
    fx = await buildTestApp({ scopes: ['gui_control'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles/trash',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('read:profiles');
  });

  it('200 with a granular read:profiles key (granular satisfies the route)', async () => {
    fx = await buildTestApp({ scopes: ['read:profiles'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles/trash',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('restore un-trashes a profile: it leaves trash, returns to the list, and GET resolves again', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'oops' },
    });
    const id = created.json<ProfileResponse>().id;
    await fx.app.inject({ method: 'DELETE', url: `/v1/profiles/${id}`, headers: auth });

    const restored = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${id}/restore`,
      headers: auth,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<ProfileResponse>().id).toBe(id);
    expect(restored.json<ProfileResponse>().deleted_at).toBeNull();

    const trash = await fx.app.inject({ method: 'GET', url: '/v1/profiles/trash', headers: auth });
    expect(trash.json<{ data: ProfileResponse[] }>().data).toHaveLength(0);
    const get = await fx.app.inject({ method: 'GET', url: `/v1/profiles/${id}`, headers: auth });
    expect(get.statusCode).toBe(200);
  });

  it('restore 404s on a live (not-trashed) profile and on an unknown id', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'alive' },
    });
    const id = created.json<ProfileResponse>().id;
    const live = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${id}/restore`,
      headers: auth,
    });
    expect(live.statusCode).toBe(404);
    const unknown = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-000000000099/restore',
      headers: auth,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('restore 409s when the name was reused by a live profile while trashed', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'dup' },
    });
    const firstId = first.json<ProfileResponse>().id;
    await fx.app.inject({ method: 'DELETE', url: `/v1/profiles/${firstId}`, headers: auth });
    // recreate the same name (freed by the partial unique index)
    await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'dup' },
    });
    // restoring the original now conflicts with the live namesake
    const restore = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/${firstId}/restore`,
      headers: auth,
    });
    expect(restore.statusCode).toBe(409);
    expect(restore.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Conflict);
  });

  it('restore requires write:profiles scope (read-only key → 403)', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-000000000099/restore',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('L4b anti-abuse — trashed profiles count toward the cap + manual purge', () => {
  let fx: Awaited<ReturnType<typeof buildTestApp>>;
  afterEach(async () => {
    await fx.cleanup();
  });

  it('trashing a profile does NOT free a cap slot — trash-then-create stays 429', async () => {
    // free tier permits 1 profile. Create it, trash it, then attempt to create
    // another: the trashed row still occupies the slot, so the cap holds.
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'one' },
    });
    expect(first.statusCode).toBe(200);
    const firstId = first.json<ProfileResponse>().id;

    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${firstId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'two' },
    });
    expect(second.statusCode).toBe(429);
    const body = second.json<{ type: string; limit: number; current: number }>();
    expect(body.type).toBe(PROBLEM_TYPES.TierLimit);
    expect(body.current).toBe(1);
  });

  it('purging a trashed profile frees the slot — create then succeeds (200)', async () => {
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'one' },
    });
    const firstId = first.json<ProfileResponse>().id;
    await fx.app.inject({ method: 'DELETE', url: `/v1/profiles/${firstId}`, headers: auth });

    const purge = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${firstId}/purge`,
      headers: auth,
    });
    expect(purge.statusCode).toBe(204);

    // slot is freed: the trashed row is gone and the cap admits a new profile
    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'two' },
    });
    expect(second.statusCode).toBe(200);

    // and the purged profile is no longer in the trash
    const trash = await fx.app.inject({ method: 'GET', url: '/v1/profiles/trash', headers: auth });
    expect(trash.json<{ data: ProfileResponse[] }>().data).toHaveLength(0);
  });

  it('purge 404s on a live (not-trashed) profile and on an unknown id', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const live = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'live' },
    });
    const liveId = live.json<ProfileResponse>().id;

    const purgeLive = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${liveId}/purge`,
      headers: auth,
    });
    expect(purgeLive.statusCode).toBe(404);

    const purgeUnknown = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-000000000099/purge',
      headers: auth,
    });
    expect(purgeUnknown.statusCode).toBe(404);
  });

  it('purge is account-scoped — another account cannot purge a trashed profile (404)', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'mine' },
    });
    const id = created.json<ProfileResponse>().id;
    await fx.app.inject({ method: 'DELETE', url: `/v1/profiles/${id}`, headers: auth });

    // a second, independent account (same app, distinct accountId + key)
    const otherKey = await seedSecondAccount(fx);
    const purge = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${id}/purge`,
      headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(purge.statusCode).toBe(404);

    // the owner can still see it in their trash (it was not purged)
    const trash = await fx.app.inject({ method: 'GET', url: '/v1/profiles/trash', headers: auth });
    expect(trash.json<{ data: ProfileResponse[] }>().data).toHaveLength(1);
  });

  it('purge requires write:profiles scope (read-only key → 403)', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-000000000099/purge',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── the tier cap on the doors that are not `create` ───────────────────────
//
// `PROFILES_PER_TIER` is a paid-tier boundary — free permits exactly one
// profile — and `services/profiles.ts` enforces it at THREE entry points, each
// with its own pre-check and its own atomic `limitExceeded` result: create,
// clone, and import. Six sites.
//
// ⚠️ Measured: only create's atomic check was covered. Both of clone's and both
// of import's were cold, which means a capped account could exceed its profile
// limit by taking a different door — the same bypass shape as flipping an agent
// session's mode instead of creating it LLM-driven. The create edge is the one
// everybody tests.
//
// A profile is the saved browser identity — cookies, fingerprint, logged-in
// state — so the cap is what the tier actually sells. Cloning past it is not a
// cosmetic overage.
//
// LEDGER — control 46/46:
//
//   clone pre-check alone neutralized       SURVIVES
//   import pre-check alone neutralized      1 red
//   create pre-check alone neutralized      SURVIVES
//   clone cap reports the WRONG numbers     1 red
//   clone  BOTH layers neutralized          1 red
//   import BOTH layers neutralized          1 red
//   create BOTH layers neutralized          2 red
//
// ⚠️ The two survivors are the interesting rows and they are NOT gaps. Each door
// checks the cap twice: a pre-check, then the atomic `limitExceeded` result of
// the insert itself. Neutralizing the pre-check alone leaves the atomic one to
// refuse, so the request is still correctly rejected — which is what defence in
// depth is supposed to look like, and why the single-line rows say nothing on
// their own. Neutralizing BOTH is what shows each cap is load-bearing, and each
// pair reds.
//
// ⭐ The wrong-numbers row is the one a status assertion cannot see: the refusal
// still fires with the right type, only `limit` and `current` are corrupted. The
// dashboard renders those as "1 of 1 used", so a build that reported 0 of 999
// would tell a customer at their cap that they have room.
describe('the profile cap holds on clone and import, not just create', () => {
  let fx2: TestAppFixture;

  afterEach(async () => {
    if (fx2) await fx2.cleanup();
  });

  /** Free tier permits exactly one profile; `cli_device` is the credential that
   *  reaches these routes on a free account. */
  async function freeAccountAtItsCap(): Promise<{ id: string; auth: { authorization: string } }> {
    fx2 = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    const auth = { authorization: `Bearer ${fx2.plaintext}` };
    const first = await fx2.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      // P-15 — an entitled device, so the cap arms below (clone, import) measure the CAP.
      payload: { name: 'the-only-one', archetype: 'iphone13_ios18_6_safari18_6' },
    });
    expect(first.statusCode, first.body).toBe(200);
    return { id: first.json<ProfileResponse>().id, auth };
  }

  it('CRITICAL 429: cloning cannot take an account past its tier cap. Create is refused at the cap and always has been; clone reaches the same limit through its own copy of the check, and that copy had never executed.', async () => {
    const { id, auth } = await freeAccountAtItsCap();
    const res = await fx2.app.inject({
      method: 'POST',
      url: `/v1/profiles/${id}/clone`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'the-second-one' },
    });
    expect(res.statusCode, res.body).toBe(429);
    const body = res.json<{ type: string; limit: number; current: number; resource: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.TierLimit);
    // The numbers are the contract the dashboard renders ("1 of 1 used"), and a
    // refusal that reported the wrong ones would send a customer to upgrade a
    // limit they had not reached.
    expect(body.limit).toBe(1);
    expect(body.current).toBe(1);
    expect(body.resource).toBe('profile');
  });

  it('CRITICAL 429: importing cannot take an account past its tier cap either — the third door, with its own copy again', async () => {
    const { id, auth } = await freeAccountAtItsCap();
    // Export the one profile the account is allowed, then try to import it back
    // as a second. The envelope is genuine, so nothing else can refuse this.
    const exported = await fx2.app.inject({
      method: 'GET',
      url: `/v1/profiles/${id}/export`,
      headers: auth,
    });
    expect(exported.statusCode, exported.body).toBe(200);

    const res = await fx2.app.inject({
      method: 'POST',
      url: '/v1/profiles/import',
      headers: { ...auth, 'content-type': 'application/json' },
      // The export body IS the envelope — there is no wrapper field.
      payload: { envelope: exported.json<unknown>(), name: 'imported' },
    });
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.TierLimit);
  });
});

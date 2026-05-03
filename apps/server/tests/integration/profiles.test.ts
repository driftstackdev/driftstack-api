// Integration tests for the V-081 Profiles surface (/v1/profiles).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
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
    expect(body.archetype).toBe('iphone16pro_ios26_4_1');
    expect(body.description).toBeNull();
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
    // trial_pack permits 1 profile; create one then expect the second to fail.
    fx = await buildTestApp({ tier: 'trial_pack' });
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
    for (const n of ['a', 'b', 'c']) {
      await fx.app.inject({
        method: 'POST',
        url: '/v1/profiles',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { name: n },
      });
    }
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

    const get = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(get.statusCode).toBe(404);
  });

  it('404 on unknown id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-000000000099',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

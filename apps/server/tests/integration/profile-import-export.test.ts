// V-480 — profile import/export integration tests. Metadata-only
// round-trip; per-profile browser state lives driver-side and is out
// of scope.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface ProfileResponse {
  id: string;
  name: string;
  archetype: string;
  description: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ExportEnvelope {
  version: number;
  exported_at: string;
  source_profile_id: string;
  source_account_id: string;
  profile: { name: string; archetype: string; description: string | null };
}

describe('GET /v1/profiles/:id/export', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 returns a v1 envelope with the profile metadata', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'shopper-acctA', description: 'returning checkout flow' },
    });
    const profile = create.json<ProfileResponse>();

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles/${profile.id}/export`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const env = res.json<ExportEnvelope>();
    expect(env.version).toBe(1);
    expect(env.source_profile_id).toBe(profile.id);
    expect(env.source_account_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.profile.name).toBe('shopper-acctA');
    expect(env.profile.archetype).toBe('iphone16pro_ios18_7_safari26_4');
    expect(env.profile.description).toBe('returning checkout flow');
    // exported_at is ISO-8601, near now.
    const ts = Date.parse(env.exported_at);
    expect(Date.now() - ts).toBeLessThan(5_000);
  });

  it('404 on unknown profile id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles/prof_00000000-0000-4000-8000-000000000abc/export',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 on malformed profile id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/profiles/notanid/export',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/profiles/import', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 mints a new profile from a v1 envelope', async () => {
    fx = await buildTestApp();
    const envelope = {
      version: 1 as const,
      exported_at: new Date().toISOString(),
      source_profile_id: 'prof_11111111-1111-4111-8111-111111111111',
      source_account_id: 'acc_22222222-2222-4222-8222-222222222222',
      profile: {
        name: 'imported-flow',
        archetype: 'iphone16pro_ios18_7_safari26_4',
        description: 'transferred from teammate',
      },
    };

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/import',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { envelope },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProfileResponse>();
    expect(body.id).toMatch(/^prof_[0-9a-f-]{36}$/);
    // Fresh id — not the source.
    expect(body.id).not.toBe(envelope.source_profile_id);
    expect(body.name).toBe('imported-flow');
    expect(body.archetype).toBe('iphone16pro_ios18_7_safari26_4');
    expect(body.description).toBe('transferred from teammate');
  });

  it('200 with name_override renames on import', async () => {
    fx = await buildTestApp();
    const envelope = {
      version: 1 as const,
      exported_at: new Date().toISOString(),
      source_profile_id: 'prof_11111111-1111-4111-8111-111111111111',
      source_account_id: 'acc_22222222-2222-4222-8222-222222222222',
      profile: {
        name: 'shopper-acctA',
        archetype: 'iphone16pro_ios18_7_safari26_4',
        description: null,
      },
    };
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/import',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        envelope,
        name_override: 'staging-shopper',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProfileResponse>();
    expect(body.name).toBe('staging-shopper');
  });

  it('409 ConflictError when target name already exists', async () => {
    fx = await buildTestApp();
    // Create the conflicting profile first.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'collision-name' },
    });
    const envelope = {
      version: 1 as const,
      exported_at: new Date().toISOString(),
      source_profile_id: 'prof_11111111-1111-4111-8111-111111111111',
      source_account_id: 'acc_22222222-2222-4222-8222-222222222222',
      profile: {
        name: 'collision-name',
        archetype: 'iphone16pro_ios18_7_safari26_4',
        description: null,
      },
    };
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/import',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { envelope },
    });
    expect(res.statusCode).toBe(409);
  });

  it('400 on envelope.version other than 1', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/import',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        envelope: {
          version: 2,
          exported_at: new Date().toISOString(),
          source_profile_id: 'prof_11111111-1111-4111-8111-111111111111',
          source_account_id: 'acc_22222222-2222-4222-8222-222222222222',
          profile: {
            name: 'whatever',
            archetype: 'iphone16pro_ios18_7_safari26_4',
            description: null,
          },
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Profile export → import round-trip', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('exports a profile, then imports the same envelope under a new name', async () => {
    fx = await buildTestApp();
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        name: 'roundtrip-source',
        description: 'pre-export description',
      },
    });
    const source = create.json<ProfileResponse>();

    const exp = await fx.app.inject({
      method: 'GET',
      url: `/v1/profiles/${source.id}/export`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const envelope = exp.json<ExportEnvelope>();

    const imp = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles/import',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        envelope,
        name_override: 'roundtrip-restored',
      },
    });
    expect(imp.statusCode).toBe(200);
    const restored = imp.json<ProfileResponse>();
    expect(restored.id).not.toBe(source.id);
    expect(restored.name).toBe('roundtrip-restored');
    expect(restored.archetype).toBe(source.archetype);
    expect(restored.description).toBe(source.description);
  });
});

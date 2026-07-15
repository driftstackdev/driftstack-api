import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ARCHETYPE_REGISTRY,
  CreateProfileRequestSchema,
  CreateSessionRequestSchema,
  LOCKED_ARCHETYPE_ID,
  ListArchetypesResponseSchema,
  ProfileImportRequestSchema,
  isSelectableArchetypeId,
} from '@driftstack/api-types';
import {
  ARCHETYPE_CATALOG_CACHE_MAX_AGE_SECONDS,
  registerArchetypeRoutes,
} from '../../src/routes/archetypes.js';

describe('GET /v1/archetypes', () => {
  const app = Fastify();
  registerArchetypeRoutes(app);

  afterAll(async () => {
    await app.close();
  });

  it('returns every selectable registry entry, the default, and a public cache policy', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/archetypes' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(
      `public, max-age=${ARCHETYPE_CATALOG_CACHE_MAX_AGE_SECONDS.toString()}`,
    );

    const body = ListArchetypesResponseSchema.parse(response.json());
    const selectable = ARCHETYPE_REGISTRY.filter(
      (entry) => entry.status === 'launch' || entry.status === 'available',
    );
    expect(body.default_archetype_id).toBe(LOCKED_ARCHETYPE_ID);
    expect(body.data).toHaveLength(selectable.length);
    expect(body.data.map((entry) => entry.id)).toEqual(selectable.map((entry) => entry.id));
    expect(body.data.filter((entry) => entry.is_default)).toEqual([
      expect.objectContaining({ id: LOCKED_ARCHETYPE_ID, status: 'launch' }),
    ]);
  });

  it('never exposes internal reference or planned registry entries', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/archetypes' });
    const body = ListArchetypesResponseSchema.parse(response.json());
    expect(
      body.data.every((entry) => entry.status === 'launch' || entry.status === 'available'),
    ).toBe(true);
    expect(body.data).not.toContainEqual(
      expect.objectContaining({ id: 'iphone15pro_ios17_5_safari17_5' }),
    );
  });

  it('uses the same selectable set for direct session/profile create and profile import', () => {
    const selectable = ARCHETYPE_REGISTRY.filter(
      (entry) => entry.status === 'launch' || entry.status === 'available',
    );
    for (const entry of selectable) {
      expect(isSelectableArchetypeId(entry.id)).toBe(true);
      expect(CreateSessionRequestSchema.safeParse({ archetype: entry.id }).success).toBe(true);
      expect(
        CreateProfileRequestSchema.safeParse({ name: 'valid', archetype: entry.id }).success,
      ).toBe(true);
    }

    for (const archetype of ['iphone15pro_ios17_5_safari17_5', 'unknown_ios18_7_safari26_4']) {
      expect(isSelectableArchetypeId(archetype)).toBe(false);
      expect(CreateSessionRequestSchema.safeParse({ archetype }).success).toBe(false);
      expect(CreateProfileRequestSchema.safeParse({ name: 'valid', archetype }).success).toBe(
        false,
      );
      expect(
        ProfileImportRequestSchema.safeParse({
          envelope: {
            version: 1,
            exported_at: new Date().toISOString(),
            source_profile_id: 'prof_11111111-1111-4111-8111-111111111111',
            source_account_id: 'acc_source',
            profile: { name: 'valid', archetype, description: null },
          },
        }).success,
      ).toBe(false);
    }
  });
});

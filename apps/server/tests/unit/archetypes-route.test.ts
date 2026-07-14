import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ARCHETYPE_REGISTRY,
  LOCKED_ARCHETYPE_ID,
  ListArchetypesResponseSchema,
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
});

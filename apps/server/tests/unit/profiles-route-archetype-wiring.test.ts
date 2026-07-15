// Integration test (app.inject) for the customer profiles route's create
// wiring, focused on the multi-archetype contract: POST /v1/profiles must
// forward the request's `archetype` to service.create when present, and OMIT
// the key entirely when the request leaves it out (so the service default
// applies — not an undefined value overriding it). That conditional spread in
// the handler is exactly the wiring a content-parity pin can't catch.
// profiles-service.test asserts persistence; this asserts the request→service
// hand-off + that the write scopes to the authed account.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { registerProfileRoutes } from '../../src/routes/profiles.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import type { ProfileRecord, ProfilesService } from '../../src/services/profiles.js';
import type { AccountAuthRepo } from '../../src/services/auth.js';

const ACC = '11111111-2222-3333-4444-555555555555';
const ARCHETYPE = 'iphone16pro_ios18_7_safari26_4';

function recordFor(name: string, archetype: string): ProfileRecord {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    accountId: ACC,
    name,
    archetype,
    description: null,
    folder: null,
    tags: [],
    lastUsedAt: null,
    sizeBytes: null,
    lastSavedAt: null,
    createdAt: new Date('2026-05-20T10:00:00.000Z'),
    updatedAt: new Date('2026-05-20T10:00:00.000Z'),
    deletedAt: null,
    icon: null,
    note: null,
  };
}

async function harness(): Promise<{
  app: FastifyInstance;
  createArgs: Array<Record<string, unknown>>;
}> {
  const createArgs: Array<Record<string, unknown>> = [];
  const service = {
    create: (args: Record<string, unknown>) => {
      createArgs.push(args);
      const archetype = typeof args.archetype === 'string' ? args.archetype : ARCHETYPE;
      return Promise.resolve(recordFor(String(args.name), archetype));
    },
  } as unknown as ProfilesService;
  // getAccount is only reached on a team-scoped write (X-Driftstack-Account
  // header); these tests are self-scoped, so it must never run.
  const authRepo = {
    getAccount: () => Promise.reject(new Error('getAccount must not run for a self-scoped write')),
  } as unknown as AccountAuthRepo;

  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireAuth', (req: FastifyRequest) => {
    (req as { account: unknown }).account = {
      account: { id: ACC, tier: 'solo_manual' },
      teams: [],
    };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerProfileRoutes(app, { service, authRepo });
  await app.ready();
  return { app, createArgs };
}

describe('profiles route — create archetype wiring (app.inject)', () => {
  it('POST /v1/profiles forwards the request archetype to service.create (scoped to the authed account)', async () => {
    const { app, createArgs } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/profiles',
      payload: { name: 'EU iPhone', archetype: ARCHETYPE },
    });
    expect(res.statusCode).toBe(200);
    expect(createArgs).toHaveLength(1);
    expect(createArgs[0]?.archetype).toBe(ARCHETYPE);
    expect(createArgs[0]?.accountId).toBe(ACC); // never a client-supplied account
    await app.close();
  });

  it('POST /v1/profiles OMITS the archetype key when the request leaves it out (service default applies)', async () => {
    const { app, createArgs } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/profiles',
      payload: { name: 'Default device' },
    });
    expect(res.statusCode).toBe(200);
    expect(createArgs).toHaveLength(1);
    // The key must be ABSENT (not present-but-undefined) — otherwise an
    // undefined archetype would override the service's default.
    expect('archetype' in (createArgs[0] ?? {})).toBe(false);
    await app.close();
  });

  it('POST /v1/profiles → 400 when name is missing (schema validation)', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'POST', url: '/v1/profiles', payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /v1/profiles rejects a well-formed unknown archetype before calling the service', async () => {
    const { app, createArgs } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/profiles',
      payload: { name: 'Unknown device', archetype: 'iphone99_ios99_safari99' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'https://errors.driftstack.dev/validation-failed',
      status: 400,
      issues: {
        fieldErrors: {
          archetype: ['archetype must be a selectable id returned by GET /v1/archetypes'],
        },
      },
    });
    expect(createArgs).toHaveLength(0);
    await app.close();
  });
});

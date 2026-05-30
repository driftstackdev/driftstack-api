// Integration test (app.inject) for the sessions route's id-prefix wiring.
// GET /v1/sessions/:id strips a `ses_<uuid>` public id to the bare uuid before
// the service lookup, scopes by the authed account, and round-trips the prefix
// on the way out. A malformed or wrong-prefix id is a 400 (BadRequest) — never
// a service call. Rule L cites a real SESSION_ID_RE prefix bug that integration
// tests caught; this pins the prefix contract (PUBLIC_ID_RE: exactly a 3-letter
// `ses_`, not the 4-letter `sess_` the dashboard once used in fake mock ids).

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { registerSessionRoutes } from '../../src/routes/sessions.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import type { SessionRecord, SessionsService } from '../../src/services/sessions.js';
import type { AccountAuthRepo } from '../../src/services/auth.js';

const ACC = '11111111-2222-3333-4444-555555555555';
const SESSION_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function sessionRecord(): SessionRecord {
  return {
    id: SESSION_UUID,
    accountId: ACC,
    apiKeyId: 'cccccccc-dddd-eeee-ffff-000000000000',
    status: 'ready',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    purpose: null,
    label: null,
    metadata: {},
    egressCapabilities: null,
    egressCapabilityReport: null,
    createdAt: new Date('2026-05-20T10:00:00.000Z'),
    updatedAt: new Date('2026-05-20T10:00:00.000Z'),
    lastStateAt: null,
    destroyedAt: null,
  } as unknown as SessionRecord;
}

async function harness(): Promise<{ app: FastifyInstance; describeIds: string[] }> {
  const describeIds: string[] = [];
  const service = {
    describe: (_ctx: unknown, id: string) => {
      describeIds.push(id);
      return Promise.resolve(sessionRecord());
    },
  } as unknown as SessionsService;
  const authRepo = {
    getAccount: () => Promise.reject(new Error('getAccount must not run for a self-scoped read')),
  } as unknown as AccountAuthRepo;

  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireAuth', (req: FastifyRequest) => {
    (req as { account: unknown }).account = { account: { id: ACC }, teams: [] };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerSessionRoutes(app, { service, authRepo });
  await app.ready();
  return { app, describeIds };
}

describe('sessions route — id-prefix wiring (app.inject)', () => {
  it('GET /v1/sessions/ses_<uuid> strips the prefix to a bare uuid before the service, re-prefixes on output', async () => {
    const { app, describeIds } = await harness();
    const res = await app.inject({ method: 'GET', url: `/v1/sessions/ses_${SESSION_UUID}` });
    expect(res.statusCode).toBe(200);
    expect(describeIds).toEqual([SESSION_UUID]); // BARE uuid, prefix stripped
    expect(res.payload).toContain(`ses_${SESSION_UUID}`); // re-prefixed on output
    await app.close();
  });

  it('GET /v1/sessions/sess_<uuid> → 400 (the 4-letter prefix is not the ses_ contract)', async () => {
    const { app, describeIds } = await harness();
    const res = await app.inject({ method: 'GET', url: `/v1/sessions/sess_${SESSION_UUID}` });
    expect(res.statusCode).toBe(400);
    expect(describeIds).toEqual([]); // never reached the service
    await app.close();
  });

  it('GET /v1/sessions/:id → 400 for a non-prefixed id', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/not-an-id' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

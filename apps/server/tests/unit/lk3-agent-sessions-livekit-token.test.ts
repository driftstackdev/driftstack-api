// LK.3 — POST /v1/agent-sessions/:id/livekit-token unit tests.
// Sweeps the auth + ownership + Mac-availability paths against
// a stubbed Fastify instance — no Drizzle DB required.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { randomBytes } from 'node:crypto';
import {
  registerAgentSessionsLivekitTokenRoute,
  LIVEKIT_TOKEN_TTL_SECONDS,
} from '../../src/routes/agent-sessions-livekit-token.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { DrizzleFleetNodesRepo, FleetNodeDetail } from '../../src/db/fleet-nodes-repo.js';

const stubAuthPlugin = fp(
  (_app, _opts, done) => {
    done();
  },
  { name: 'auth' },
);

const ACCOUNT_ID = 'acc_lk3_owner';
const OTHER_ACCOUNT_ID = 'acc_other';
const SESSION_ID = 'agt_11111111-2222-3333-4444-555555555555';

function makeKey(): string {
  return randomBytes(32).toString('base64');
}

function makeSession(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: SESSION_ID,
    accountId: ACCOUNT_ID,
    driftstackSessionId: null,
    status: 'active',
    transcript: [],
    tokenBudgetTotal: 100_000,
    tokenBudgetRemaining: 99_000,
    closedReason: null,
    idempotencyKey: null,
    createdByUserId: null,
    closedAt: null,
    pairModeState: null,
    guiControlKeyExpiresAt: null,
    guiControlKeyCiphertext: null,
    mode: 'ai',
    createdAt: new Date('2026-05-18T12:00:00Z'),
    updatedAt: new Date('2026-05-18T12:00:00Z'),
    ...overrides,
  };
}

function makeMac(
  args: {
    encryptionKey: string;
    apiKey?: string;
    apiSecret?: string;
    wsUrl?: string;
  } = { encryptionKey: '' },
): FleetNodeDetail {
  const apiSecret = args.apiSecret ?? 'lk_secret_macmac_macmac_macmac_macmac';
  return {
    id: 'fleet_mac_test',
    publicKeyBase64Url: 'A'.repeat(43) + '=',
    displayName: 'mac-test-01',
    region: 'eu-central-1',
    hardwareClass: 'mac-mini-m4',
    registeredAt: new Date('2026-05-18T00:00:00Z'),
    lastSeenAt: null,
    revokedAt: null,
    revocationReason: null,
    livekit: {
      apiKey: args.apiKey ?? 'lk_api_test_xxx',
      apiSecretCiphertextBase64: encryptLivekitSecret(apiSecret, args.encryptionKey),
      wsUrl: args.wsUrl ?? 'wss://mac-test-01.driftstack.dev:8443',
      registeredAt: new Date('2026-05-18T01:00:00Z'),
    },
  };
}

function makeStubAgentSessionsRepo(session: AgentSessionRecord | null): AgentSessionsRepo {
  return {
    get: () => Promise.resolve(session),
  } as unknown as AgentSessionsRepo;
}

function makeStubFleetRepo(mac: FleetNodeDetail | null): DrizzleFleetNodesRepo {
  return {
    findAnyWithLivekit: () => Promise.resolve(mac),
  } as unknown as DrizzleFleetNodesRepo;
}

async function buildApp(args: {
  session: AgentSessionRecord | null;
  mac: FleetNodeDetail | null;
  encryptionKey: string;
  callerAccountId?: string;
}) {
  const app = Fastify();
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: args.callerAccountId ?? ACCOUNT_ID, tier: 'starter' },
      apiKey: { id: 'key_lk3', scopes: ['read', 'write'] },
    };
    done();
  });
  await app.register(stubAuthPlugin);
  app.decorate('rateLimit', () => (_req: unknown, _reply: unknown, done: () => void) => done());
  app.decorate('requireAuth', (_req: unknown, _reply: unknown, done: () => void) => done());
  registerAgentSessionsLivekitTokenRoute(app, {
    fleetNodesRepo: makeStubFleetRepo(args.mac),
    agentSessionsRepo: makeStubAgentSessionsRepo(args.session),
    encryptionKey: args.encryptionKey,
  });
  await app.ready();
  return app;
}

describe('LK.3 — POST /v1/agent-sessions/:id/livekit-token', () => {
  let key: string;
  beforeEach(() => {
    key = makeKey();
  });

  it('200 — happy path: returns ws_url + room + token + participant_identity + expires_at', async () => {
    const app = await buildApp({
      session: makeSession(),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, string>>();
    expect(body.ws_url).toBe('wss://mac-test-01.driftstack.dev:8443');
    expect(body.room).toBe(SESSION_ID);
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(3); // JWT triplet
    expect(body.participant_identity).toBe(`customer-${ACCOUNT_ID}`);
    expect(body.expires_at).toBeTruthy();
    // expires_at must be 24h in the future (LIVEKIT_TOKEN_TTL_SECONDS).
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(
      Date.now() + (LIVEKIT_TOKEN_TTL_SECONDS - 60) * 1000,
    );
    await app.close();
  });

  it('404 — malformed agent_session id (anti-enumeration cheap reject)', async () => {
    const app = await buildApp({
      session: makeSession(),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/not-a-valid-id/livekit-token',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404 — unknown session id (repo returns null)', async () => {
    const app = await buildApp({
      session: null,
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404 — cross-account access (caller does not own the session)', async () => {
    const app = await buildApp({
      session: makeSession({ accountId: OTHER_ACCOUNT_ID }),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('403 — agent session is closed (cannot mint a token for non-active session)', async () => {
    const app = await buildApp({
      session: makeSession({ status: 'closed', closedReason: 'budget-exhausted' }),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('503 — no Mac in the fleet has LiveKit credentials yet', async () => {
    const app = await buildApp({
      session: makeSession(),
      mac: null,
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    // The unit-test app doesn't register the global error handler
    // that turns FeatureUnavailableError into a problem+json body —
    // assertion is on the status code only. The full body shape is
    // pinned by the integration suite that runs the real app.
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('503 — Mac secret is unreadable (wrong encryption key — surfaces as ops-actionable)', async () => {
    // Encrypt with one key, build the route with a different key.
    const macKey = makeKey();
    const routeKey = makeKey();
    const app = await buildApp({
      session: makeSession(),
      mac: makeMac({ encryptionKey: macKey }),
      encryptionKey: routeKey,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('token participant_identity is customer-<account-id> (SFU dedup key)', async () => {
    const app = await buildApp({
      session: makeSession(),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    const body = res.json<Record<string, string>>();
    expect(body.participant_identity).toBe(`customer-${ACCOUNT_ID}`);
    await app.close();
  });

  it('token room name is the agent_session id (one room per session)', async () => {
    const app = await buildApp({
      session: makeSession(),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    const body = res.json<Record<string, string>>();
    expect(body.room).toBe(SESSION_ID);
    await app.close();
  });
});

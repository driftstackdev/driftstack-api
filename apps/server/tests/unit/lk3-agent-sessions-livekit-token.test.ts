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
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

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
    lastErrorEvent: null,
    guiControlKeyExpiresAt: null,
    guiControlKeyCiphertext: null,
    mode: 'ai',
    model: 'claude-opus-4-7',
    nodeId: null,
    profileId: null,
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
    nodeId: 'mac-test-01',
    publicKeyBase64Url: 'A'.repeat(43) + '=',
    displayName: 'mac-test-01',
    region: 'eu-central-1',
    hardwareClass: 'mac-mini-m4',
    registeredAt: new Date('2026-05-18T00:00:00Z'),
    lastSeenAt: null,
    lastHeartbeat: null,
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

function makeStubFleetRepo(
  mac: FleetNodeDetail | null,
  boundMacs?: Record<string, FleetNodeDetail | null>,
): DrizzleFleetNodesRepo {
  return {
    findAnyWithLivekit: () => Promise.resolve(mac),
    // maybeMintLivekit is now region-aware (consistent with the publisher
    // dispatch); the stub returns the same `nearest` node regardless of region.
    findNearestWithLivekit: () => Promise.resolve(mac),
    // Audit fix: the re-mint binds to the session's node_id via this lookup.
    // The stub resolves from an injected map (keyed by the session's node_id);
    // unknown keys → null (→ resolveSessionPublisherNode falls back to nearest).
    getDetailByNodeIdOrId: (key: string) => Promise.resolve(boundMacs?.[key] ?? null),
  } as unknown as DrizzleFleetNodesRepo;
}

async function buildApp(args: {
  session: AgentSessionRecord | null;
  mac: FleetNodeDetail | null;
  /** Optional node_id → bound Mac map, resolved by getDetailByNodeIdOrId. */
  boundMacs?: Record<string, FleetNodeDetail | null>;
  encryptionKey: string;
  callerAccountId?: string;
  /** Team memberships on the caller's ctx (real AccountContext always has this
   *  array — the route now resolves team-admin access via callerCanAccessAgentSession). */
  teams?: Array<{ ownerAccountId: string; role: 'member' | 'admin' }>;
  metrics?: MetricsRegistry;
}) {
  const app = Fastify();
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: args.callerAccountId ?? ACCOUNT_ID, tier: 'starter' },
      apiKey: { id: 'key_lk3', scopes: ['read', 'write'] },
      teams: args.teams ?? [],
    };
    done();
  });
  await app.register(stubAuthPlugin);
  app.decorate('rateLimit', () => async () => {});
  app.decorate('requireAuth', async () => {});
  // requireScope: no-op stub — the route now gates the (control-bearing,
  // canPublishData:true) token mint to write scope (audit wxzlp9yiz #3). The
  // onRequest hook above already grants ['read','write'], so a real check would
  // pass; the stub just satisfies the decorator at registration.
  app.decorate('requireScope', () => async () => {});
  registerAgentSessionsLivekitTokenRoute(app, {
    fleetNodesRepo: makeStubFleetRepo(args.mac, args.boundMacs),
    agentSessionsRepo: makeStubAgentSessionsRepo(args.session),
    encryptionKey: args.encryptionKey,
    ...(args.metrics !== undefined ? { metrics: args.metrics } : {}),
  });
  await app.ready();
  return app;
}

function makeMetrics(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.livekitTokenMintTotal, 'LiveKit token mint outcomes.', [
    'role',
    'outcome',
  ]);
  return m;
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
    // Typed response shape — `noUncheckedIndexedAccess: true` makes
    // Record<string, string> return string|undefined on every key
    // access, so use a concrete interface with non-optional fields.
    // Define the response shape inline so noUncheckedIndexedAccess
    // doesn't make every property string|undefined (which tripped
    // TS18048 on body.token.split('.') before this typing).
    type TokenBody = {
      ws_url: string;
      room: string;
      token: string;
      participant_identity: string;
      expires_at: string;
    };
    const body: TokenBody = res.json();
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

  it('200 — binds the token to the session node_id (the PUBLISHING Mac), NOT the most-recently-registered Mac (multi-LiveKit-box correctness)', async () => {
    // Mac-A publishes this session (agent_sessions.node_id = mac-A-01). Mac-B is
    // more-recently LiveKit-registered, so findNearestWithLivekit would hand the
    // viewer Mac-B's token → empty room on Mac-B (black screen + dead control).
    const macA: FleetNodeDetail = {
      ...makeMac({
        encryptionKey: key,
        apiKey: 'lk_api_A',
        wsUrl: 'wss://mac-A.driftstack.dev:8443',
      }),
      id: 'fleet_mac_A',
      nodeId: 'mac-A-01',
    };
    const macB: FleetNodeDetail = {
      ...makeMac({
        encryptionKey: key,
        apiKey: 'lk_api_B',
        wsUrl: 'wss://mac-B.driftstack.dev:8443',
      }),
      id: 'fleet_mac_B',
      nodeId: 'mac-B-02',
    };
    const app = await buildApp({
      session: makeSession({ nodeId: 'mac-A-01' }),
      mac: macB, // findNearestWithLivekit returns the WRONG (latest-registered) Mac
      boundMacs: { 'mac-A-01': macA }, // the session's bound, publishing Mac
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    expect(res.statusCode).toBe(200);
    // The ws_url must be Mac-A's (the publishing box), never Mac-B's.
    expect(res.json<Record<string, string>>().ws_url).toBe('wss://mac-A.driftstack.dev:8443');
    await app.close();
  });

  it('200 — falls back to findNearestWithLivekit when node_id is NULL (legacy / not-yet-dispatched session)', async () => {
    const nearest = makeMac({ encryptionKey: key, wsUrl: 'wss://nearest.driftstack.dev:8443' });
    const app = await buildApp({
      session: makeSession({ nodeId: null }),
      mac: nearest,
      boundMacs: {}, // nothing bound → getDetailByNodeIdOrId returns null
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, string>>().ws_url).toBe('wss://nearest.driftstack.dev:8443');
    await app.close();
  });

  it('200 — bound node exists but has no LiveKit creds → falls back to region-nearest (graceful, not a 500)', async () => {
    const nearest = makeMac({ encryptionKey: key, wsUrl: 'wss://nearest.driftstack.dev:8443' });
    const boundNoCreds: FleetNodeDetail = {
      ...makeMac({ encryptionKey: key }),
      id: 'fleet_mac_X',
      nodeId: 'mac-X',
      livekit: null,
    };
    const app = await buildApp({
      session: makeSession({ nodeId: 'mac-X' }),
      mac: nearest,
      boundMacs: { 'mac-X': boundNoCreds },
      encryptionKey: key,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, string>>().ws_url).toBe('wss://nearest.driftstack.dev:8443');
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

  it('200 — team ADMIN of the owning account can mint the token (team-RBAC, not raw owner-equality)', async () => {
    const app = await buildApp({
      session: makeSession({ accountId: OTHER_ACCOUNT_ID }),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
      // Caller is ACCOUNT_ID but is an ADMIN member of OTHER_ACCOUNT_ID (the owner).
      teams: [{ ownerAccountId: OTHER_ACCOUNT_ID, role: 'admin' }],
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('404 — team MEMBER (non-admin) of the owning account cannot mint the token', async () => {
    const app = await buildApp({
      session: makeSession({ accountId: OTHER_ACCOUNT_ID }),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
      teams: [{ ownerAccountId: OTHER_ACCOUNT_ID, role: 'member' }],
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

  // Metric instrumentation — reuses the existing
  // livekit_token_mint_total counter from obs.12 with
  // role='subscriber' on the agent-sessions surface.
  it('metric: 200 happy path emits {role=subscriber, outcome=ok}', async () => {
    const metrics = makeMetrics();
    const app = await buildApp({
      session: makeSession(),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
      metrics,
    });
    await app.inject({ method: 'POST', url: `/v1/agent-sessions/${SESSION_ID}/livekit-token` });
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, {
        role: 'subscriber',
        outcome: 'ok',
      }),
    ).toBe(1);
    await app.close();
  });

  it('metric: 404 paths emit {role=subscriber, outcome=not_found}', async () => {
    const metrics = makeMetrics();
    const app = await buildApp({
      session: null,
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
      metrics,
    });
    await app.inject({ method: 'POST', url: `/v1/agent-sessions/${SESSION_ID}/livekit-token` });
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, {
        role: 'subscriber',
        outcome: 'not_found',
      }),
    ).toBe(1);
    await app.close();
  });

  it('metric: 403 closed session emits {role=subscriber, outcome=forbidden}', async () => {
    const metrics = makeMetrics();
    const app = await buildApp({
      session: makeSession({ status: 'closed', closedReason: 'budget-exhausted' }),
      mac: makeMac({ encryptionKey: key }),
      encryptionKey: key,
      metrics,
    });
    await app.inject({ method: 'POST', url: `/v1/agent-sessions/${SESSION_ID}/livekit-token` });
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, {
        role: 'subscriber',
        outcome: 'forbidden',
      }),
    ).toBe(1);
    await app.close();
  });

  it('metric: no-Mac-yet emits {role=subscriber, outcome=no_mac}', async () => {
    const metrics = makeMetrics();
    const app = await buildApp({
      session: makeSession(),
      mac: null,
      encryptionKey: key,
      metrics,
    });
    await app.inject({ method: 'POST', url: `/v1/agent-sessions/${SESSION_ID}/livekit-token` });
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, {
        role: 'subscriber',
        outcome: 'no_mac',
      }),
    ).toBe(1);
    await app.close();
  });

  it('metric: wrong encryption key emits {role=subscriber, outcome=secret_unreadable}', async () => {
    const metrics = makeMetrics();
    const macKey = makeKey();
    const routeKey = makeKey();
    const app = await buildApp({
      session: makeSession(),
      mac: makeMac({ encryptionKey: macKey }),
      encryptionKey: routeKey,
      metrics,
    });
    await app.inject({ method: 'POST', url: `/v1/agent-sessions/${SESSION_ID}/livekit-token` });
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, {
        role: 'subscriber',
        outcome: 'secret_unreadable',
      }),
    ).toBe(1);
    await app.close();
  });

  it('metric: omitted registry is a silent no-op (does not throw)', async () => {
    // No `metrics` field on buildApp — route works fine without.
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
    await app.close();
  });
});

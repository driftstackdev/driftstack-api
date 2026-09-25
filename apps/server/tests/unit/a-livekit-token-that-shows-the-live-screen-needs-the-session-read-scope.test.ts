// A LiveKit token that shows the live screen needs the agent-session read scope
// (security sweep #14).
//
// POST /v1/agent-sessions/:id/livekit-token returns a token that joins the
// session's room with canSubscribe (the holder WATCHES the live screen — the pages
// the agent has open) and canPublishData (the holder sends it input). Its account
// path required only bare `write`. Every other way to see the session live — GET
// /:id, page-state, cookies, downloads, the transcript stream — requires
// `read:sessions`, and the control-key mint requires `write` AND `read:sessions`
// precisely so a write-only key cannot reach reads (V-776). A key scoped ['write']
// (a CI launcher, say) was refused every one of those reads and could still mint a
// viewer token for any of the account's sessions and watch it.
//
// So the account path now requires what watching requires AND what driving
// requires: `write` and `read:sessions`. Broad `read` + `write`, and `account_owner`
// (the desktop app's device key), satisfy both, so nothing the desktop app sends is
// refused. The per-session control key still mints for its own session, and only
// its own, with no account scope at all.
//
// The scope gate here is the REAL predicate (services/auth.ts `requireScope`), the
// one the auth plugin's `app.requireScope` runs: a stub that only checked
// `scopes.includes(x)` would refuse `read` for `read:sessions` and prove nothing.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { randomBytes } from 'node:crypto';
import type { ApiKeyScope } from '@driftstack/api-types';
import { registerAgentSessionsLivekitTokenRoute } from '../../src/routes/agent-sessions-livekit-token.js';
import { requireScope, type AccountContext } from '../../src/services/auth.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import { encryptGuiControlKey } from '../../src/lib/gui-control-key-encryption.js';
import { UnauthorizedError } from '../../src/lib/errors.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { DrizzleFleetNodesRepo, FleetNodeDetail } from '../../src/db/fleet-nodes-repo.js';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const SESSION_ID = 'agt_11111111-2222-3333-4444-555555555555';
const OTHER_SESSION_ID = 'agt_99999999-2222-3333-4444-555555555555';
const MAC_UUID = '22222222-2222-4222-8222-222222222222';
const CONTROL_KEY = 'gck_abcdefghijklmnopqrstuvwxyz234567';
/** The test's own header carrying the caller key's scopes, comma-separated. */
const SCOPES_HEADER = 'x-test-scopes';

const stubAuthPlugin = fp(
  (_app, _opts, done) => {
    done();
  },
  { name: 'auth' },
);

function mac(encryptionKey: string): FleetNodeDetail {
  const apiKey = 'lk_api_test_xxx';
  const wsUrl = 'wss://mac-test-01.driftstack.dev:8443';
  return {
    id: MAC_UUID,
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
      apiKey,
      apiSecretCiphertextBase64: encryptLivekitSecret(
        'lk_secret_macmac_macmac_macmac_macmac',
        encryptionKey,
        { nodeId: MAC_UUID, apiKey, wsUrl },
      ),
      wsUrl,
      registeredAt: new Date('2026-05-18T01:00:00Z'),
    },
  };
}

function session(id: string, controlKeyEncryptionKey: string): AgentSessionRecord {
  return {
    id,
    accountId: OWNER,
    driftstackSessionId: null,
    proxyId: null,
    stopOnExitIpChange: false,
    firstExitIp: null,
    profileSaveBackRefused: false,
    status: 'active',
    transcript: [],
    tokenBudgetTotal: 100_000,
    tokenBudgetRemaining: 99_000,
    closedReason: null,
    provisioningDetail: null,
    idempotencyKey: null,
    createdByUserId: null,
    closedAt: null,
    pairModeState: null,
    lastErrorEvent: null,
    guiControlKeyExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    guiControlKeyCiphertext: encryptGuiControlKey(CONTROL_KEY, controlKeyEncryptionKey, {
      accountId: OWNER,
      sessionId: id,
    }),
    guiControlKeyMintedBy: {
      accountId: OWNER,
      apiKeyId: '00000000-0000-4000-8000-00000000de51',
      webSessionId: null,
      membershipId: null,
    },
    mode: 'ai',
    model: 'claude-opus-4-7',
    nodeId: 'mac-test-01',
    profileId: null,
    createdAt: new Date('2026-05-18T12:00:00Z'),
    updatedAt: new Date('2026-05-18T12:00:00Z'),
  };
}

async function app() {
  const livekitKey = randomBytes(32).toString('base64');
  const controlKeyKey = randomBytes(32).toString('base64');
  const sessions = new Map([
    [SESSION_ID, session(SESSION_ID, controlKeyKey)],
    [OTHER_SESSION_ID, session(OTHER_SESSION_ID, controlKeyKey)],
  ]);
  // The second session holds a DIFFERENT key, so this session's key must not open it.
  const other = sessions.get(OTHER_SESSION_ID)!;
  other.guiControlKeyCiphertext = encryptGuiControlKey(
    'gck_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    controlKeyKey,
    { accountId: OWNER, sessionId: OTHER_SESSION_ID },
  );
  const repo = {
    get: (id: string) => Promise.resolve(sessions.get(id) ?? null),
    isGuiControlKeyMinterLive: () => Promise.resolve(true),
    clearGuiControlKeyIfUnchanged: () => Promise.resolve(true),
  } as unknown as AgentSessionsRepo;
  const box = mac(livekitKey);
  const fleet = {
    findAnyWithLivekit: () => Promise.resolve(box),
    findNearestWithLivekit: () => Promise.resolve(box),
    getDetailByNodeIdOrId: () => Promise.resolve(box),
  } as unknown as DrizzleFleetNodesRepo;

  const server = Fastify();
  server.decorateRequest('account', null);
  await server.register(stubAuthPlugin);
  server.decorate('rateLimit', () => async () => {});
  // requireAuth: the caller is the session owner, holding a key with the scopes the
  // test names; no scopes header means no credential at all.
  const requireAuth = (req: FastifyRequest): Promise<void> => {
    const raw = req.headers[SCOPES_HEADER];
    if (typeof raw !== 'string') return Promise.reject(new UnauthorizedError('no credential'));
    req.account = {
      account: { id: OWNER, tier: 'api_scale', region: null, status: 'active' },
      apiKey: { id: 'key_caller', accountId: OWNER, scopes: raw.split(',') as ApiKeyScope[] },
      teams: [],
      webSession: null,
      rateLimitOverrides: {},
    } as unknown as AccountContext;
    return Promise.resolve();
  };
  server.decorate('requireAuth', requireAuth);
  // The auth plugin's decorator, over the REAL predicate.
  server.decorate('requireScope', (scope: ApiKeyScope) => {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      if (!req.account) await requireAuth(req);
      if (req.account) requireScope(req.account, scope);
    };
  });
  registerAgentSessionsLivekitTokenRoute(server, {
    fleetNodesRepo: fleet,
    agentSessionsRepo: repo,
    encryptionKey: livekitKey,
    guiControlKeyEncryptionKey: controlKeyKey,
  });
  await server.ready();
  return server;
}

async function mintWith(
  server: Awaited<ReturnType<typeof app>>,
  headers: Record<string, string>,
  sessionId = SESSION_ID,
): Promise<{ status: number; token: unknown }> {
  const res = await server.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${sessionId}/livekit-token`,
    headers,
  });
  return { status: res.statusCode, token: res.json<{ token?: unknown }>().token };
}

describe('a LiveKit token that shows the live screen needs the session read scope', () => {
  it('CRITICAL a key scoped only to `write` gets 403 and no token — the same refusal it gets reading the session any other way', async () => {
    const server = await app();
    const res = await mintWith(server, { [SCOPES_HEADER]: 'write' });
    expect(res.status, 'a write-only key minted a token that watches the live screen').toBe(403);
    expect(res.token).toBeUndefined();
    await server.close();
  });

  it('a key scoped only to reads still gets 403: the token also sends the session input, so `write` stays required', async () => {
    const server = await app();
    expect((await mintWith(server, { [SCOPES_HEADER]: 'read' })).status).toBe(403);
    expect((await mintWith(server, { [SCOPES_HEADER]: 'read:sessions' })).status).toBe(403);
    await server.close();
  });

  it('CRITICAL every credential that can both watch and drive still mints: write + read:sessions, broad read + write, and account_owner (the desktop app’s device key)', async () => {
    const server = await app();
    for (const scopes of [
      'write,read:sessions',
      'read,write',
      'account_owner',
      'read,write,account_owner',
    ]) {
      const res = await mintWith(server, { [SCOPES_HEADER]: scopes });
      expect(res.status, scopes).toBe(200);
      expect(typeof res.token, scopes).toBe('string');
    }
    await server.close();
  });

  it('the per-session control key still mints for its own session with no account scope at all, and for no other session', async () => {
    const server = await app();
    const own = await mintWith(server, { 'x-driftstack-gui-control-key': CONTROL_KEY });
    expect(own.status).toBe(200);
    expect(typeof own.token).toBe('string');
    const other = await mintWith(
      server,
      { 'x-driftstack-gui-control-key': CONTROL_KEY },
      OTHER_SESSION_ID,
    );
    expect(other.status).toBe(401);
    await server.close();
  });
});

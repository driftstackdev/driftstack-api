// A LiveKit token minted through a session control key lives ten minutes, and the
// control key that mints it dies with its minter (security sweep #2).
//
// POST /v1/agent-sessions/:id/livekit-token accepts the per-session control key in
// place of an account credential. The token it returns lets the holder watch the
// session and send it input, and the SFU checks that token ONLY at the handshake —
// there is no call back to re-check who minted it. So:
//
//   · the control key must still be live when it mints (its minting credential and
//     membership re-checked, as on every other control-key gate), and a key whose
//     minter no longer holds gets 401 and is cleared;
//   · the token it mints must be short-lived, because its own expiry is the only
//     bound on how long a key-holder the owner has since removed can start a
//     connection. It lived 24 hours. It now lives ten minutes. The desktop app
//     never mints through this path (its Simulator receives its token from the main
//     app, which mints with the account credential), so only a caller that mints
//     right before connecting uses it;
//   · the account-credential mint keeps its 24 hours: the desktop app reuses that
//     one token for every reconnect of the session and never refreshes it.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { randomBytes } from 'node:crypto';
import {
  registerAgentSessionsLivekitTokenRoute,
  LIVEKIT_TOKEN_TTL_SECONDS,
} from '../../src/routes/agent-sessions-livekit-token.js';
import * as livekitTokenRoute from '../../src/routes/agent-sessions-livekit-token.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import { encryptGuiControlKey } from '../../src/lib/gui-control-key-encryption.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { DrizzleFleetNodesRepo, FleetNodeDetail } from '../../src/db/fleet-nodes-repo.js';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const SESSION_ID = 'agt_11111111-2222-3333-4444-555555555555';
const MAC_UUID = '22222222-2222-4222-8222-222222222222';
const CONTROL_KEY = 'gck_abcdefghijklmnopqrstuvwxyz234567';
const TEN_MINUTES_S = 10 * 60;

const stubAuthPlugin = fp(
  (_app, _opts, done) => {
    done();
  },
  { name: 'auth' },
);

function macWith(encryptionKey: string): FleetNodeDetail {
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

function sessionWith(controlKeyEncryptionKey: string, minted: boolean): AgentSessionRecord {
  return {
    id: SESSION_ID,
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
      sessionId: SESSION_ID,
    }),
    guiControlKeyMintedBy: minted
      ? {
          accountId: OWNER,
          apiKeyId: '00000000-0000-4000-8000-00000000de51',
          webSessionId: null,
          membershipId: null,
        }
      : null,
    mode: 'ai',
    model: 'claude-opus-4-7',
    nodeId: 'mac-test-01',
    profileId: null,
    createdAt: new Date('2026-05-18T12:00:00Z'),
    updatedAt: new Date('2026-05-18T12:00:00Z'),
  };
}

interface Harness {
  inject: (headers: Record<string, string>) => Promise<{ status: number; body: TokenBody }>;
  cleared: Array<{ id: string; ciphertext: Buffer }>;
  close: () => Promise<void>;
}

interface TokenBody {
  token?: string;
  expires_at?: string;
}

async function harness(opts: { minterLive: boolean; recordMinter?: boolean }): Promise<Harness> {
  const livekitKey = randomBytes(32).toString('base64');
  const controlKeyKey = randomBytes(32).toString('base64');
  const session = sessionWith(controlKeyKey, opts.recordMinter ?? true);
  const mac = macWith(livekitKey);
  const cleared: Array<{ id: string; ciphertext: Buffer }> = [];
  const repo = {
    get: () => Promise.resolve(session),
    isGuiControlKeyMinterLive: () => Promise.resolve(opts.minterLive),
    clearGuiControlKeyIfUnchanged: (a: { id: string; ciphertext: Buffer }) => {
      cleared.push(a);
      return Promise.resolve(true);
    },
  } as unknown as AgentSessionsRepo;
  const fleet = {
    findAnyWithLivekit: () => Promise.resolve(mac),
    findNearestWithLivekit: () => Promise.resolve(mac),
    getDetailByNodeIdOrId: () => Promise.resolve(mac),
  } as unknown as DrizzleFleetNodesRepo;

  const app = Fastify();
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    // The account path's caller: the owner, with an ordinary read+write key.
    if (req.headers.authorization !== undefined) {
      (req as { account: unknown }).account = {
        account: { id: OWNER, tier: 'api_scale', region: null },
        apiKey: { id: 'key_owner', scopes: ['read', 'write'] },
        teams: [],
      };
    }
    done();
  });
  await app.register(stubAuthPlugin);
  app.decorate('rateLimit', () => async () => {});
  app.decorate('requireAuth', async () => {});
  app.decorate('requireScope', () => async () => {});
  registerAgentSessionsLivekitTokenRoute(app, {
    fleetNodesRepo: fleet,
    agentSessionsRepo: repo,
    encryptionKey: livekitKey,
    guiControlKeyEncryptionKey: controlKeyKey,
  });
  await app.ready();
  return {
    inject: async (headers) => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent-sessions/${SESSION_ID}/livekit-token`,
        headers,
      });
      return { status: res.statusCode, body: res.json<TokenBody>() };
    },
    cleared,
    close: () => app.close(),
  };
}

/** The token's own lifetime, read from its signed claims (exp − nbf, else exp − iat). */
function lifetimeSeconds(token: string): number {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
    exp: number;
    nbf?: number;
    iat?: number;
  };
  return payload.exp - (payload.nbf ?? payload.iat ?? 0);
}

describe('a LiveKit token minted through a control key lives ten minutes and dies with its minter', () => {
  it('CRITICAL a control-key mint answers a token whose signed lifetime, and whose expires_at, is ten minutes — not the account mint’s 24 hours', async () => {
    const h = await harness({ minterLive: true });
    const before = Date.now();
    const res = await h.inject({ 'x-driftstack-gui-control-key': CONTROL_KEY });
    expect(res.status).toBe(200);
    expect(lifetimeSeconds(res.body.token ?? '')).toBe(TEN_MINUTES_S);
    const expiresAt = new Date(res.body.expires_at ?? '').getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + TEN_MINUTES_S * 1000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + TEN_MINUTES_S * 1000 + 1000);
    await h.close();
  });

  it('the exported constant says the same ten minutes the token carries', () => {
    expect(
      (livekitTokenRoute as Record<string, unknown>).LIVEKIT_CONTROL_KEY_TOKEN_TTL_SECONDS,
    ).toBe(TEN_MINUTES_S);
  });

  it('the account-credential mint keeps its 24 hours: the desktop app reuses that token for every reconnect', async () => {
    const h = await harness({ minterLive: true });
    const res = await h.inject({ authorization: 'Bearer ds_live_owner' });
    expect(res.status).toBe(200);
    expect(lifetimeSeconds(res.body.token ?? '')).toBe(LIVEKIT_TOKEN_TTL_SECONDS);
    expect(LIVEKIT_TOKEN_TTL_SECONDS).toBe(24 * 60 * 60);
    await h.close();
  });

  it('CRITICAL a matching control key whose minter no longer holds mints nothing: 401, and the stored key is cleared', async () => {
    const h = await harness({ minterLive: false });
    const res = await h.inject({ 'x-driftstack-gui-control-key': CONTROL_KEY });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
    expect(h.cleared.map((c) => c.id)).toEqual([SESSION_ID]);
    await h.close();
  });

  it('a matching control key with no recorded minter (minted before migration 0142) mints nothing either', async () => {
    const h = await harness({ minterLive: true, recordMinter: false });
    const res = await h.inject({ 'x-driftstack-gui-control-key': CONTROL_KEY });
    expect(res.status).toBe(401);
    expect(h.cleared).toHaveLength(1);
    await h.close();
  });
});

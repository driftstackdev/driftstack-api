import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { ForbiddenError, InvalidKeyError } from '../../src/lib/errors.js';
import authPlugin from '../../src/middleware/auth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { authenticate, type AccountRow } from '../../src/services/auth.js';
import { InMemoryOAuthStore, OAuthService } from '../../src/services/oauth.js';
import { InMemoryAuthRepo } from '../integration/_helpers/in-memory-auth-repo.js';

const NOW = Date.now();
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000101';

function account(status: AccountRow['status'] = 'active'): AccountRow {
  return {
    id: ACCOUNT_ID,
    email: 'oauth-api-auth@driftstack.test',
    name: 'OAuth API auth',
    tier: 'api_starter',
    status,
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW - 60_000),
  };
}

async function issueToken(store: InMemoryOAuthStore): Promise<{
  service: OAuthService;
  clientId: string;
  accessToken: string;
}> {
  const service = new OAuthService(store, () => NOW);
  const client = await service.registerClient({
    label: 'Central auth test',
    redirect_uris: ['https://app.example/cb'],
  });
  const verifier = 'v'.repeat(64);
  const authorization = await service.authorize({
    client_id: client.client_id,
    redirect_uri: 'https://app.example/cb',
    state: 'state-value',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: ['read:sessions'],
  });
  const approval = await service.approveAuthorization({
    authorization_id: authorization.authorization_id,
    account_id: ACCOUNT_ID,
    approverScopes: ['read'],
  });
  const exchanged = await service.exchangeCode({
    code: approval.code,
    code_verifier: verifier,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: 'https://app.example/cb',
  });
  return { service, clientId: client.client_id, accessToken: exchanged.access_token };
}

describe('OAuth access tokens in central API authentication', () => {
  it('resolves account + exact approved scopes through the oat_ dispatcher', async () => {
    const repo = new InMemoryAuthRepo();
    repo.upsertAccount(account());
    const store = new InMemoryOAuthStore();
    const issued = await issueToken(store);

    const ctx = await authenticate(
      repo,
      issued.accessToken,
      null,
      new Date(NOW + 1_000),
      null,
      new Set(),
      null,
      store,
    );

    expect(ctx.account.id).toBe(ACCOUNT_ID);
    expect(ctx.apiKey.scopes).toEqual(['read:sessions']);
    expect(ctx.apiKey.provenance).toBe('oauth');
    expect(ctx.apiKey.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.webSession).toBeNull();
  });

  it('rejects immediately after client revocation and after token expiry', async () => {
    const repo = new InMemoryAuthRepo();
    repo.upsertAccount(account());

    const revokedStore = new InMemoryOAuthStore();
    const revoked = await issueToken(revokedStore);
    await revoked.service.revokeClient(revoked.clientId);
    await expect(
      authenticate(
        repo,
        revoked.accessToken,
        null,
        new Date(NOW + 1_000),
        null,
        new Set(),
        null,
        revokedStore,
      ),
    ).rejects.toBeInstanceOf(InvalidKeyError);

    const expiredStore = new InMemoryOAuthStore();
    const expired = await issueToken(expiredStore);
    await expect(
      authenticate(
        repo,
        expired.accessToken,
        null,
        new Date(NOW + 60 * 60 * 1_000),
        null,
        new Set(),
        null,
        expiredStore,
      ),
    ).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('applies the existing suspended-account boundary', async () => {
    const repo = new InMemoryAuthRepo();
    repo.upsertAccount(account('suspended'));
    const store = new InMemoryOAuthStore();
    const issued = await issueToken(store);

    await expect(
      authenticate(
        repo,
        issued.accessToken,
        null,
        new Date(NOW + 1_000),
        null,
        new Set(),
        null,
        store,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('central API middleware rejects a Free OAuth bearer after valid token authentication', async () => {
    const repo = new InMemoryAuthRepo();
    repo.upsertAccount({ ...account(), tier: 'free' });
    const store = new InMemoryOAuthStore();
    const issued = await issueToken(store);
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(authPlugin, {
      authRepo: repo,
      authCache: null,
      authCoalescer: null,
      oauthStore: store,
    });
    app.get('/private', { preHandler: [app.requireAuth] }, () => ({ ok: true }));
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/private',
        headers: { authorization: `Bearer ${issued.accessToken}` },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json<{ type: string; detail: string }>();
      expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
      expect(body.detail).toContain('apiAccess');
      expect(body.detail).toContain('free');
    } finally {
      await app.close();
    }
  });
});

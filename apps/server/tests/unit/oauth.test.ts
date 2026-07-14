// V-667 — OAuthService unit tests (invite-only flow + PKCE).

import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  InMemoryOAuthStore,
  OAuthError,
  OAuthService,
  type AccessToken,
} from '../../src/services/oauth.js';
import { computeS256Challenge } from '../../src/lib/oauth-pkce.js';
import type { ApiKeyScope } from '@driftstack/api-types';

function makeService(): { svc: OAuthService; store: InMemoryOAuthStore } {
  const store = new InMemoryOAuthStore();
  const svc = new OAuthService(store);
  return { svc, store };
}

function makeVerifier(): string {
  // RFC 7636 alphabet, 43..128 chars.
  return randomBytes(48).toString('base64url').slice(0, 64);
}

class ClientAuthorityChangeBeforeTokenStore extends InMemoryOAuthStore {
  attemptedToken: string | null = null;

  constructor(private readonly change: 'revoke' | 'rotate') {
    super();
  }

  override async insertTokenIfClientAuthorityMatches(args: {
    token: AccessToken;
    expectedClientSecretHash: string;
  }): Promise<boolean> {
    this.attemptedToken = args.token.token;
    if (this.change === 'revoke') {
      await this.revokeClient(args.token.client_id, Date.now());
    } else {
      await this.rotateClientSecretHash(
        args.token.client_id,
        createHash('sha256').update('replacement-secret').digest('hex'),
      );
    }
    return super.insertTokenIfClientAuthorityMatches(args);
  }
}

describe('V-667 OAuthService — registerClient', () => {
  it('returns a client_id + client_secret; secret is hashed in storage', async () => {
    const { svc, store } = makeService();
    const r = await svc.registerClient({
      label: 'Test App',
      redirect_uris: ['https://app.example.com/oauth/callback'],
    });
    expect(r.client_id).toMatch(/^oac_/);
    expect(r.client_secret).toMatch(/^oas_/);
    const stored = await store.getClient(r.client_id);
    expect(stored?.client_secret_hash).toBe(
      createHash('sha256').update(r.client_secret).digest('hex'),
    );
    expect(stored?.client_secret_hash).not.toBe(r.client_secret);
  });

  it('rejects redirect URIs that are not HTTPS (except localhost)', async () => {
    const { svc } = makeService();
    await expect(
      svc.registerClient({
        label: 'Bad App',
        redirect_uris: ['http://example.com/cb'],
      }),
    ).rejects.toBeInstanceOf(OAuthError);
    // localhost http IS allowed.
    await expect(
      svc.registerClient({
        label: 'Localhost App',
        redirect_uris: ['http://localhost:3000/cb'],
      }),
    ).resolves.toMatchObject({ client_id: expect.stringMatching(/^oac_/) });
  });

  it('rejects empty label or empty redirect_uris', async () => {
    const { svc } = makeService();
    await expect(
      svc.registerClient({ label: '', redirect_uris: ['https://x/cb'] }),
    ).rejects.toBeInstanceOf(OAuthError);
    await expect(svc.registerClient({ label: 'App', redirect_uris: [] })).rejects.toBeInstanceOf(
      OAuthError,
    );
  });
});

describe('V-667 OAuthService — authorize', () => {
  it('returns an authorization_id + echoes scope/redirect/state', async () => {
    const { svc } = makeService();
    const { client_id } = await svc.registerClient({
      label: 'A',
      redirect_uris: ['https://app.example/cb'],
    });
    const verifier = makeVerifier();
    const challenge = computeS256Challenge(verifier);
    const r = await svc.authorize({
      client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'st_random',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: ['read:sessions'],
    });
    expect(r.authorization_id).toMatch(/^oaa_/);
    expect(r.scope).toEqual(['read:sessions']);
    expect(r.state).toBe('st_random');
  });

  it('rejects unknown client_id', async () => {
    const { svc } = makeService();
    await expect(
      svc.authorize({
        client_id: 'oac_missing',
        redirect_uri: 'https://x/cb',
        state: 's',
        code_challenge: computeS256Challenge(makeVerifier()),
        code_challenge_method: 'S256',
        scope: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_client' });
  });

  it('rejects revoked client_id', async () => {
    const { svc } = makeService();
    const { client_id } = await svc.registerClient({
      label: 'A',
      redirect_uris: ['https://app.example/cb'],
    });
    await svc.revokeClient(client_id);
    await expect(
      svc.authorize({
        client_id,
        redirect_uri: 'https://app.example/cb',
        state: 's',
        code_challenge: computeS256Challenge(makeVerifier()),
        code_challenge_method: 'S256',
        scope: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_client' });
  });

  it('rejects unknown redirect_uri', async () => {
    const { svc } = makeService();
    const { client_id } = await svc.registerClient({
      label: 'A',
      redirect_uris: ['https://app.example/cb'],
    });
    await expect(
      svc.authorize({
        client_id,
        redirect_uri: 'https://evil.example/cb',
        state: 's',
        code_challenge: computeS256Challenge(makeVerifier()),
        code_challenge_method: 'S256',
        scope: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('V-667 OAuthService — approveAuthorization + exchangeCode (full happy path)', () => {
  it('end-to-end: register → authorize → approve → exchange → introspect', async () => {
    const { svc } = makeService();
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    const verifier = makeVerifier();
    const challenge = computeS256Challenge(verifier);
    const auth = await svc.authorize({
      client_id: reg.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'st_test',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: ['read:sessions', 'write:sessions'],
    });
    const approval = await svc.approveAuthorization({
      authorization_id: auth.authorization_id,
      account_id: 'acc_test_001',
    });
    expect(approval.code).toMatch(/^oac_/);
    expect(approval.state).toBe('st_test');

    const token = await svc.exchangeCode({
      code: approval.code,
      code_verifier: verifier,
      client_id: reg.client_id,
      client_secret: reg.client_secret,
      redirect_uri: 'https://app.example/cb',
    });
    expect(token.access_token).toMatch(/^oat_/);
    expect(token.token_type).toBe('Bearer');
    expect(token.expires_in).toBe(3600);
    expect(token.scope).toEqual(['read:sessions', 'write:sessions']);

    const intro = await svc.introspect(token.access_token);
    expect(intro?.account_id).toBe('acc_test_001');
    expect(intro?.client_id).toBe(reg.client_id);
  });
});

describe('V-667 OAuthService — granted scope restriction (the cross-account/escalation fix)', () => {
  async function grantedScopeFor(
    requestScope: readonly ApiKeyScope[],
    approverScopes: readonly ApiKeyScope[],
  ): Promise<readonly ApiKeyScope[]> {
    const { svc } = makeService();
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    const verifier = makeVerifier();
    const auth = await svc.authorize({
      client_id: reg.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'st',
      code_challenge: computeS256Challenge(verifier),
      code_challenge_method: 'S256',
      scope: requestScope,
    });
    const approval = await svc.approveAuthorization({
      authorization_id: auth.authorization_id,
      account_id: 'acc_test_001',
      approverScopes,
    });
    const token = await svc.exchangeCode({
      code: approval.code,
      code_verifier: verifier,
      client_id: reg.client_id,
      client_secret: reg.client_secret,
      redirect_uri: 'https://app.example/cb',
    });
    return token.scope;
  }

  it('intersects the granted scope with the approver scopes — cannot grant what the approver lacks', async () => {
    // Requests read+write, but the approving key holds only read → write is dropped.
    const scope = await grantedScopeFor(['read:sessions', 'write:sessions'], ['read:sessions']);
    expect(scope).toEqual(['read:sessions']);
  });

  it('uses the canonical broad-satisfies-granular hierarchy for dashboard consent', async () => {
    const scope = await grantedScopeFor(
      ['read:sessions', 'write:sessions', 'read:billing'],
      ['read', 'write', 'account_owner'],
    );
    expect(scope).toEqual(['read:sessions', 'write:sessions', 'read:billing']);
  });

  it('does not let a granular approver grant a broad or sibling scope', async () => {
    const scope = await grantedScopeFor(
      ['read', 'read:sessions', 'read:billing'],
      ['read:sessions'],
    );
    expect(scope).toEqual(['read:sessions']);
  });

  it('strips deny-set scopes (account_owner) even when requested AND the approver holds them', async () => {
    // The escalation guard: account_owner can never be minted via the OAuth flow.
    const scope = await grantedScopeFor(
      ['read:sessions', 'account_owner'],
      ['read:sessions', 'account_owner'],
    );
    expect(scope).toEqual(['read:sessions']);
  });
});

describe('V-667 OAuthService — exchangeCode rejection paths', () => {
  async function setup(store: InMemoryOAuthStore = new InMemoryOAuthStore()): Promise<{
    svc: OAuthService;
    reg: { client_id: string; client_secret: string };
    code: string;
    verifier: string;
  }> {
    const svc = new OAuthService(store);
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    const verifier = makeVerifier();
    const challenge = computeS256Challenge(verifier);
    const auth = await svc.authorize({
      client_id: reg.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'st',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: ['read:sessions'],
    });
    const approval = await svc.approveAuthorization({
      authorization_id: auth.authorization_id,
      account_id: 'acc_test',
    });
    return { svc, reg, code: approval.code, verifier };
  }

  it('rejects bad client_secret', async () => {
    const { svc, reg, code, verifier } = await setup();
    await expect(
      svc.exchangeCode({
        code,
        code_verifier: verifier,
        client_id: reg.client_id,
        client_secret: 'oas_wrong',
        redirect_uri: 'https://app.example/cb',
      }),
    ).rejects.toMatchObject({ code: 'invalid_client' });
  });

  it('rejects bad PKCE verifier', async () => {
    const { svc, reg, code } = await setup();
    await expect(
      svc.exchangeCode({
        code,
        code_verifier: makeVerifier(), // fresh, doesn't match the stored challenge
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        redirect_uri: 'https://app.example/cb',
      }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('rejects already-exchanged code (one-shot)', async () => {
    const { svc, reg, code, verifier } = await setup();
    await svc.exchangeCode({
      code,
      code_verifier: verifier,
      client_id: reg.client_id,
      client_secret: reg.client_secret,
      redirect_uri: 'https://app.example/cb',
    });
    await expect(
      svc.exchangeCode({
        code,
        code_verifier: verifier,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        redirect_uri: 'https://app.example/cb',
      }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('atomic single-use under concurrency: two simultaneous exchanges of the same code → exactly one token, one invalid_grant (no authorization-code reuse / token replay)', async () => {
    const { svc, reg, code, verifier } = await setup();
    const exchange = (): Promise<{ access_token: string }> =>
      svc.exchangeCode({
        code,
        code_verifier: verifier,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        redirect_uri: 'https://app.example/cb',
      });
    // Fire both before either resolves — with a blind (non-atomic) consume both
    // would observe consumed_at===null and both mint a token. The atomic
    // consumeCodeIfUnconsumed claim serialises them: exactly one wins.
    const settled = await Promise.allSettled([exchange(), exchange()]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'invalid_grant' });
    expect(
      (fulfilled[0] as PromiseFulfilledResult<{ access_token: string }>).value.access_token,
    ).toMatch(/^oat_/);
  });

  it.each(['revoke', 'rotate'] as const)(
    'does not mint when client %s wins after authentication',
    async (change) => {
      const store = new ClientAuthorityChangeBeforeTokenStore(change);
      const { svc, reg, code, verifier } = await setup(store);

      await expect(
        svc.exchangeCode({
          code,
          code_verifier: verifier,
          client_id: reg.client_id,
          client_secret: reg.client_secret,
          redirect_uri: 'https://app.example/cb',
        }),
      ).rejects.toMatchObject({ code: 'invalid_client' });

      expect(store.attemptedToken).toMatch(/^oat_/);
      expect(await store.getToken(store.attemptedToken!)).toBeNull();
      expect((await store.getCode(code))?.consumed_at).not.toBeNull();
    },
  );

  it('rejects redirect_uri mismatch (binding check)', async () => {
    const { svc, reg, code, verifier } = await setup();
    await expect(
      svc.exchangeCode({
        code,
        code_verifier: verifier,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        redirect_uri: 'https://different.example/cb',
      }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });
});

describe('V-667 OAuthService — listClients / revokeClient', () => {
  it('lists registered clients', async () => {
    const { svc } = makeService();
    await svc.registerClient({ label: 'A', redirect_uris: ['https://a/cb'] });
    await svc.registerClient({ label: 'B', redirect_uris: ['https://b/cb'] });
    const list = await svc.listClients();
    expect(list.map((c) => c.label).sort()).toEqual(['A', 'B']);
  });

  it('revoked clients are not usable for authorize', async () => {
    const { svc } = makeService();
    const reg = await svc.registerClient({
      label: 'X',
      redirect_uris: ['https://x/cb'],
    });
    await svc.revokeClient(reg.client_id);
    await expect(
      svc.authorize({
        client_id: reg.client_id,
        redirect_uri: 'https://x/cb',
        state: 's',
        code_challenge: computeS256Challenge(makeVerifier()),
        code_challenge_method: 'S256',
        scope: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_client' });
  });
});

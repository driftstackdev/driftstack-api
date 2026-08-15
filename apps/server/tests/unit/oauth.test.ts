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

  override async consumeCodeForToken(args: {
    code: string;
    consumed_at: number;
    token: AccessToken;
    expectedClientSecretHash: string;
  }): Promise<'inserted' | 'code_unavailable' | 'client_authority_changed'> {
    this.attemptedToken = args.token.token;
    if (this.change === 'revoke') {
      await this.revokeClient(args.token.client_id, Date.now());
    } else {
      await this.rotateClientSecretHash(
        args.token.client_id,
        createHash('sha256').update('replacement-secret').digest('hex'),
      );
    }
    return super.consumeCodeForToken(args);
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

  it.each([
    'https://user@example.com/cb',
    'https://user:password@example.com/cb',
    'https://example.com/cb#fragment',
    `https://example.com/${'x'.repeat(2048)}`,
  ])('rejects unsafe or oversized redirect URI %s', async (redirectUri) => {
    const { svc } = makeService();
    await expect(
      svc.registerClient({ label: 'Unsafe App', redirect_uris: [redirectUri] }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'redirect_uri rejected',
    });
  });

  it('accepts an HTTPS callback query because the handoff preserves it safely', async () => {
    const { svc } = makeService();
    await expect(
      svc.registerClient({
        label: 'Query App',
        redirect_uris: ['https://example.com/cb?tenant=customer'],
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

describe('OAuth provider retention', () => {
  it('prunes only already-invalid handles/codes/tokens at the canonical boundaries', async () => {
    const base = Date.now();
    const pruneAt = base + 2 * 60 * 60 * 1000;
    const { store } = makeService();
    const oldService = new OAuthService(store, () => base);
    const liveService = new OAuthService(store, () => pruneAt);
    const client = await oldService.registerClient({
      label: 'Retention App',
      redirect_uris: ['https://app.example/cb'],
    });

    async function createArtifacts(service: OAuthService, suffix: string) {
      const pending = await service.authorize({
        client_id: client.client_id,
        redirect_uri: 'https://app.example/cb',
        state: `state_pending_${suffix}`,
        code_challenge: computeS256Challenge(makeVerifier()),
        code_challenge_method: 'S256',
        scope: ['read:sessions'],
      });
      const codeAuthorization = await service.authorize({
        client_id: client.client_id,
        redirect_uri: 'https://app.example/cb',
        state: `state_code_${suffix}`,
        code_challenge: computeS256Challenge(makeVerifier()),
        code_challenge_method: 'S256',
        scope: ['read:sessions'],
      });
      const code = await service.approveAuthorization({
        authorization_id: codeAuthorization.authorization_id,
        account_id: 'acc_retention',
      });
      const verifier = makeVerifier();
      const tokenAuthorization = await service.authorize({
        client_id: client.client_id,
        redirect_uri: 'https://app.example/cb',
        state: `state_token_${suffix}`,
        code_challenge: computeS256Challenge(verifier),
        code_challenge_method: 'S256',
        scope: ['read:sessions'],
      });
      const tokenCode = await service.approveAuthorization({
        authorization_id: tokenAuthorization.authorization_id,
        account_id: 'acc_retention',
      });
      const token = await service.exchangeCode({
        code: tokenCode.code,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: 'https://app.example/cb',
      });
      return { pending, code, token };
    }

    const old = await createArtifacts(oldService, 'old');
    const live = await createArtifacts(liveService, 'live');
    await expect(store.pruneExpired(pruneAt)).resolves.toEqual({
      authorizations: 1,
      codes: 2,
      tokens: 1,
    });
    await expect(store.getAuthorization(old.pending.authorization_id)).resolves.toBeNull();
    await expect(store.getAuthorization(live.pending.authorization_id)).resolves.not.toBeNull();
    await expect(store.getCode(old.code.code)).resolves.toBeNull();
    await expect(store.getCode(live.code.code)).resolves.not.toBeNull();
    await expect(
      store.findTokenForAuthentication(old.token.access_token, pruneAt),
    ).resolves.toBeNull();
    await expect(
      store.findTokenForAuthentication(live.token.access_token, pruneAt),
    ).resolves.not.toBeNull();
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

  it('rejects an unsafe redirect even if a corrupted client row contains it', async () => {
    const { svc, store } = makeService();
    const redirectUri = 'https://user:password@app.example/cb';
    await store.insertClient({
      client_id: 'oac_corrupt',
      client_secret_hash: 'digest',
      redirect_uris: [redirectUri],
      label: 'Corrupt App',
      account_id: null,
      created_at: Date.now(),
      revoked_at: null,
    });
    await expect(
      svc.authorize({
        client_id: 'oac_corrupt',
        redirect_uri: redirectUri,
        state: 'state_corrupt',
        code_challenge: computeS256Challenge(makeVerifier()),
        code_challenge_method: 'S256',
        scope: [],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'redirect_uri rejected',
    });
  });

  it.each([
    'read',
    'write',
    'admin',
    'account_owner',
    'driftstack_internal_admin',
    'gui_control',
  ] as const)('rejects non-curated API-key scope %s before staging consent', async (scope) => {
    const { svc } = makeService();
    const { client_id } = await svc.registerClient({
      label: 'Scoped App',
      redirect_uris: ['https://app.example/cb'],
    });
    await expect(
      svc.authorize({
        client_id,
        redirect_uri: 'https://app.example/cb',
        state: 'state',
        code_challenge: computeS256Challenge(makeVerifier()),
        code_challenge_method: 'S256',
        scope: [scope],
      }),
    ).rejects.toMatchObject({ code: 'invalid_scope' });
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

// ─── the approve-path verdicts that only the STORE can produce ──────────────
//
// `approveAuthorization` reads the authorization, checks it, then commits
// through `consumeAuthorizationForCode`. The commit returns its own verdict, and
// two of those verdicts had never executed at HEAD (measured with v8 coverage):
//
//   services/oauth.ts:592  'expired'      → authorization expired before approval
//   services/oauth.ts:595  'unavailable'  → unknown or expired authorization_id
//
// Neither is reachable over HTTP, and the reason is worth writing down rather
// than filed as "hard to test". They exist precisely for the window BETWEEN the
// read and the commit — a concurrent approval, or a TTL that lapses mid-flight.
// A request that arrives after that window is refused by the pre-check at :561
// instead, and an integration attempt at the race (a double-submitted consent)
// was measured landing on :561, not here.
//
// ⚠️ The reason it cannot simply be asserted harder from outside: **:561 and :595
// emit the same string.** `unknown or expired authorization_id` is
// indistinguishable at the HTTP boundary, so an integration arm cannot prove
// which site fired even when it does win the race. A store that returns the
// verdict directly is the only instrument that can — the same shape as
// `ClientAuthorityChangeBeforeTokenStore` above, which exists for the identical
// reason on the exchange side.
//
// These are not redundant with the pre-check. The pre-check is an early-exit for
// the common case; the commit verdict is the authoritative one, and a store that
// stops reporting it hands out a second code for one consent.
class CommitVerdictStore extends InMemoryOAuthStore {
  constructor(private readonly verdict: 'expired' | 'unavailable') {
    super();
  }

  override async consumeAuthorizationForCode(args: {
    authorization_id: string;
    code: string;
    account_id: string;
    scope: readonly ApiKeyScope[];
    created_at: number;
    not_before: number;
  }): Promise<'inserted' | 'expired' | 'unavailable' | 'client_unavailable' | 'account_mismatch'> {
    // Run the real commit first, so the store is left in the state a genuine
    // race would leave it in rather than silently skipping the write.
    await super.consumeAuthorizationForCode(args);
    return this.verdict;
  }
}

describe('V-667 OAuthService — approveAuthorization commit verdicts', () => {
  async function approveWith(verdict: 'expired' | 'unavailable'): Promise<unknown> {
    const store = new CommitVerdictStore(verdict);
    const svc = new OAuthService(store);
    const reg = await svc.registerClient({
      label: 'App',
      redirect_uris: ['https://app.example/cb'],
    });
    const auth = await svc.authorize({
      client_id: reg.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'st_test',
      code_challenge: computeS256Challenge(makeVerifier()),
      code_challenge_method: 'S256',
      scope: ['read:sessions'],
    });
    return svc.approveAuthorization({
      authorization_id: auth.authorization_id,
      account_id: 'acc_test_001',
    });
  }

  it('refuses when the commit reports the authorization already gone', async () => {
    // The losing half of a double-submitted consent: the read succeeded, so the
    // pre-check passed, and only the atomic commit can tell it lost.
    await expect(approveWith('unavailable')).rejects.toThrow(
      /unknown or expired authorization_id/i,
    );
  });

  it('refuses when the commit reports the authorization expired', async () => {
    // The TTL lapsed between the read and the write. Distinct from the
    // pre-check's own clock comparison, which had already passed.
    await expect(approveWith('expired')).rejects.toThrow(/authorization expired before approval/i);
  });

  it('the refusal is invalid_request in both cases, not a 500', async () => {
    // These are client-visible OAuth errors, so they must map through
    // `oauthErrorToHttp` rather than escaping as an unhandled fault — a race
    // losing is an ordinary outcome, not a server bug.
    for (const verdict of ['unavailable', 'expired'] as const) {
      await expect(approveWith(verdict)).rejects.toMatchObject({ code: 'invalid_request' });
    }
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

  it('retains the curated allowlist during approval even if staging is bypassed', async () => {
    const store = new InMemoryOAuthStore();
    const svc = new OAuthService(store);
    const client = await svc.registerClient({
      label: 'Injected App',
      redirect_uris: ['https://app.example/cb'],
    });
    await store.insertAuthorization({
      authorization_id: 'oaa_injected',
      client_id: client.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'state',
      scope: ['read:sessions', 'read', 'account_owner'],
      code_challenge: computeS256Challenge(makeVerifier()),
      created_at: Date.now(),
    });
    const approval = await svc.approveAuthorization({
      authorization_id: 'oaa_injected',
      account_id: 'acc_test',
      approverScopes: ['read', 'account_owner'],
    });

    expect((await store.getCode(approval.code))?.scope).toEqual(['read:sessions']);
  });

  it('account-scoped consent rejects another account without consuming the authorization', async () => {
    const { svc } = makeService();
    const client = await svc.registerClient({
      label: 'Bound App',
      redirect_uris: ['https://app.example/cb'],
      account_id: 'acc_owner',
    });
    const authorization = await svc.authorize({
      client_id: client.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'state',
      code_challenge: computeS256Challenge(makeVerifier()),
      code_challenge_method: 'S256',
      scope: ['read:sessions'],
    });

    await expect(
      svc.approveAuthorization({
        authorization_id: authorization.authorization_id,
        account_id: 'acc_attacker',
        approverScopes: ['read'],
      }),
    ).rejects.toMatchObject({ code: 'access_denied' });

    await expect(
      svc.approveAuthorization({
        authorization_id: authorization.authorization_id,
        account_id: 'acc_owner',
        approverScopes: ['read'],
      }),
    ).resolves.toMatchObject({ code: expect.stringMatching(/^oac_/) });
  });

  it('refuses a corrupted pending authorization with an unsafe redirect', async () => {
    const { svc, store } = makeService();
    const client = await svc.registerClient({
      label: 'Safe App',
      redirect_uris: ['https://app.example/cb'],
    });
    await store.insertAuthorization({
      authorization_id: 'oaa_corrupt',
      client_id: client.client_id,
      redirect_uri: 'https://app.example/cb#injected',
      state: 'state_corrupt',
      scope: ['read:sessions'],
      code_challenge: computeS256Challenge(makeVerifier()),
      created_at: Date.now(),
    });

    await expect(
      svc.approveAuthorization({
        authorization_id: 'oaa_corrupt',
        account_id: 'acc_test',
        approverScopes: ['read'],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'redirect_uri rejected',
    });
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
    // The transactional code-to-token commit serialises them: exactly one wins.
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
      expect((await store.getCode(code))?.consumed_at).toBeNull();
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

  it('client revocation immediately invalidates every issued bearer', async () => {
    const { svc } = makeService();
    const reg = await svc.registerClient({
      label: 'Bearer App',
      redirect_uris: ['https://app.example/cb'],
    });
    const verifier = makeVerifier();
    const authorization = await svc.authorize({
      client_id: reg.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'state',
      code_challenge: computeS256Challenge(verifier),
      code_challenge_method: 'S256',
      scope: ['read:sessions'],
    });
    const { code } = await svc.approveAuthorization({
      authorization_id: authorization.authorization_id,
      account_id: 'acc_test',
    });
    const token = await svc.exchangeCode({
      code,
      code_verifier: verifier,
      client_id: reg.client_id,
      client_secret: reg.client_secret,
      redirect_uri: 'https://app.example/cb',
    });
    expect(await svc.introspect(token.access_token)).not.toBeNull();

    await svc.revokeClient(reg.client_id);

    expect(await svc.introspect(token.access_token)).toBeNull();
  });
});

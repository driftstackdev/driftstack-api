// V-667.C — unit tests for code-exchange + userinfo-fetch.

import { describe, expect, it, vi } from 'vitest';
import { exchangeCodeForTokens, fetchUserInfo } from '../../src/lib/oauth-client-exchange.js';

function mockFetch(
  responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>,
  calls?: RequestInit[],
): typeof fetch {
  let i = 0;
  return ((_url: string, init?: RequestInit) => {
    calls?.push(init ?? {});
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (!r) throw new Error('mockFetch: no responses left');
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return Promise.resolve(
      new Response(body, {
        status: r.status,
        headers: r.headers ?? { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

const EXCHANGE_OPTS_BASE = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  callbackUrl: 'https://app.driftstack.dev/auth/oauth-client/callback',
  code: 'idp-code-12345',
  codeVerifier: 'verifier-43-chars-min-aaaaaaaaaaaaaaaaaaaaa',
};

describe('IDP redirect policy', () => {
  it('refuses redirects for token, userinfo, and GitHub private-email requests', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = mockFetch(
      [
        { status: 200, body: { access_token: 'token' } },
        { status: 200, body: { id: 7, login: 'user', email: null } },
        {
          status: 200,
          body: [{ email: 'verified@example.test', primary: true, verified: true }],
        },
      ],
      calls,
    );

    await expect(
      exchangeCodeForTokens({ ...EXCHANGE_OPTS_BASE, provider: 'google', fetch: fetchImpl }),
    ).resolves.toMatchObject({ kind: 'ok' });
    await expect(
      fetchUserInfo({ provider: 'github', accessToken: 'token', fetch: fetchImpl }),
    ).resolves.toMatchObject({ kind: 'ok' });

    expect(calls).toHaveLength(3);
    expect(calls.map((init) => init.redirect)).toEqual(['error', 'error', 'error']);
  });
});

describe('exchangeCodeForTokens — Google', () => {
  it('200 with access_token + id_token + scope → kind: ok', async () => {
    const res = await exchangeCodeForTokens({
      ...EXCHANGE_OPTS_BASE,
      provider: 'google',
      fetch: mockFetch([
        {
          status: 200,
          body: {
            access_token: 'ya29.test-token',
            id_token: 'eyJ.dummy.id-token',
            expires_in: 3599,
            refresh_token: 'refresh-token-1',
            scope: 'openid email profile',
            token_type: 'Bearer',
          },
        },
      ]),
    });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.tokens.accessToken).toBe('ya29.test-token');
      expect(res.tokens.idToken).toBe('eyJ.dummy.id-token');
      expect(res.tokens.expiresIn).toBe(3599);
      expect(res.tokens.refreshToken).toBe('refresh-token-1');
      expect(res.tokens.scope).toBe('openid email profile');
    }
  });

  it('400 with error=invalid_grant → kind: invalid-grant', async () => {
    const res = await exchangeCodeForTokens({
      ...EXCHANGE_OPTS_BASE,
      provider: 'google',
      fetch: mockFetch([{ status: 400, body: { error: 'invalid_grant' } }]),
    });
    expect(res.kind).toBe('invalid-grant');
  });

  it('401 with error=invalid_client → kind: invalid-client', async () => {
    const res = await exchangeCodeForTokens({
      ...EXCHANGE_OPTS_BASE,
      provider: 'google',
      fetch: mockFetch([{ status: 401, body: { error: 'invalid_client' } }]),
    });
    expect(res.kind).toBe('invalid-client');
  });

  it('500 → kind: idp-error with status preserved', async () => {
    const res = await exchangeCodeForTokens({
      ...EXCHANGE_OPTS_BASE,
      provider: 'google',
      fetch: mockFetch([{ status: 500, body: 'server died' }]),
    });
    expect(res.kind).toBe('idp-error');
    if (res.kind === 'idp-error') expect(res.status).toBe(500);
  });

  it('network error → kind: network-error', async () => {
    const res = await exchangeCodeForTokens({
      ...EXCHANGE_OPTS_BASE,
      provider: 'google',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(res.kind).toBe('network-error');
    if (res.kind === 'network-error') expect(res.message).toBe('ECONNREFUSED');
  });
});

describe('exchangeCodeForTokens — GitHub', () => {
  it('200 with error=bad_verification_code body (legacy shape) → invalid-grant', async () => {
    const res = await exchangeCodeForTokens({
      ...EXCHANGE_OPTS_BASE,
      provider: 'github',
      fetch: mockFetch([{ status: 200, body: { error: 'bad_verification_code' } }]),
    });
    expect(res.kind).toBe('invalid-grant');
  });

  it("200 with access_token → ok with id_token null (GitHub doesn't issue id_token)", async () => {
    const res = await exchangeCodeForTokens({
      ...EXCHANGE_OPTS_BASE,
      provider: 'github',
      fetch: mockFetch([
        {
          status: 200,
          body: { access_token: 'gho_token', token_type: 'bearer', scope: 'read:user user:email' },
        },
      ]),
    });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.tokens.accessToken).toBe('gho_token');
      expect(res.tokens.idToken).toBe(null);
    }
  });
});

describe('fetchUserInfo — Google', () => {
  it('happy path normalizes sub/email/name/picture', async () => {
    const res = await fetchUserInfo({
      provider: 'google',
      accessToken: 'token',
      fetch: mockFetch([
        {
          status: 200,
          body: {
            sub: 'google-sub-12345',
            email: 'user@example.test',
            email_verified: true,
            name: 'Test User',
            picture: 'https://lh3.googleusercontent.com/a/abc',
          },
        },
      ]),
    });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.user.providerSub).toBe('google-sub-12345');
      expect(res.user.email).toBe('user@example.test');
      expect(res.user.emailVerified).toBe(true);
      expect(res.user.name).toBe('Test User');
      expect(res.user.avatarUrl).toBe('https://lh3.googleusercontent.com/a/abc');
    }
  });

  it('email_verified=false → kind: unverified-email (Verdict 1 trust)', async () => {
    const res = await fetchUserInfo({
      provider: 'google',
      accessToken: 'token',
      fetch: mockFetch([
        {
          status: 200,
          body: { sub: 's', email: 'u@e.test', email_verified: false, name: 'U' },
        },
      ]),
    });
    expect(res.kind).toBe('unverified-email');
  });

  it('401 → kind: unauthorized (revoked token)', async () => {
    const res = await fetchUserInfo({
      provider: 'google',
      accessToken: 'revoked-token',
      fetch: mockFetch([{ status: 401, body: { error: 'invalid_token' } }]),
    });
    expect(res.kind).toBe('unauthorized');
  });
});

describe('fetchUserInfo — GitHub', () => {
  it('happy path normalizes numeric id → string providerSub + avatar_url', async () => {
    const res = await fetchUserInfo({
      provider: 'github',
      accessToken: 'gho_token',
      fetch: mockFetch([
        {
          status: 200,
          body: {
            id: 987654,
            login: 'ghuser',
            name: 'GitHub User',
            email: 'user@github-verified.test',
            avatar_url: 'https://avatars.githubusercontent.com/u/987654',
          },
        },
      ]),
    });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.user.providerSub).toBe('987654');
      expect(res.user.email).toBe('user@github-verified.test');
      expect(res.user.name).toBe('GitHub User');
      expect(res.user.avatarUrl).toBe('https://avatars.githubusercontent.com/u/987654');
    }
  });

  it('email null (private) → kind: unverified-email (caller falls back to /user/emails)', async () => {
    const res = await fetchUserInfo({
      provider: 'github',
      accessToken: 'gho_token',
      fetch: mockFetch([
        {
          status: 200,
          body: { id: 1, login: 'ghuser', name: 'GitHub User', email: null },
        },
      ]),
    });
    expect(res.kind).toBe('unverified-email');
  });
});

describe('IDP fetch timeout (V-667.C resilience — bounds the login request path)', () => {
  // A fetch that never settles on its own; it only rejects when the
  // injected AbortSignal fires — mirroring a hung/slow IDP endpoint.
  // Without the AbortController deadline this would hang forever.
  function hangingFetch(): typeof fetch {
    return ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })) as unknown as typeof fetch;
  }

  it('exchangeCodeForTokens: a hung IDP token endpoint aborts at the deadline → network-error', async () => {
    vi.useFakeTimers();
    try {
      const p = exchangeCodeForTokens({
        ...EXCHANGE_OPTS_BASE,
        provider: 'google',
        fetch: hangingFetch(),
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await p;
      expect(res.kind).toBe('network-error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetchUserInfo: a hung IDP userinfo endpoint aborts at the deadline → network-error', async () => {
    vi.useFakeTimers();
    try {
      const p = fetchUserInfo({
        provider: 'google',
        accessToken: 'ya29.token',
        fetch: hangingFetch(),
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await p;
      expect(res.kind).toBe('network-error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the deadline armed after headers while the response body is stalled', async () => {
    vi.useFakeTimers();
    try {
      const fetchWithHungBody = ((_url: string, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'));
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }) as unknown as typeof fetch;
      const pending = exchangeCodeForTokens({
        ...EXCHANGE_OPTS_BASE,
        provider: 'google',
        fetch: fetchWithHungBody,
        timeoutMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ kind: 'network-error' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('IDP response body bounds', () => {
  it('rejects an oversized declared Content-Length before reading the body', async () => {
    const res = await exchangeCodeForTokens({
      ...EXCHANGE_OPTS_BASE,
      provider: 'google',
      fetch: mockFetch([
        {
          status: 200,
          body: { access_token: 'must-not-be-read' },
          headers: { 'content-length': String(256 * 1024 + 1) },
        },
      ]),
    });

    expect(res).toEqual({
      kind: 'idp-error',
      status: 200,
      body: 'IDP response exceeded 262144-byte limit',
    });
  });

  it('cancels a chunked response as soon as accumulated bytes cross the cap', async () => {
    let cancelled = false;
    const chunks = [new Uint8Array(200 * 1024), new Uint8Array(64 * 1024), new Uint8Array(1)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchChunked = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const res = await fetchUserInfo({
      provider: 'google',
      accessToken: 'token',
      fetch: fetchChunked,
    });

    expect(res).toEqual({
      kind: 'idp-error',
      status: 200,
      body: 'IDP response exceeded 262144-byte limit',
    });
    expect(cancelled).toBe(true);
  });
});

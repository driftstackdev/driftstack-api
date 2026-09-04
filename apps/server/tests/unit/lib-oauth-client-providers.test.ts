// V-667.C — unit tests for the OAuth-client provider catalogue +
// buildAuthorizeUrl helper.

import { describe, expect, it } from 'vitest';
import {
  OAUTH_CLIENT_PROVIDERS,
  buildAuthorizeUrl,
  type OAuthClientProvider,
} from '../../src/lib/oauth-client-providers.js';

describe('OAUTH_CLIENT_PROVIDERS catalogue', () => {
  it('contains exactly the 2 founder-verdicted providers', () => {
    expect(Object.keys(OAUTH_CLIENT_PROVIDERS).sort()).toEqual(['github', 'google']);
  });

  it('Google config — EU-friendly openid endpoints + openid scope + PKCE-required', () => {
    const cfg = OAUTH_CLIENT_PROVIDERS.google;
    expect(cfg.authorizeUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(cfg.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(cfg.userinfoUrl).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(cfg.scope).toBe('openid email profile');
    expect(cfg.pkceRequired).toBe(true);
  });

  it("GitHub config — github.com endpoints + 'read:user user:email' scope + PKCE not strictly required", () => {
    const cfg = OAUTH_CLIENT_PROVIDERS.github;
    expect(cfg.authorizeUrl).toBe('https://github.com/login/oauth/authorize');
    expect(cfg.tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(cfg.userinfoUrl).toBe('https://api.github.com/user');
    expect(cfg.scope).toBe('read:user user:email');
    expect(cfg.pkceRequired).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  const BASE = {
    clientId: 'test-client-id',
    callbackUrl: 'https://app.driftstack.io/auth/oauth-client/callback',
    state: 'state-nonce-12345678',
    codeChallenge: 'challenge-base64url-XYZ',
  };

  it('Google URL includes prompt=consent + access_type=offline (Verdict 1 trust depends on fresh consent)', () => {
    const url = new URL(buildAuthorizeUrl({ ...BASE, provider: 'google' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(BASE.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(BASE.callbackUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe(BASE.state);
    expect(url.searchParams.get('code_challenge')).toBe(BASE.codeChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('GitHub URL has the canonical params + PKCE challenge but no prompt/access_type overrides', () => {
    const url = new URL(buildAuthorizeUrl({ ...BASE, provider: 'github' }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBeNull();
    expect(url.searchParams.get('access_type')).toBeNull();
  });

  it('Encodes special chars in callback + state safely', () => {
    const url = new URL(
      buildAuthorizeUrl({
        ...BASE,
        provider: 'google',
        callbackUrl: 'https://app.driftstack.io/cb?next=/billing',
        state: 'with spaces & ampersands',
      }),
    );
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.driftstack.io/cb?next=/billing');
    expect(url.searchParams.get('state')).toBe('with spaces & ampersands');
  });

  it('OAuthClientProvider type union narrows to literal members', () => {
    const all: OAuthClientProvider[] = ['google', 'github'];
    for (const p of all) {
      expect(OAUTH_CLIENT_PROVIDERS[p].id).toBe(p);
    }
  });
});

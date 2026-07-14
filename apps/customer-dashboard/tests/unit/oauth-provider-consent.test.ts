import { describe, expect, it } from 'vitest';
import {
  buildOAuthCallbackUrl,
  captureOAuthAuthorizeRequest,
  oauthCallbackHost,
  parseOAuthApprovalCode,
  parseOAuthStageResult,
  readBoundedJson,
} from '../../src/lib/oauth-provider-consent.js';

const VALID =
  '?client_id=oac_client&redirect_uri=https%3A%2F%2Fapp.example%2Fcb%3Ftenant%3Done' +
  '&state=state_12345678&code_challenge=' +
  'c'.repeat(43) +
  '&code_challenge_method=S256&scope=read%3Asessions+write%3Asessions';

describe('OAuth provider consent helpers', () => {
  it('captures one bounded canonical request and retains an existing callback query', () => {
    const captured = captureOAuthAuthorizeRequest(VALID);
    expect(captured).toMatchObject({
      clientId: 'oac_client',
      redirectUri: 'https://app.example/cb?tenant=one',
      state: 'state_12345678',
      scope: 'read:sessions write:sessions',
    });
    expect(new URLSearchParams(captured?.query).get('redirect_uri')).toBe(
      'https://app.example/cb?tenant=one',
    );
  });

  it.each([
    VALID + '&client_id=oac_second',
    VALID + '&scope=read%3Abilling',
    VALID.replace('code_challenge_method=S256', 'code_challenge_method=plain'),
    VALID.replace('state_12345678', 'short'),
    VALID.replace('c'.repeat(43), 'c'.repeat(129)),
  ])('rejects missing, polluted, downgraded, or oversized input', (search) => {
    expect(captureOAuthAuthorizeRequest(search)).toBeNull();
  });

  it('binds displayed stage fields to the captured request', () => {
    const request = captureOAuthAuthorizeRequest(VALID)!;
    const value = {
      authorization_id: 'oaa_pending',
      client: { client_id: request.clientId, label: '<img src=x onerror=alert(1)>' },
      redirect_uri: request.redirectUri,
      state: request.state,
      scope: ['read:sessions'],
    };
    expect(parseOAuthStageResult(value, request)).toMatchObject({
      clientLabel: '<img src=x onerror=alert(1)>',
      scopes: ['read:sessions'],
    });
    expect(
      parseOAuthStageResult({ ...value, redirect_uri: 'https://evil.example/cb' }, request),
    ).toBeNull();
    expect(
      parseOAuthStageResult(
        { ...value, client: { ...value.client, client_id: 'oac_other' } },
        request,
      ),
    ).toBeNull();
    expect(parseOAuthStageResult({ ...value, scope: ['admin'] }, request)).toBeNull();
  });

  it('accepts an approval code only when callback and state remain server-bound', () => {
    const request = captureOAuthAuthorizeRequest(VALID)!;
    const stage = parseOAuthStageResult(
      {
        authorization_id: 'oaa_pending',
        client: { client_id: request.clientId, label: 'App' },
        redirect_uri: request.redirectUri,
        state: request.state,
        scope: ['read:sessions'],
      },
      request,
    )!;
    expect(
      parseOAuthApprovalCode(
        { code: 'oac_code', redirect_uri: stage.redirectUri, state: stage.state },
        stage,
      ),
    ).toBe('oac_code');
    expect(
      parseOAuthApprovalCode(
        { code: 'oac_code', redirect_uri: 'https://evil.example/cb', state: stage.state },
        stage,
      ),
    ).toBeNull();
  });

  it('builds success and denial callbacks with URL/searchParams while preserving registered query', () => {
    const success = new URL(
      buildOAuthCallbackUrl('https://app.example/cb?tenant=one&code=stale', 'state_12345678', {
        code: 'oac_fresh',
      }),
    );
    expect(success.origin + success.pathname).toBe('https://app.example/cb');
    expect(Object.fromEntries(success.searchParams)).toEqual({
      tenant: 'one',
      code: 'oac_fresh',
      state: 'state_12345678',
    });

    const denied = new URL(
      buildOAuthCallbackUrl('http://localhost:3000/cb?tenant=one', 'state_12345678', {
        error: 'access_denied',
      }),
    );
    expect(Object.fromEntries(denied.searchParams)).toEqual({
      tenant: 'one',
      error: 'access_denied',
      state: 'state_12345678',
    });
    expect(oauthCallbackHost('https://app.example:8443/cb')).toBe('app.example:8443');
  });

  it.each([
    'https://user@app.example/cb',
    'https://app.example/cb#fragment',
    'http://app.example/cb',
    'javascript:alert(1)',
  ])('refuses an unsafe callback %s', (redirectUri) => {
    expect(() =>
      buildOAuthCallbackUrl(redirectUri, 'state_12345678', { code: 'oac_code' }),
    ).toThrow('unsafe OAuth callback');
  });

  it('bounds JSON by declared and streamed bytes', async () => {
    await expect(readBoundedJson(new Response(JSON.stringify({ ok: true })))).resolves.toEqual({
      ok: true,
    });
    await expect(
      readBoundedJson(new Response('{}', { headers: { 'content-length': String(64 * 1024 + 1) } })),
    ).rejects.toThrow('OAuth response too large');
    await expect(readBoundedJson(new Response('x'.repeat(64 * 1024 + 1)))).rejects.toThrow(
      'OAuth response too large',
    );
  });
});

// V-460 — auth.cliAuthorize* unit tests; locks the discriminated-
// union response shape on /exchange and the wire-shape on
// /initiate + /bind.

import { describe, expect, it, vi } from 'vitest';
import { AuthResource } from '../../src/resources/auth.js';
import type { HttpClient } from '../../src/http.js';
import type { CliAuthorizeExchangeResponse } from '@driftstack/api-types';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

describe('AuthResource cli-authorize flow (V-460)', () => {
  it('initiate POSTs the state + label and returns code + browser_url', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve({
        code: 'cliauth_abc',
        browser_url: 'https://app.driftstack.dev/cli/authorize?code=cliauth_abc&state=xx',
        expires_at: '2026-05-09T18:05:00Z',
      });
    });
    const http = { request } as unknown as HttpClient;
    const r = new AuthResource(http);
    const out = await r.cliAuthorizeInitiate({
      state: 'csrfnonce-1234567890abcdef',
      client_label: "Driftstack CLI on John's MacBook",
    });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/v1/auth/cli-authorize/initiate',
      body: {
        state: 'csrfnonce-1234567890abcdef',
        client_label: "Driftstack CLI on John's MacBook",
      },
    });
    expect(out.code).toBe('cliauth_abc');
    expect(out.browser_url).toMatch(/cli\/authorize/);
  });

  it('exchange returns the discriminated-union pending branch', async () => {
    const pending: CliAuthorizeExchangeResponse = { status: 'pending' };
    const request = vi.fn(() => Promise.resolve(pending));
    const http = { request } as unknown as HttpClient;
    const r = new AuthResource(http);
    const out = await r.cliAuthorizeExchange({
      code: 'cliauth_abc',
      state: 'csrfnonce-1234567890abcdef',
    });
    expect(out.status).toBe('pending');
    if ('api_key' in out) {
      throw new Error('pending branch should not carry api_key');
    }
  });

  it('exchange returns the discriminated-union bound branch with one-shot api_key', async () => {
    const bound: CliAuthorizeExchangeResponse = {
      status: 'bound',
      api_key: 'sk_live_REDACTED',
      account_id: 'acc_abc',
    };
    const request = vi.fn(() => Promise.resolve(bound));
    const http = { request } as unknown as HttpClient;
    const r = new AuthResource(http);
    const out = await r.cliAuthorizeExchange({
      code: 'cliauth_abc',
      state: 'csrfnonce-1234567890abcdef',
    });
    expect(out.status).toBe('bound');
    if (out.status === 'bound') {
      expect(out.api_key).toBe('sk_live_REDACTED');
      expect(out.account_id).toBe('acc_abc');
    }
  });

  it('bind POSTs code + state + user_code + scopes', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve({
        ok: true as const,
        account_id: 'acc_abc',
        expires_at: '2026-05-09T18:10:00Z',
      });
    });
    const http = { request } as unknown as HttpClient;
    const r = new AuthResource(http);
    const out = await r.cliAuthorizeBind({
      code: 'cliauth_abc',
      state: 'csrfnonce-1234567890abcdef',
      user_code: 'ABCD-EFGH',
      scopes: ['account_owner'],
    });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/v1/auth/cli-authorize/bind-device-code',
      body: {
        code: 'cliauth_abc',
        state: 'csrfnonce-1234567890abcdef',
        user_code: 'ABCD-EFGH',
        scopes: ['account_owner'],
      },
    });
    expect(out.ok).toBe(true);
  });
});

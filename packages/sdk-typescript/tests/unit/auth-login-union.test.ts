// V-424 — V-423 follow-up: pin the discriminated-union return type
// of `client.auth.login` so consumers branching on `mfa_required`
// don't regress to the simple LoginResponse type.

import { describe, expect, it, vi } from 'vitest';
import { AuthResource } from '../../src/resources/auth.js';
import type { HttpClient } from '../../src/http.js';
import type { LoginResponseUnion } from '@driftstack/api-types';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

describe('AuthResource.login — discriminated-union return type (V-353d / V-423)', () => {
  const sessionFixture: LoginResponseUnion = {
    session: {
      token: 'opaque-base64',
      expires_at: '2026-05-23T00:00:00.000Z',
      account_id: 'acc_00000000-0000-4000-8000-000000000001',
    },
  };

  const mfaFixture: LoginResponseUnion = {
    mfa_required: true,
    challenge_token: 'one-time-token',
    challenge_expires_at: '2026-05-09T00:05:00.000Z',
  };

  it('returns the simple session shape when MFA is not enrolled', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve(sessionFixture);
    });
    const http = { request } as unknown as HttpClient;
    const r = new AuthResource(http);
    const out = await r.login({ email: 'a@b.test', password: 'correct horse battery staple' });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1/auth/login' });
    if ('mfa_required' in out) {
      throw new Error('expected non-MFA branch');
    }
    // After the throw, TS narrows `out` to the simple session branch.
    expect(out.session.token).toBe('opaque-base64');
  });

  it('returns the MFA-required shape when the account has MFA enrolled (V-353d)', async () => {
    const request = vi.fn(() => Promise.resolve(mfaFixture));
    const http = { request } as unknown as HttpClient;
    const r = new AuthResource(http);
    const out = await r.login({ email: 'a@b.test', password: 'correct horse battery staple' });
    if (!('mfa_required' in out)) {
      throw new Error('expected MFA-required branch');
    }
    expect(out.challenge_token).toBe('one-time-token');
    // Type narrowing also excludes the session field on the MFA branch.
    expect('session' in out).toBe(false);
  });
});

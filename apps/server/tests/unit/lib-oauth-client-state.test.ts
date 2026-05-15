// V-667.C — unit tests for OAuth-client state-token sign/verify.

import { describe, expect, it } from 'vitest';
import { signOauthClientState, verifyOauthClientState } from '../../src/lib/oauth-client-state.js';

const SECRET = 'x'.repeat(48); // ≥32 chars per lib min
const BASE = {
  provider: 'google' as const,
  redirectTo: 'https://app.driftstack.dev/billing',
  signingSecret: SECRET,
  nowMs: 1_715_000_000_000,
  nonce: 'fixed-nonce-1234',
};

describe('signOauthClientState', () => {
  it('produces a 2-part base64url.signature string', () => {
    const token = signOauthClientState(BASE);
    const parts = token.split('.');
    expect(parts.length).toBe(2);
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('deterministic when nowMs + nonce are fixed', () => {
    const t1 = signOauthClientState(BASE);
    const t2 = signOauthClientState(BASE);
    expect(t1).toBe(t2);
  });

  it('different nonce → different signature', () => {
    const t1 = signOauthClientState({ ...BASE, nonce: 'a' });
    const t2 = signOauthClientState({ ...BASE, nonce: 'b' });
    expect(t1).not.toBe(t2);
  });

  it('rejects short signing secret (<32 chars)', () => {
    expect(() => signOauthClientState({ ...BASE, signingSecret: 'short' })).toThrow(TypeError);
  });
});

describe('verifyOauthClientState', () => {
  it('round-trips a fresh token to payload', () => {
    const token = signOauthClientState(BASE);
    const res = verifyOauthClientState({ token, signingSecret: SECRET, nowMs: BASE.nowMs });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.payload.provider).toBe('google');
      expect(res.payload.redirectTo).toBe(BASE.redirectTo);
      expect(res.payload.nonce).toBe(BASE.nonce);
      expect(res.payload.iat).toBe(1_715_000_000);
    }
  });

  it('malformed token (no dot) → kind: malformed', () => {
    const res = verifyOauthClientState({ token: 'notatoken', signingSecret: SECRET });
    expect(res.kind).toBe('malformed');
  });

  it('tampered payload → kind: bad-signature', () => {
    const token = signOauthClientState(BASE);
    const [_, sig] = token.split('.');
    const tampered = 'eyJtYWxpY2lvdXMiOnRydWV9' + '.' + sig; // valid base64url but different payload
    const res = verifyOauthClientState({ token: tampered, signingSecret: SECRET });
    expect(res.kind).toBe('bad-signature');
  });

  it('signed with wrong secret → kind: bad-signature', () => {
    const token = signOauthClientState(BASE);
    const res = verifyOauthClientState({ token, signingSecret: 'wrong'.repeat(10) });
    expect(res.kind).toBe('bad-signature');
  });

  it('expired token (>5min by default) → kind: expired', () => {
    const token = signOauthClientState(BASE);
    const sixMinLater = BASE.nowMs + 6 * 60 * 1000;
    const res = verifyOauthClientState({ token, signingSecret: SECRET, nowMs: sixMinLater });
    expect(res.kind).toBe('expired');
  });

  it('respects custom ttlSeconds (10s example, 30s later → expired)', () => {
    const token = signOauthClientState(BASE);
    const thirtySecLater = BASE.nowMs + 30 * 1000;
    const res = verifyOauthClientState({
      token,
      signingSecret: SECRET,
      nowMs: thirtySecLater,
      ttlSeconds: 10,
    });
    expect(res.kind).toBe('expired');
  });

  it('provider narrow type preserved through round-trip', () => {
    const token = signOauthClientState({ ...BASE, provider: 'github' });
    const res = verifyOauthClientState({ token, signingSecret: SECRET, nowMs: BASE.nowMs });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.payload.provider).toBe('github');
  });
});

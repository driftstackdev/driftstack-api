// V-553 follow-up — direct runtime unit coverage for lib/auth-tokens.ts.
// The existing parity tests pin the *file shape*; this file pins the
// *runtime behaviour* of the 4 exported functions + TTL map.

import { describe, expect, it } from 'vitest';

import {
  AUTH_TOKEN_TTL_MS,
  TOKEN_RANDOM_BYTES,
  generateAuthToken,
  hashPassword,
  tokenHash,
  verifyPassword,
} from '../../src/lib/auth-tokens.js';

describe('generateAuthToken', () => {
  it('returns a URL-safe base64 string with no padding', () => {
    const t = generateAuthToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('decodes to exactly TOKEN_RANDOM_BYTES bytes (32 entropy bytes)', () => {
    const t = generateAuthToken();
    const buf = Buffer.from(t, 'base64url');
    expect(buf.length).toBe(TOKEN_RANDOM_BYTES);
  });

  it('emits a fresh value on every call (probabilistic — 256-bit entropy)', () => {
    const set = new Set<string>();
    for (let i = 0; i < 50; i += 1) set.add(generateAuthToken());
    expect(set.size).toBe(50);
  });
});

describe('tokenHash', () => {
  it('returns 64 lowercase hex characters (sha256 hex digest)', () => {
    const h = tokenHash('any-plaintext');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input → same hash', () => {
    const a = tokenHash('plaintext');
    const b = tokenHash('plaintext');
    expect(a).toBe(b);
  });

  it('discriminates inputs — different input → different hash', () => {
    const a = tokenHash('plaintext-1');
    const b = tokenHash('plaintext-2');
    expect(a).not.toBe(b);
  });

  it('discriminates inputs differing by one character', () => {
    const a = tokenHash('plaintext');
    const b = tokenHash('plaintextA');
    expect(a).not.toBe(b);
  });
});

describe('hashPassword + verifyPassword (round-trip)', () => {
  it('verifyPassword returns true for the original plaintext', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true);
  });

  it('verifyPassword returns false for a wrong plaintext', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Tr0ub4dor&3', encoded)).toBe(false);
  });

  it('two hash calls on the same password produce different encoded strings (random salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    // But both verify the original plaintext.
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });
});

describe('AUTH_TOKEN_TTL_MS', () => {
  it('signupVerification = 30 minutes', () => {
    expect(AUTH_TOKEN_TTL_MS.signupVerification).toBe(30 * 60 * 1000);
  });
  it('magicLink = 15 minutes', () => {
    expect(AUTH_TOKEN_TTL_MS.magicLink).toBe(15 * 60 * 1000);
  });
  it('passwordReset = 1 hour', () => {
    expect(AUTH_TOKEN_TTL_MS.passwordReset).toBe(60 * 60 * 1000);
  });
  it('webSession = 30 days', () => {
    expect(AUTH_TOKEN_TTL_MS.webSession).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it('TTLs strictly increase: magicLink < signupVerification < passwordReset < webSession', () => {
    expect(AUTH_TOKEN_TTL_MS.magicLink).toBeLessThan(AUTH_TOKEN_TTL_MS.signupVerification);
    expect(AUTH_TOKEN_TTL_MS.signupVerification).toBeLessThan(AUTH_TOKEN_TTL_MS.passwordReset);
    expect(AUTH_TOKEN_TTL_MS.passwordReset).toBeLessThan(AUTH_TOKEN_TTL_MS.webSession);
  });
});

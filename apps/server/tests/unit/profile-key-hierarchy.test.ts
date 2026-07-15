// Tests for the profile key hierarchy (planning file 57): Master → TMK (HKDF) →
// DEK (AES-256-GCM envelope). Covers determinism, round-trip, GCM tamper
// detection, cross-account isolation (a wrong-account TMK can't unwrap), and
// wrong-master rejection.

import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeMasterKey,
  deriveTenantMasterKey,
  keysEqual,
  mintDek,
  mintWrappedProfileDek,
  PROFILE_DEK_V2_PREFIX,
  unwrapAccountSecret,
  unwrapDek,
  unwrapLegacyProfileDek,
  unwrapProfileDek,
  unwrapSecret,
  wrapAccountSecret,
  wrapDek,
  wrapProfileDek,
  wrapSecret,
} from '../../src/lib/profile-key-hierarchy.js';

const MASTER = Buffer.alloc(32, 9).toString('base64');
const OTHER_MASTER = Buffer.alloc(32, 5).toString('base64');
const ACCT_A = '11111111-1111-1111-1111-111111111111';
const ACCT_B = '22222222-2222-2222-2222-222222222222';
const ACCT_CASE = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const PROFILE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROFILE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('decodeMasterKey', () => {
  it('accepts a 32-byte base64 key', () => {
    expect(decodeMasterKey(MASTER).length).toBe(32);
  });
  it('rejects a wrong-length key', () => {
    expect(() => decodeMasterKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('deriveTenantMasterKey', () => {
  it('is deterministic for the same (master, account)', () => {
    const m = decodeMasterKey(MASTER);
    expect(keysEqual(deriveTenantMasterKey(m, ACCT_A), deriveTenantMasterKey(m, ACCT_A))).toBe(
      true,
    );
  });
  it('differs across accounts', () => {
    const m = decodeMasterKey(MASTER);
    expect(keysEqual(deriveTenantMasterKey(m, ACCT_A), deriveTenantMasterKey(m, ACCT_B))).toBe(
      false,
    );
  });
  it('differs across master keys', () => {
    expect(
      keysEqual(
        deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A),
        deriveTenantMasterKey(decodeMasterKey(OTHER_MASTER), ACCT_A),
      ),
    ).toBe(false);
  });
  it('requires a non-empty accountId', () => {
    expect(() => deriveTenantMasterKey(decodeMasterKey(MASTER), '')).toThrow(/accountId/);
  });
});

describe('mintDek', () => {
  it('returns 32 random bytes (distinct per call)', () => {
    const a = mintDek();
    const b = mintDek();
    expect(a.length).toBe(32);
    expect(keysEqual(a, b)).toBe(false);
  });
});

describe('wrapDek / unwrapDek', () => {
  it('round-trips a DEK under a TMK', () => {
    const tmk = deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A);
    const dek = mintDek();
    expect(keysEqual(unwrapDek(wrapDek(dek, tmk), tmk), dek)).toBe(true);
  });
  it('is non-deterministic (fresh IV per wrap)', () => {
    const tmk = deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A);
    const dek = mintDek();
    expect(wrapDek(dek, tmk)).not.toBe(wrapDek(dek, tmk));
  });
  it('throws on a tampered blob (GCM tag fails)', () => {
    const tmk = deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A);
    const wrapped = wrapDek(mintDek(), tmk);
    const buf = Buffer.from(wrapped, 'base64');
    buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0xff; // flip a ciphertext byte
    expect(() => unwrapDek(buf.toString('base64'), tmk)).toThrow();
  });
  it('throws on a wrong-length blob', () => {
    const tmk = deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A);
    expect(() => unwrapDek(Buffer.alloc(10, 0).toString('base64'), tmk)).toThrow(/bytes/);
  });
  it('rejects a non-32-byte DEK at wrap', () => {
    const tmk = deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A);
    expect(() => wrapDek(Buffer.alloc(16, 1), tmk)).toThrow(/32 bytes/);
  });
});

describe('mintWrappedProfileDek / unwrapProfileDek', () => {
  it('round-trips only for the same account and profile', () => {
    const m = decodeMasterKey(MASTER);
    const { dek, wrappedDek } = mintWrappedProfileDek(m, ACCT_A, PROFILE_A);
    expect(wrappedDek.startsWith(PROFILE_DEK_V2_PREFIX)).toBe(true);
    expect(keysEqual(unwrapProfileDek(m, ACCT_A, PROFILE_A, wrappedDek), dek)).toBe(true);
  });
  it('CROSS-ACCOUNT ISOLATION: account B cannot unwrap account A’s DEK', () => {
    const m = decodeMasterKey(MASTER);
    const { wrappedDek } = mintWrappedProfileDek(m, ACCT_A, PROFILE_A);
    expect(() => unwrapProfileDek(m, ACCT_B, PROFILE_A, wrappedDek)).toThrow();
  });
  it('SAME-ACCOUNT RELOCATION: profile B cannot unwrap profile A’s DEK', () => {
    const m = decodeMasterKey(MASTER);
    const { wrappedDek } = mintWrappedProfileDek(m, ACCT_A, PROFILE_A);
    expect(() => unwrapProfileDek(m, ACCT_A, PROFILE_B, wrappedDek)).toThrow();
  });
  it('a different master key cannot unwrap', () => {
    const { wrappedDek } = mintWrappedProfileDek(decodeMasterKey(MASTER), ACCT_A, PROFILE_A);
    expect(() =>
      unwrapProfileDek(decodeMasterKey(OTHER_MASTER), ACCT_A, PROFILE_A, wrappedDek),
    ).toThrow();
  });
  it('normalizes UUID case in the authenticated context', () => {
    const m = decodeMasterKey(MASTER);
    const dek = mintDek();
    const wrapped = wrapProfileDek(m, ACCT_CASE.toUpperCase(), PROFILE_A.toUpperCase(), dek);
    expect(keysEqual(unwrapProfileDek(m, ACCT_CASE, PROFILE_A, wrapped), dek)).toBe(true);
  });
  it('rejects prefixless input and reserves the legacy reader for bootstrap', () => {
    const m = decodeMasterKey(MASTER);
    const dek = mintDek();
    const legacy = wrapDek(dek, deriveTenantMasterKey(m, ACCT_A));
    expect(() => unwrapProfileDek(m, ACCT_A, PROFILE_A, legacy)).toThrow(/v2 envelope/);
    expect(keysEqual(unwrapLegacyProfileDek(m, ACCT_A, legacy), dek)).toBe(true);
    const v2 = wrapProfileDek(m, ACCT_A, PROFILE_A, dek);
    expect(() => unwrapLegacyProfileDek(m, ACCT_A, v2)).toThrow(/refuses a v2/);
  });
  it('rejects noncanonical base64 and ciphertext tampering', () => {
    const m = decodeMasterKey(MASTER);
    const wrapped = wrapProfileDek(m, ACCT_A, PROFILE_A, mintDek());
    const payloadText = wrapped.slice(PROFILE_DEK_V2_PREFIX.length);
    // Keep the required 80-character envelope length while replacing one base64
    // character with whitespace, which Node's permissive decoder ignores. The
    // round-trip canonical check must reject this deterministically. Replacing
    // the final character with `=` was random: for some preceding sextets it is
    // the canonical encoding of a shorter 59-byte payload, so the fixed-length
    // guard correctly fired before this assertion instead.
    const noncanonical = `${payloadText.slice(0, -1)}\n`;
    expect(() =>
      unwrapProfileDek(m, ACCT_A, PROFILE_A, `${PROFILE_DEK_V2_PREFIX}${noncanonical}`),
    ).toThrow(/canonical base64/);
    expect(() =>
      unwrapProfileDek(m, ACCT_A, PROFILE_A, `${PROFILE_DEK_V2_PREFIX}${'A'.repeat(1_000_000)}`),
    ).toThrow(/80/);
    const payload = Buffer.from(payloadText, 'base64');
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 0xff;
    expect(() =>
      unwrapProfileDek(
        m,
        ACCT_A,
        PROFILE_A,
        `${PROFILE_DEK_V2_PREFIX}${payload.toString('base64')}`,
      ),
    ).toThrow();
  });
  it('rejects purpose confusion and authenticated wrong-length plaintext', () => {
    const m = decodeMasterKey(MASTER);
    const tmk = deriveTenantMasterKey(m, ACCT_A);
    const makeEnvelope = (purpose: string, plaintext: Buffer): string => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', tmk, iv);
      cipher.setAAD(Buffer.from(JSON.stringify([purpose, 2, ACCT_A, PROFILE_A]), 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return `${PROFILE_DEK_V2_PREFIX}${Buffer.concat([
        iv,
        cipher.getAuthTag(),
        ciphertext,
      ]).toString('base64')}`;
    };
    expect(() =>
      unwrapProfileDek(
        m,
        ACCT_A,
        PROFILE_A,
        makeEnvelope('driftstack.account-proxy-secret', Buffer.alloc(32, 1)),
      ),
    ).toThrow();
    expect(() =>
      unwrapProfileDek(
        m,
        ACCT_A,
        PROFILE_A,
        makeEnvelope('driftstack.profile-dek', Buffer.alloc(31, 1)),
      ),
    ).toThrow(/expected exactly/);
  });
});

// ARC A — arbitrary-length account secrets (customer proxy passwords). Same
// AEAD + TMK as the DEK, so the same isolation guarantees must hold.
describe('wrapSecret / unwrapSecret', () => {
  it('round-trips an arbitrary-length secret under a raw TMK', () => {
    const tmk = deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A);
    const secret = Buffer.from('s0cks-p@ssw0rd-with-üñïçödé-and-长度', 'utf8');
    expect(unwrapSecret(wrapSecret(secret, tmk), tmk).equals(secret)).toBe(true);
  });
  it('handles an empty secret', () => {
    const tmk = deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A);
    expect(unwrapSecret(wrapSecret(Buffer.alloc(0), tmk), tmk).length).toBe(0);
  });
  it('produces distinct ciphertext per call (random IV) for the same plaintext', () => {
    const tmk = deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A);
    const p = Buffer.from('same', 'utf8');
    expect(wrapSecret(p, tmk)).not.toBe(wrapSecret(p, tmk));
  });
  it('a wrong TMK cannot unwrap (GCM tag fails)', () => {
    const m = decodeMasterKey(MASTER);
    const wrapped = wrapSecret(Buffer.from('x'), deriveTenantMasterKey(m, ACCT_A));
    expect(() => unwrapSecret(wrapped, deriveTenantMasterKey(m, ACCT_B))).toThrow();
  });
  it('rejects a too-short blob', () => {
    const tmk = deriveTenantMasterKey(decodeMasterKey(MASTER), ACCT_A);
    expect(() => unwrapSecret(Buffer.alloc(4, 1).toString('base64'), tmk)).toThrow(/at least/);
  });
});

describe('wrapAccountSecret / unwrapAccountSecret', () => {
  it('round-trips for the same account', () => {
    const m = decodeMasterKey(MASTER);
    const secret = Buffer.from('hunter2', 'utf8');
    const wrapped = wrapAccountSecret(m, ACCT_A, secret);
    expect(unwrapAccountSecret(m, ACCT_A, wrapped).equals(secret)).toBe(true);
  });
  it('CROSS-ACCOUNT ISOLATION: account B cannot unwrap account A’s proxy secret', () => {
    const m = decodeMasterKey(MASTER);
    const wrapped = wrapAccountSecret(m, ACCT_A, Buffer.from('hunter2'));
    expect(() => unwrapAccountSecret(m, ACCT_B, wrapped)).toThrow();
  });
  it('a different master key cannot unwrap', () => {
    const wrapped = wrapAccountSecret(decodeMasterKey(MASTER), ACCT_A, Buffer.from('hunter2'));
    expect(() => unwrapAccountSecret(decodeMasterKey(OTHER_MASTER), ACCT_A, wrapped)).toThrow();
  });
  it('the wrapped form never contains the plaintext', () => {
    const wrapped = wrapAccountSecret(decodeMasterKey(MASTER), ACCT_A, Buffer.from('hunter2'));
    expect(Buffer.from(wrapped, 'base64').toString('utf8')).not.toContain('hunter2');
  });
});

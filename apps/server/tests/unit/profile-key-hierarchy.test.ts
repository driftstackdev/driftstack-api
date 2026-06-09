// Tests for the profile key hierarchy (planning file 57): Master → TMK (HKDF) →
// DEK (AES-256-GCM envelope). Covers determinism, round-trip, GCM tamper
// detection, cross-account isolation (a wrong-account TMK can't unwrap), and
// wrong-master rejection.

import { describe, expect, it } from 'vitest';
import {
  decodeMasterKey,
  deriveTenantMasterKey,
  keysEqual,
  mintDek,
  mintWrappedProfileDek,
  unwrapDek,
  unwrapProfileDek,
  wrapDek,
} from '../../src/lib/profile-key-hierarchy.js';

const MASTER = Buffer.alloc(32, 9).toString('base64');
const OTHER_MASTER = Buffer.alloc(32, 5).toString('base64');
const ACCT_A = '11111111-1111-1111-1111-111111111111';
const ACCT_B = '22222222-2222-2222-2222-222222222222';

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
  it('round-trips for the same account', () => {
    const m = decodeMasterKey(MASTER);
    const { dek, wrappedDek } = mintWrappedProfileDek(m, ACCT_A);
    expect(keysEqual(unwrapProfileDek(m, ACCT_A, wrappedDek), dek)).toBe(true);
  });
  it('CROSS-ACCOUNT ISOLATION: account B cannot unwrap account A’s DEK', () => {
    const m = decodeMasterKey(MASTER);
    const { wrappedDek } = mintWrappedProfileDek(m, ACCT_A);
    expect(() => unwrapProfileDek(m, ACCT_B, wrappedDek)).toThrow();
  });
  it('a different master key cannot unwrap', () => {
    const { wrappedDek } = mintWrappedProfileDek(decodeMasterKey(MASTER), ACCT_A);
    expect(() => unwrapProfileDek(decodeMasterKey(OTHER_MASTER), ACCT_A, wrappedDek)).toThrow();
  });
});

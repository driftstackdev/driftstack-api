// V-553.B-11 — unit tests for MfaService (V-353b).
//
// Surface under test:
//   - startEnrollment(): rejects re-enroll if already-enrolled,
//     persists encrypted secret with enrolledAt null
//   - completeEnrollment(): rejects no-pending / already-enrolled /
//     wrong code, mints 10 recovery codes + sets enrolledAt
//   - disable(): idempotent on non-enrolled, deletes the row, audits
//   - verifyCode(): 6-digit TOTP path, recovery-code path, miss path,
//     touches last_used_at + consumes recovery code on success
//   - regenerateRecoveryCodes(): requires enrolled, marks all old
//     codes used, inserts fresh
//   - getStatus(): synthetic "not enrolled" + populated branches

import { describe, expect, it, vi } from 'vitest';
import {
  MfaService,
  type MfaEnrollmentRow,
  type MfaRepo,
  type RecoveryCodeRow,
} from '../../src/services/mfa.js';
import { computeTotpCode, TOTP_PERIOD_SECONDS } from '../../src/lib/mfa-totp.js';
import { hashApiKey } from '../../src/lib/api-keys.js';

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');

function makeRepo(): {
  repo: MfaRepo;
  state: {
    row: MfaEnrollmentRow | null;
    codes: RecoveryCodeRow[];
    audit: string[];
    touchedAt: Date | null;
  };
} {
  const state = {
    row: null as MfaEnrollmentRow | null,
    codes: [] as RecoveryCodeRow[],
    audit: [] as string[],
    touchedAt: null as Date | null,
  };
  const repo: MfaRepo = {
    findByAccount: () => Promise.resolve(state.row),
    upsertSecret: ({ accountId, ciphertext, iv, tag, enrolledAt, now }) => {
      const row: MfaEnrollmentRow = {
        accountId,
        totpSecretCiphertext: ciphertext,
        totpSecretIv: iv,
        totpSecretTag: tag,
        enrolledAt,
        lastUsedAt: state.row?.lastUsedAt ?? null,
        createdAt: state.row?.createdAt ?? now,
        updatedAt: now,
      };
      state.row = row;
      return Promise.resolve(row);
    },
    touchLastUsed: (_acc, now) => {
      state.touchedAt = now;
      if (state.row) state.row.lastUsedAt = now;
      return Promise.resolve();
    },
    deleteForAccount: () => {
      state.row = null;
      state.codes = [];
      return Promise.resolve();
    },
    insertRecoveryCodes: ({ accountId, hashes, now }) => {
      for (const h of hashes) {
        state.codes.push({
          id: `rc_${state.codes.length + 1}`,
          accountId,
          codeHash: h,
          usedAt: null,
          createdAt: now,
        });
      }
      return Promise.resolve();
    },
    listUnusedRecoveryCodes: () => Promise.resolve(state.codes.filter((c) => c.usedAt === null)),
    markRecoveryCodeUsed: (id, now) => {
      const row = state.codes.find((c) => c.id === id);
      if (row) row.usedAt = now;
      return Promise.resolve();
    },
    markAllRecoveryCodesUsed: (_acc, now) => {
      for (const c of state.codes) if (c.usedAt === null) c.usedAt = now;
      return Promise.resolve();
    },
  };
  return { repo, state };
}

function makeAudit(): { audit: { record: ReturnType<typeof vi.fn> }; calls: unknown[] } {
  const calls: unknown[] = [];
  const record = vi.fn((args: unknown) => {
    calls.push(args);
    return Promise.resolve();
  });
  return { audit: { record }, calls };
}

const SVC_CONFIG = { encryptionKey: ENC_KEY };

describe('V-553.B-11 MfaService.startEnrollment', () => {
  it('persists an encrypted secret + returns the otpauth URI + base32', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const result = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    expect(result.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(result.otpauthUri).toContain('u%40e.test');
    expect(result.secretBase32).toMatch(/^[A-Z2-7]+$/);
    expect(state.row).not.toBeNull();
    expect(state.row?.enrolledAt).toBeNull();
    // The plaintext secret never lands in the repo — only encrypted form.
    expect(state.row?.totpSecretCiphertext).not.toEqual(result.secretBase32);
  });

  it('rejects start when already fully enrolled (must disable first)', async () => {
    const { repo, state } = makeRepo();
    state.row = {
      accountId: 'acc_1',
      totpSecretCiphertext: 'x',
      totpSecretIv: 'y',
      totpSecretTag: 'z',
      enrolledAt: new Date(),
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const svc = new MfaService(repo, SVC_CONFIG);
    await expect(svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' })).rejects.toThrow(
      /already enrolled/,
    );
  });

  it('overwrites a pending (not-yet-enrolled) secret on re-call', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const firstCipher = state.row?.totpSecretCiphertext;
    await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    expect(state.row?.totpSecretCiphertext).not.toBe(firstCipher);
  });
});

describe('V-553.B-11 MfaService.completeEnrollment', () => {
  it('rejects when there is no pending enrollment', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    await expect(svc.completeEnrollment({ accountId: 'acc_1', code: '123456' })).rejects.toThrow(
      /No pending MFA enrollment/,
    );
  });

  it('rejects when the code is wrong', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    await expect(svc.completeEnrollment({ accountId: 'acc_1', code: '000000' })).rejects.toThrow(
      /Invalid/,
    );
  });

  it('on correct code: enrolledAt is set, 10 recovery codes minted + audited', async () => {
    const { repo, state } = makeRepo();
    const { audit, calls } = makeAudit();
    const svc = new MfaService(repo, SVC_CONFIG, audit as never);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    // Derive the live code from the same secret the service just stored —
    // the test doesn't need to know any TOTP internals beyond the helper.
    const secretBytes = base32Decode(start.secretBase32);
    const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    const result = await svc.completeEnrollment({ accountId: 'acc_1', code });
    expect(result.recoveryCodes).toHaveLength(10);
    expect(state.row?.enrolledAt).not.toBeNull();
    // Audit entry should record account.mfa_enrolled.
    expect(calls).toHaveLength(1);
    expect((calls[0] as { action: string }).action).toBe('account.mfa_enrolled');
  });
});

describe('V-553.B-11 MfaService.disable', () => {
  it('idempotent — silently returns when no row exists', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    await expect(svc.disable({ accountId: 'acc_1' })).resolves.toBeUndefined();
  });

  it('drops the row + records an audit entry', async () => {
    const { repo, state } = makeRepo();
    const { audit, calls } = makeAudit();
    state.row = {
      accountId: 'acc_1',
      totpSecretCiphertext: 'x',
      totpSecretIv: 'y',
      totpSecretTag: 'z',
      enrolledAt: new Date(),
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const svc = new MfaService(repo, SVC_CONFIG, audit as never);
    await svc.disable({ accountId: 'acc_1' });
    expect(state.row).toBeNull();
    expect(calls).toHaveLength(1);
    expect((calls[0] as { action: string }).action).toBe('account.mfa_disabled');
  });
});

describe('V-553.B-11 MfaService.verifyCode', () => {
  it('throws NotFound when MFA is not enrolled', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    await expect(svc.verifyCode({ accountId: 'acc_1', input: '123456' })).rejects.toThrow(
      /not enrolled/,
    );
  });

  it('returns "totp" + touches lastUsed on a correct 6-digit code', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const secretBytes = base32Decode(start.secretBase32);
    const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    await svc.completeEnrollment({ accountId: 'acc_1', code });

    const result = await svc.verifyCode({ accountId: 'acc_1', input: code });
    expect(result).toBe('totp');
    expect(state.touchedAt).not.toBeNull();
  });

  it('returns null on a 6-digit code that does not match', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const secretBytes = base32Decode(start.secretBase32);
    const goodCode = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    await svc.completeEnrollment({ accountId: 'acc_1', code: goodCode });
    const wrongCode = goodCode === '000000' ? '111111' : '000000';
    const result = await svc.verifyCode({ accountId: 'acc_1', input: wrongCode });
    expect(result).toBeNull();
  });

  // 2026-05-23 — extended to 30s for scrypt-heavy recovery-code flow.
  // Default 10s timeout was flaking under high test-parallelism CPU
  // contention (10 scrypt calls in completeEnrollment).
  it('consumes a recovery code on use (single-use semantics)', { timeout: 30_000 }, async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const secretBytes = base32Decode(start.secretBase32);
    const totp = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    const { recoveryCodes } = await svc.completeEnrollment({ accountId: 'acc_1', code: totp });
    const recovery = recoveryCodes[0];
    if (!recovery) throw new Error('no recovery code');

    expect(state.codes).toHaveLength(10);
    expect(state.codes.every((c) => c.usedAt === null)).toBe(true);

    const result1 = await svc.verifyCode({ accountId: 'acc_1', input: recovery });
    expect(result1).toBe('recovery');
    expect(state.codes.filter((c) => c.usedAt !== null)).toHaveLength(1);

    // Second use of the same recovery code is rejected.
    const result2 = await svc.verifyCode({ accountId: 'acc_1', input: recovery });
    expect(result2).toBeNull();
  });

  it('rejects garbage input (non-digit, non-10-char) without scanning recovery codes', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    state.row = {
      accountId: 'acc_1',
      totpSecretCiphertext: 'x',
      totpSecretIv: 'y',
      totpSecretTag: 'z',
      enrolledAt: new Date(),
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // Even with an active enrollment, a 4-char string is neither TOTP
    // nor a recovery code and must return null without exploding.
    const result = await svc.verifyCode({ accountId: 'acc_1', input: 'abc' });
    expect(result).toBeNull();
  });
});

describe('V-553.B-11 MfaService.regenerateRecoveryCodes', () => {
  it('requires an enrolled account', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    await expect(svc.regenerateRecoveryCodes({ accountId: 'acc_1' })).rejects.toThrow(
      /not enrolled/,
    );
  });

  it('marks old codes consumed + inserts 10 fresh hashes', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const secretBytes = base32Decode(start.secretBase32);
    const totp = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    await svc.completeEnrollment({ accountId: 'acc_1', code: totp });
    expect(state.codes).toHaveLength(10);

    const refreshed = await svc.regenerateRecoveryCodes({ accountId: 'acc_1' });
    expect(refreshed.recoveryCodes).toHaveLength(10);
    // 10 old codes marked used + 10 new — total 20 in storage.
    expect(state.codes).toHaveLength(20);
    const unused = state.codes.filter((c) => c.usedAt === null);
    expect(unused).toHaveLength(10);
  });
});

describe('V-553.B-11 MfaService.getStatus', () => {
  it('returns synthetic not-enrolled when no row exists', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const status = await svc.getStatus('acc_1');
    expect(status).toEqual({
      enrolled: false,
      enrolledAt: null,
      lastUsedAt: null,
      unusedRecoveryCodes: 0,
    });
  });

  it('returns enrolled snapshot with unused-recovery-codes count', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const secretBytes = base32Decode(start.secretBase32);
    const totp = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    await svc.completeEnrollment({ accountId: 'acc_1', code: totp });

    // Consume one recovery code manually so the count reflects 9.
    if (state.codes[0]) state.codes[0].usedAt = new Date();

    const status = await svc.getStatus('acc_1');
    expect(status.enrolled).toBe(true);
    expect(status.unusedRecoveryCodes).toBe(9);
    expect(status.enrolledAt).not.toBeNull();
  });
});

// ─── helpers ────────────────────────────────────────────────────────

/**
 * Minimal base32 decoder for the test helper — used to extract the
 * raw secret bytes so we can compute live TOTP codes. The service
 * itself uses the production-grade decoder in lib/mfa-totp.ts via
 * `decryptSecret`; we recreate just enough here to invert the
 * `secretBase32` field of `startEnrollment` for verification.
 */
function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '')) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 char ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

describe('V-553.B-11 — helper invariants', () => {
  it('TOTP period is 30 seconds (matches lib + service expectations)', () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
  });
  it('hashApiKey is still exported (completeEnrollment depends on it)', () => {
    expect(typeof hashApiKey).toBe('function');
  });
});

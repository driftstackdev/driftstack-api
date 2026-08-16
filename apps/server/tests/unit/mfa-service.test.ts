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
const CURRENT_WEB_SESSION_ID = 'ws_current';

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
  const insertHashes = (args: { accountId: string; hashes: string[]; now: Date }): void => {
    for (const h of args.hashes) {
      state.codes.push({
        id: `rc_${state.codes.length + 1}`,
        accountId: args.accountId,
        codeHash: h,
        usedAt: null,
        createdAt: args.now,
      });
    }
  };
  const repo: MfaRepo = {
    findByAccount: () => Promise.resolve(state.row),
    startEnrollmentIfNotEnrolled: ({ accountId, ciphertext, iv, tag, now }) => {
      if (state.row?.enrolledAt != null) return Promise.resolve(null);
      const updatedAt = state.row
        ? new Date(Math.max(now.getTime(), state.row.updatedAt.getTime() + 1))
        : now;
      const row: MfaEnrollmentRow = {
        accountId,
        totpSecretCiphertext: ciphertext,
        totpSecretIv: iv,
        totpSecretTag: tag,
        enrolledAt: null,
        lastUsedAt: state.row?.lastUsedAt ?? null,
        lastUsedTotpCounter: state.row?.lastUsedTotpCounter ?? null,
        createdAt: state.row?.createdAt ?? now,
        updatedAt,
      };
      state.row = row;
      return Promise.resolve(row);
    },
    completeEnrollmentIfPending: ({ accountId, expectedUpdatedAt, hashes, now }) => {
      if (
        !state.row ||
        state.row.enrolledAt !== null ||
        state.row.updatedAt.getTime() !== expectedUpdatedAt.getTime()
      ) {
        return Promise.resolve(false);
      }
      state.row = {
        ...state.row,
        enrolledAt: now,
        updatedAt: new Date(Math.max(now.getTime(), state.row.updatedAt.getTime() + 1)),
      };
      insertHashes({ accountId, hashes, now });
      return Promise.resolve(true);
    },
    touchLastUsed: (_acc, now) => {
      state.touchedAt = now;
      if (state.row) {
        state.row.lastUsedAt = now;
        state.row.updatedAt = new Date(Math.max(now.getTime(), state.row.updatedAt.getTime() + 1));
      }
      return Promise.resolve();
    },
    // TOTP replay defence (migration 0090) — atomic strict-monotonic write.
    consumeTotpCounter: ({ counter, now }) => {
      const r = state.row;
      if (!r) return Promise.resolve(false);
      if (r.lastUsedTotpCounter !== null && r.lastUsedTotpCounter >= counter) {
        return Promise.resolve(false);
      }
      r.lastUsedTotpCounter = counter;
      r.updatedAt = new Date(Math.max(now.getTime(), r.updatedAt.getTime() + 1));
      return Promise.resolve(true);
    },
    deleteForAccount: () => {
      state.row = null;
      state.codes = [];
      return Promise.resolve();
    },
    listUnusedRecoveryCodes: () => Promise.resolve(state.codes.filter((c) => c.usedAt === null)),
    markRecoveryCodeUsed: (id, now) => {
      // Faithful to the DB's atomic conditional UPDATE (WHERE id = … AND used_at
      // IS NULL): only flip if STILL unused; return whether THIS call consumed it.
      const row = state.codes.find((c) => c.id === id);
      if (row && row.usedAt === null) {
        row.usedAt = now;
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    replaceRecoveryCodesIfCurrent: ({ accountId, expectedUpdatedAt, hashes, now }) => {
      if (
        !state.row ||
        state.row.enrolledAt === null ||
        state.row.updatedAt.getTime() !== expectedUpdatedAt.getTime()
      ) {
        return Promise.resolve(false);
      }
      state.row = {
        ...state.row,
        updatedAt: new Date(Math.max(now.getTime(), state.row.updatedAt.getTime() + 1)),
      };
      for (const c of state.codes) if (c.usedAt === null) c.usedAt = now;
      insertHashes({ accountId, hashes, now });
      return Promise.resolve(true);
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
      lastUsedTotpCounter: null,
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
    await expect(
      svc.completeEnrollment({
        accountId: 'acc_1',
        currentWebSessionId: CURRENT_WEB_SESSION_ID,
        code: '123456',
      }),
    ).rejects.toThrow(/No pending MFA enrollment/);
  });

  it('rejects when the code is wrong', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    await expect(
      svc.completeEnrollment({
        accountId: 'acc_1',
        currentWebSessionId: CURRENT_WEB_SESSION_ID,
        code: '000000',
      }),
    ).rejects.toThrow(/Invalid/);
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
    const result = await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code,
    });
    expect(result.recoveryCodes).toHaveLength(10);
    expect(state.row?.enrolledAt).not.toBeNull();
    // Audit entry should record account.mfa_enrolled.
    expect(calls).toHaveLength(1);
    expect((calls[0] as { action: string }).action).toBe('account.mfa_enrolled');
  });

  it('invalidates cached account authority only after enrollment commits', async () => {
    const { repo } = makeRepo();
    const invalidateAccount = vi.fn(() => Promise.resolve());
    const svc = new MfaService(repo, SVC_CONFIG, null, { invalidateAccount } as never);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const code = computeTotpCode(base32Decode(start.secretBase32), Math.floor(Date.now() / 1000));

    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code,
    });

    expect(invalidateAccount).toHaveBeenCalledOnce();
    expect(invalidateAccount).toHaveBeenCalledWith('acc_1');
  });

  it('allows exactly one concurrent enrollment completion to issue recovery codes', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const code = computeTotpCode(base32Decode(start.secretBase32), Math.floor(Date.now() / 1000));

    const results = await Promise.allSettled([
      svc.completeEnrollment({
        accountId: 'acc_1',
        currentWebSessionId: CURRENT_WEB_SESSION_ID,
        code,
      }),
      svc.completeEnrollment({
        accountId: 'acc_1',
        currentWebSessionId: CURRENT_WEB_SESSION_ID,
        code,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(state.row?.enrolledAt).not.toBeNull();
    expect(state.codes).toHaveLength(10);
    expect(state.codes.filter((candidate) => candidate.usedAt === null)).toHaveLength(10);
  });

  it('does not let a stale completion overwrite a concurrently restarted enrollment', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const first = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const code = computeTotpCode(base32Decode(first.secretBase32), Math.floor(Date.now() / 1000));

    const [completion, restart] = await Promise.allSettled([
      svc.completeEnrollment({
        accountId: 'acc_1',
        currentWebSessionId: CURRENT_WEB_SESSION_ID,
        code,
      }),
      svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' }),
    ]);

    expect(completion.status).toBe('rejected');
    expect(restart.status).toBe('fulfilled');
    expect(state.row?.enrolledAt).toBeNull();
    expect(state.codes).toHaveLength(0);
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
      lastUsedTotpCounter: null,
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
    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code,
    });

    const result = await svc.verifyCode({ accountId: 'acc_1', input: code });
    expect(result).toBe('totp');
    expect(state.touchedAt).not.toBeNull();
  });

  it('TOTP replay defence (migration 0090): the SAME code cannot be used twice within its window', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const secretBytes = base32Decode(start.secretBase32);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const code = computeTotpCode(secretBytes, nowSeconds);
    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code,
    });

    // First use succeeds + stamps the consumed counter.
    const first = await svc.verifyCode({ accountId: 'acc_1', input: code, nowSeconds });
    expect(first).toBe('totp');
    expect(state.row?.lastUsedTotpCounter).toBe(Math.floor(nowSeconds / TOTP_PERIOD_SECONDS));

    // Replay of the identical code at the same instant is REJECTED (the
    // counter was already consumed) — closes the ~90s replay window against
    // both the login challenge AND the step-up gate (both call verifyCode).
    const replay = await svc.verifyCode({ accountId: 'acc_1', input: code, nowSeconds });
    expect(replay).toBeNull();
  });

  // The test above covers SEQUENTIAL replay, which `matchedCounter <= lastUsed`
  // rejects before the repo is ever touched. There is a second defence after it,
  // and it guards a different attack:
  //
  //   const accepted = await this.repo.consumeTotpCounter({ … });
  //   if (!accepted) return null;   // ← this one
  //
  // It is reachable ONLY under concurrency. Two verifies of the same code that
  // both read `lastUsedTotpCounter` before either writes will both clear the
  // pre-check; the atomic strict-monotonic write then lets exactly one win, and
  // this branch is what makes the loser fail. Delete it and the loser falls
  // through to `touchLastUsed` and `return 'totp'`, so BOTH parallel
  // verifications of one intercepted code succeed — which is the whole point of
  // consuming the counter, and the source comment says so: "so two concurrent
  // verifies of the same code can't both win".
  //
  // Measured before writing this: removing that branch left all 38 MFA test files
  // green (490 tests), and a wider sweep of 156 files / 1,870 tests too. The
  // sequential replay test above passes either way, because it never reaches the
  // branch.
  //
  // The interleaving is forced rather than raced: both callers are held at
  // `consumeTotpCounter` until the second arrives, so both have provably passed
  // the pre-check. The underlying fake is the faithful one from makeRepo, which
  // models the atomic strict-monotonic write.
  it('CRITICAL two CONCURRENT verifies of one TOTP code cannot both succeed. Both clear the sequential pre-check by reading the same lastUsedTotpCounter, so only the atomic consume distinguishes them; without the !accepted branch the loser also returns totp and one intercepted code authenticates twice in parallel.', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const code = computeTotpCode(base32Decode(start.secretBase32), nowSeconds);
    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code,
    });

    let arrived = 0;
    let releaseBoth: () => void = () => undefined;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = (): void => {
        resolve();
      };
    });
    const racingRepo: MfaRepo = {
      ...repo,
      consumeTotpCounter: async (args) => {
        arrived += 1;
        if (arrived === 2) releaseBoth();
        await bothArrived;
        return repo.consumeTotpCounter(args);
      },
    };
    const racingSvc = new MfaService(racingRepo, SVC_CONFIG);

    const results = await Promise.all([
      racingSvc.verifyCode({ accountId: 'acc_1', input: code, nowSeconds }),
      racingSvc.verifyCode({ accountId: 'acc_1', input: code, nowSeconds }),
    ]);

    expect(arrived, 'both callers must reach the atomic consume').toBe(2);
    expect(
      results.filter((r) => r === 'totp').length,
      'exactly one concurrent verify may succeed',
    ).toBe(1);
    expect(results.filter((r) => r === null).length, 'the loser must be rejected').toBe(1);
    expect(state.row?.lastUsedTotpCounter).toBe(Math.floor(nowSeconds / TOTP_PERIOD_SECONDS));
  });

  it('TOTP replay defence: a code from an EARLIER timestep than the last consumed one is rejected (drift-window replay)', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const secretBytes = base32Decode(start.secretBase32);
    const t0 = Math.floor(Date.now() / 1000);
    const enrollCode = computeTotpCode(secretBytes, t0);
    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code: enrollCode,
    });

    // Consume the code at the NEXT timestep first.
    const tNext = t0 + TOTP_PERIOD_SECONDS;
    const codeNext = computeTotpCode(secretBytes, tNext);
    expect(await svc.verifyCode({ accountId: 'acc_1', input: codeNext, nowSeconds: tNext })).toBe(
      'totp',
    );
    expect(state.row?.lastUsedTotpCounter).toBe(Math.floor(tNext / TOTP_PERIOD_SECONDS));

    // An attacker who captured the PREVIOUS timestep's code (still inside the
    // ±1 drift window of tNext) cannot replay it — its counter <= last consumed.
    const codePrev = computeTotpCode(secretBytes, t0);
    expect(
      await svc.verifyCode({ accountId: 'acc_1', input: codePrev, nowSeconds: tNext }),
    ).toBeNull();
  });

  it('TOTP replay defence: a LATER fresh code (next window) is still accepted after a prior consume', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const secretBytes = base32Decode(start.secretBase32);
    const t0 = Math.floor(Date.now() / 1000);
    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code: computeTotpCode(secretBytes, t0),
    });

    const code0 = computeTotpCode(secretBytes, t0);
    expect(await svc.verifyCode({ accountId: 'acc_1', input: code0, nowSeconds: t0 })).toBe('totp');

    // A genuinely fresh code two windows later (strictly greater counter) is
    // accepted — the guard rejects replays, not legitimate later logins.
    const tLater = t0 + 2 * TOTP_PERIOD_SECONDS;
    const codeLater = computeTotpCode(secretBytes, tLater);
    expect(await svc.verifyCode({ accountId: 'acc_1', input: codeLater, nowSeconds: tLater })).toBe(
      'totp',
    );
  });

  it('returns null on a 6-digit code that does not match', async () => {
    const { repo } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const secretBytes = base32Decode(start.secretBase32);
    const goodCode = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code: goodCode,
    });
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
    const { recoveryCodes } = await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code: totp,
    });
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

  // #5 — two concurrent verifies of the SAME recovery code: exactly ONE may
  // succeed. The fix gates success on the atomic conditional-UPDATE rowcount, so
  // the loser of the race gets null even though it also scrypt-matched the code.
  it(
    'concurrent consume of the same recovery code: exactly one succeeds (#5)',
    { timeout: 30_000 },
    async () => {
      const { repo, state } = makeRepo();
      const svc = new MfaService(repo, SVC_CONFIG);
      const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
      const secretBytes = base32Decode(start.secretBase32);
      const totp = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
      const { recoveryCodes } = await svc.completeEnrollment({
        accountId: 'acc_1',
        currentWebSessionId: CURRENT_WEB_SESSION_ID,
        code: totp,
      });
      const recovery = recoveryCodes[0];
      if (!recovery) throw new Error('no recovery code');

      const [a, b] = await Promise.all([
        svc.verifyCode({ accountId: 'acc_1', input: recovery }),
        svc.verifyCode({ accountId: 'acc_1', input: recovery }),
      ]);
      const successes = [a, b].filter((r) => r === 'recovery');
      expect(successes).toHaveLength(1);
      // And the code is now spent (only one row consumed).
      expect(state.codes.filter((c) => c.usedAt !== null)).toHaveLength(1);
    },
  );

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
      lastUsedTotpCounter: null,
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
    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code: totp,
    });
    expect(state.codes).toHaveLength(10);

    const refreshed = await svc.regenerateRecoveryCodes({ accountId: 'acc_1' });
    expect(refreshed.recoveryCodes).toHaveLength(10);
    // 10 old codes marked used + 10 new — total 20 in storage.
    expect(state.codes).toHaveLength(20);
    const unused = state.codes.filter((c) => c.usedAt === null);
    expect(unused).toHaveLength(10);
  });

  it('allows exactly one concurrent regeneration to return a usable batch', async () => {
    const { repo, state } = makeRepo();
    const svc = new MfaService(repo, SVC_CONFIG);
    const start = await svc.startEnrollment({ accountId: 'acc_1', email: 'u@e.test' });
    const totp = computeTotpCode(base32Decode(start.secretBase32), Math.floor(Date.now() / 1000));
    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code: totp,
    });

    const results = await Promise.allSettled([
      svc.regenerateRecoveryCodes({ accountId: 'acc_1' }),
      svc.regenerateRecoveryCodes({ accountId: 'acc_1' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(state.codes).toHaveLength(20);
    expect(state.codes.filter((candidate) => candidate.usedAt === null)).toHaveLength(10);
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
    await svc.completeEnrollment({
      accountId: 'acc_1',
      currentWebSessionId: CURRENT_WEB_SESSION_ID,
      code: totp,
    });

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

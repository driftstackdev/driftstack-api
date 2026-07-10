// 2026-07-01 — account-deletion retention purge sweeper (GDPR Article 17
// close-out). Mirrors profile-trash-purge-sweeper.test.ts's shape.

import { describe, expect, it, vi } from 'vitest';
import type { AccountDeletionPurgeRepo } from '../../src/services/account-deletion-purge-sweeper.js';
import {
  AccountDeletionPurgeSweeperService,
  registerAccountDeletionPurgeJob,
  nextAccountDeletionPurgeRunAt,
  ACCOUNT_DELETION_PURGE_JOB_TYPE,
} from '../../src/services/account-deletion-purge-sweeper.js';
import type { BYOKAnthropicService } from '../../src/services/byok-anthropic.js';
import type { Logger } from '../../src/lib/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Minimal repo stub that records the cutoff tickOnce passes to the find query.
function stubRepo(ids: string[] = ['acc_1', 'acc_2', 'acc_3']): {
  repo: AccountDeletionPurgeRepo;
  cutoffs: Date[];
} {
  const cutoffs: Date[] = [];
  const repo: AccountDeletionPurgeRepo = {
    findDeletedAccountIdsWithByokKeyBefore: (cutoff: Date) => {
      cutoffs.push(cutoff);
      return Promise.resolve(ids);
    },
  };
  return { repo, cutoffs };
}

// Minimal BYOKAnthropicService stub recording which accountIds were cleared;
// `failOn` rejects for one id so we can assert the per-account error is
// tolerated (logged, not thrown) and the account is left for the next sweep.
function stubByok(opts: { failOn?: string } = {}): {
  byok: BYOKAnthropicService;
  cleared: string[];
} {
  const cleared: string[] = [];
  const byok = {
    clearKey: (args: { accountId: string }) => {
      if (opts.failOn !== undefined && args.accountId === opts.failOn) {
        return Promise.reject(new Error('clear boom'));
      }
      cleared.push(args.accountId);
      return Promise.resolve();
    },
  } as unknown as BYOKAnthropicService;
  return { byok, cleared };
}

describe('AccountDeletionPurgeSweeperService.tickOnce', () => {
  it('purges with a cutoff = now − retention (default 30 days) and returns the count', async () => {
    const { repo, cutoffs } = stubRepo();
    const { byok } = stubByok();
    const svc = new AccountDeletionPurgeSweeperService({ repo, byok });
    const now = new Date('2026-07-01T12:00:00.000Z');
    const res = await svc.tickOnce(now);
    expect(res.purged).toBe(3);
    expect(cutoffs).toHaveLength(1);
    expect(cutoffs[0]!.getTime()).toBe(now.getTime() - 30 * DAY_MS);
  });

  it('clears each candidate account BYOK Anthropic key via BYOKAnthropicService.clearKey', async () => {
    const { repo } = stubRepo(['acc_a', 'acc_b']);
    const { byok, cleared } = stubByok();
    const svc = new AccountDeletionPurgeSweeperService({ repo, byok });
    const res = await svc.tickOnce(new Date('2026-07-01T12:00:00.000Z'));
    expect(res.purged).toBe(2);
    expect(cleared).toEqual(['acc_a', 'acc_b']);
  });

  it('tolerates a per-account clearKey failure (logs, never throws; other accounts still purge)', async () => {
    const { repo } = stubRepo(['acc_a', 'acc_b']);
    const { byok, cleared } = stubByok({ failOn: 'acc_a' });
    const errors: unknown[] = [];
    const logger = { error: (o: unknown) => errors.push(o) } as never;
    const svc = new AccountDeletionPurgeSweeperService({ repo, byok, logger });
    const res = await svc.tickOnce(new Date('2026-07-01T12:00:00.000Z'));
    // acc_a failed to clear (stays a candidate next sweep); acc_b succeeded.
    expect(res.purged).toBe(1);
    expect(cleared).toEqual(['acc_b']);
    expect(errors).toHaveLength(1);
  });

  it('honors a custom retentionDays', async () => {
    const { repo, cutoffs } = stubRepo();
    const { byok } = stubByok();
    const svc = new AccountDeletionPurgeSweeperService({ repo, byok, retentionDays: 7 });
    const now = new Date('2026-07-01T12:00:00.000Z');
    await svc.tickOnce(now);
    expect(cutoffs[0]!.getTime()).toBe(now.getTime() - 7 * DAY_MS);
  });

  it('no candidates → purged 0, clearKey never called', async () => {
    const { repo } = stubRepo([]);
    const { byok, cleared } = stubByok();
    const svc = new AccountDeletionPurgeSweeperService({ repo, byok });
    const res = await svc.tickOnce(new Date('2026-07-01T12:00:00.000Z'));
    expect(res.purged).toBe(0);
    expect(cleared).toEqual([]);
  });
});

describe('nextAccountDeletionPurgeRunAt', () => {
  it('returns 05:00 UTC later today when now is before 05:00', () => {
    const next = nextAccountDeletionPurgeRunAt(new Date('2026-07-01T01:00:00.000Z'));
    expect(next.toISOString()).toBe('2026-07-01T05:00:00.000Z');
  });

  it('rolls to tomorrow 05:00 UTC when now is at/after 05:00', () => {
    const next = nextAccountDeletionPurgeRunAt(new Date('2026-07-01T05:00:00.000Z'));
    expect(next.toISOString()).toBe('2026-07-02T05:00:00.000Z');
    const next2 = nextAccountDeletionPurgeRunAt(new Date('2026-07-01T09:30:00.000Z'));
    expect(next2.toISOString()).toBe('2026-07-02T05:00:00.000Z');
  });
});

describe('job type', () => {
  it('is the stable account_deletion.purge identifier', () => {
    expect(ACCOUNT_DELETION_PURGE_JOB_TYPE).toBe('account_deletion.purge');
  });
});

describe('account-deletion purge sweep scheduling (chain survival)', () => {
  function fakeScheduledJobs() {
    const enqueues: Array<{ jobType: string; dedup: boolean; runAt: Date }> = [];
    let handler: ((job: unknown) => Promise<void>) | null = null;
    const scheduledJobs = {
      register: (_jobType: string, h: (job: unknown) => Promise<void>) => {
        handler = h;
      },
      enqueue: (args: { jobType: string; dedupOnAccountAndType: boolean; runAt: Date }) => {
        enqueues.push({
          jobType: args.jobType,
          dedup: args.dedupOnAccountAndType,
          runAt: args.runAt,
        });
        return Promise.resolve({ enqueued: true });
      },
    };
    return { scheduledJobs, enqueues, invoke: () => handler!({}) };
  }

  const NOW = new Date('2026-07-01T12:00:00.000Z');
  const noopLogger = { info: () => {}, error: () => {} } as unknown as Logger;

  it('the re-arm survives a tickOnce failure (chain never dies) and does not fan out', async () => {
    const f = fakeScheduledJobs();
    // A tick that always throws (e.g. the DB candidate query fails) must not stop
    // the self-re-arming chain: the handler swallows + re-arms exactly once. If
    // it re-threw, the poller would retry to maxAttempts then markFailed with no
    // pending sweep — the chain would die and no deleted account's BYOK key would
    // ever be purged again.
    // Captured mock (read off the variable, not the object → no-unbound-method).
    const tickOnce = vi.fn().mockRejectedValue(new Error('db down'));
    const sweeper = { tickOnce } as unknown as AccountDeletionPurgeSweeperService;

    registerAccountDeletionPurgeJob({
      scheduledJobs: f.scheduledJobs as never,
      sweeper,
      logger: noopLogger,
      nowFn: () => NOW.getTime(),
    });

    // The handler must resolve (not reject) despite the failing tick.
    await expect(f.invoke()).resolves.toBeUndefined();
    // Exactly one re-arm enqueued → chain alive, no duplicate parallel chains.
    expect(f.enqueues).toHaveLength(1);
    expect(f.enqueues[0]).toMatchObject({
      jobType: ACCOUNT_DELETION_PURGE_JOB_TYPE,
      dedup: false,
    });
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });

  it('bootstrap-style handler re-arms with dedup OFF after a successful tick', async () => {
    const f = fakeScheduledJobs();
    const tickOnce = vi.fn().mockResolvedValue({ purged: 0 });
    const sweeper = { tickOnce } as unknown as AccountDeletionPurgeSweeperService;

    registerAccountDeletionPurgeJob({
      scheduledJobs: f.scheduledJobs as never,
      sweeper,
      logger: noopLogger,
      nowFn: () => NOW.getTime(),
    });

    await expect(f.invoke()).resolves.toBeUndefined();
    expect(f.enqueues).toHaveLength(1);
    expect(f.enqueues[0]).toMatchObject({
      jobType: ACCOUNT_DELETION_PURGE_JOB_TYPE,
      dedup: false,
    });
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
});

// Tiny in-memory AccountDeletionPurgeRepo + BYOKAnthropicService double that
// models the REAL selection predicate (status='deleted' AND deletedAt <
// cutoff AND ciphertext still set) end-to-end, mirroring profile-trash-
// purge-sweeper.test.ts's "data correctness (in-memory repo)" section.
interface FakeAccountRow {
  id: string;
  status: 'active' | 'suspended' | 'deleted';
  deletedAt: Date | null;
  byokCiphertext: Buffer | null;
}

function makeInMemoryHarness(rows: FakeAccountRow[]): {
  repo: AccountDeletionPurgeRepo;
  byok: BYOKAnthropicService;
} {
  const repo: AccountDeletionPurgeRepo = {
    findDeletedAccountIdsWithByokKeyBefore: (cutoff: Date) =>
      Promise.resolve(
        rows
          .filter(
            (r) =>
              r.status === 'deleted' &&
              r.deletedAt !== null &&
              r.deletedAt.getTime() < cutoff.getTime() &&
              r.byokCiphertext !== null,
          )
          .map((r) => r.id),
      ),
  };
  const byok = {
    clearKey: (args: { accountId: string }) => {
      const row = rows.find((r) => r.id === args.accountId);
      if (row) row.byokCiphertext = null;
      return Promise.resolve();
    },
  } as unknown as BYOKAnthropicService;
  return { repo, byok };
}

describe('findDeletedAccountIdsWithByokKeyBefore data correctness (in-memory repo)', () => {
  it('NEVER purges an active/suspended account, a too-recently-deleted account, or one with no BYOK key set — only a deleted+past-cutoff+key-set account purges, and it self-limits (drops out once cleared)', async () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const rows: FakeAccountRow[] = [
      { id: 'acc_active', status: 'active', deletedAt: null, byokCiphertext: Buffer.from('x') },
      {
        id: 'acc_suspended',
        status: 'suspended',
        deletedAt: null,
        byokCiphertext: Buffer.from('x'),
      },
      {
        id: 'acc_no_key',
        status: 'deleted',
        deletedAt: new Date(now.getTime() - 45 * DAY_MS),
        byokCiphertext: null,
      },
      {
        id: 'acc_too_recent',
        status: 'deleted',
        deletedAt: new Date(now.getTime() - 5 * DAY_MS), // deleted only 5 days ago
        byokCiphertext: Buffer.from('x'),
      },
      {
        id: 'acc_eligible',
        status: 'deleted',
        deletedAt: new Date(now.getTime() - 45 * DAY_MS), // well past the 30-day window
        byokCiphertext: Buffer.from('x'),
      },
    ];
    const { repo, byok } = makeInMemoryHarness(rows);
    const svc = new AccountDeletionPurgeSweeperService({ repo, byok });

    const res = await svc.tickOnce(now);
    expect(res.purged).toBe(1);
    expect(rows.find((r) => r.id === 'acc_eligible')?.byokCiphertext).toBeNull();
    // Everyone else untouched.
    expect(rows.find((r) => r.id === 'acc_active')?.byokCiphertext).not.toBeNull();
    expect(rows.find((r) => r.id === 'acc_suspended')?.byokCiphertext).not.toBeNull();
    expect(rows.find((r) => r.id === 'acc_too_recent')?.byokCiphertext).not.toBeNull();

    // Self-limiting: a second sweep with the SAME cutoff finds nothing left
    // to purge — acc_eligible dropped out once its ciphertext was cleared.
    const res2 = await svc.tickOnce(now);
    expect(res2.purged).toBe(0);
  });
});

// L4b Step 4 — recycle-bin retention purge sweeper.

import { describe, expect, it, vi } from 'vitest';
import type { ProfilesRepo } from '../../src/services/profiles.js';
import {
  ProfileTrashPurgeSweeperService,
  registerProfileTrashPurgeJob,
  nextPurgeRunAt,
  PROFILE_TRASH_PURGE_JOB_TYPE,
} from '../../src/services/profile-trash-purge-sweeper.js';
import { profileSealedBlobKey, type R2 } from '../../src/lib/r2.js';
import { InMemoryProfilesRepo } from '../integration/_helpers/in-memory-profiles-repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Minimal repo stub that records the cutoff tickOnce passes to purgeTrashedBefore.
function stubRepo(ids: string[] = ['p1', 'p2', 'p3']): { repo: ProfilesRepo; cutoffs: Date[] } {
  const cutoffs: Date[] = [];
  const repo = {
    purgeTrashedBefore: (cutoff: Date) => {
      cutoffs.push(cutoff);
      return Promise.resolve(ids);
    },
  } as unknown as ProfilesRepo;
  return { repo, cutoffs };
}

// Minimal R2 stub recording the keys deleted; `failOn` rejects for one key so we
// can assert the per-blob error is tolerated (logged, not thrown).
function stubR2(opts: { failOn?: string } = {}): { r2: R2; deleted: string[] } {
  const deleted: string[] = [];
  const r2 = {
    deleteObject: (key: string) => {
      if (opts.failOn !== undefined && key === opts.failOn) {
        return Promise.reject(new Error('r2 down'));
      }
      deleted.push(key);
      return Promise.resolve();
    },
  } as unknown as R2;
  return { r2, deleted };
}

describe('ProfileTrashPurgeSweeperService.tickOnce', () => {
  it('purges with a cutoff = now − retention (default 30 days) and returns the count', async () => {
    const { repo, cutoffs } = stubRepo();
    const svc = new ProfileTrashPurgeSweeperService({ repo });
    const now = new Date('2026-06-16T12:00:00.000Z');
    const res = await svc.tickOnce(now);
    expect(res.purged).toBe(3);
    expect(cutoffs).toHaveLength(1);
    expect(cutoffs[0]!.getTime()).toBe(now.getTime() - 30 * DAY_MS);
  });

  it('FIX 2 — deletes each purged profile sealed blob from R2 when wired', async () => {
    const { repo } = stubRepo(['pa', 'pb']);
    const { r2, deleted } = stubR2();
    const svc = new ProfileTrashPurgeSweeperService({ repo, r2 });
    const res = await svc.tickOnce(new Date('2026-06-16T12:00:00.000Z'));
    expect(res.purged).toBe(2);
    expect(res.blobsDeleted).toBe(2);
    expect(deleted).toEqual([profileSealedBlobKey('pa'), profileSealedBlobKey('pb')]);
  });

  it('FIX 2 — tolerates a per-blob R2 delete failure (logs, never throws; row already gone)', async () => {
    const { repo } = stubRepo(['pa', 'pb']);
    const { r2, deleted } = stubR2({ failOn: profileSealedBlobKey('pa') });
    const errors: unknown[] = [];
    const logger = { error: (o: unknown) => errors.push(o) } as never;
    const svc = new ProfileTrashPurgeSweeperService({ repo, r2, logger });
    const res = await svc.tickOnce(new Date('2026-06-16T12:00:00.000Z'));
    // The DB purge count is unaffected; only the surviving blob delete counts.
    expect(res.purged).toBe(2);
    expect(res.blobsDeleted).toBe(1);
    expect(deleted).toEqual([profileSealedBlobKey('pb')]);
    expect(errors).toHaveLength(1);
  });

  it('FIX 2 — DB-only purge (no R2 wired) deletes nothing + reports blobsDeleted 0', async () => {
    const { repo } = stubRepo(['pa', 'pb']);
    const svc = new ProfileTrashPurgeSweeperService({ repo });
    const res = await svc.tickOnce(new Date('2026-06-16T12:00:00.000Z'));
    expect(res.purged).toBe(2);
    expect(res.blobsDeleted).toBe(0);
  });

  it('honors a custom retentionDays', async () => {
    const { repo, cutoffs } = stubRepo();
    const svc = new ProfileTrashPurgeSweeperService({ repo, retentionDays: 7 });
    const now = new Date('2026-06-16T12:00:00.000Z');
    await svc.tickOnce(now);
    expect(cutoffs[0]!.getTime()).toBe(now.getTime() - 7 * DAY_MS);
  });
});

describe('nextPurgeRunAt', () => {
  it('returns 04:00 UTC later today when now is before 04:00', () => {
    const next = nextPurgeRunAt(new Date('2026-06-16T01:00:00.000Z'));
    expect(next.toISOString()).toBe('2026-06-16T04:00:00.000Z');
  });

  it('rolls to tomorrow 04:00 UTC when now is at/after 04:00', () => {
    const next = nextPurgeRunAt(new Date('2026-06-16T04:00:00.000Z'));
    expect(next.toISOString()).toBe('2026-06-17T04:00:00.000Z');
    const next2 = nextPurgeRunAt(new Date('2026-06-16T09:30:00.000Z'));
    expect(next2.toISOString()).toBe('2026-06-17T04:00:00.000Z');
  });
});

describe('job type', () => {
  it('is the stable profile_trash.purge identifier', () => {
    expect(PROFILE_TRASH_PURGE_JOB_TYPE).toBe('profile_trash.purge');
  });
});

describe('profile-trash purge scheduling (chain survival)', () => {
  const NOW = new Date('2026-06-16T02:00:00.000Z');

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

  function silentLogger() {
    return { info: () => {}, error: () => {} } as never;
  }

  it('the re-arm survives a tickOnce failure (chain never dies) and does not fan out', async () => {
    const f = fakeScheduledJobs();
    // A tick that always throws (e.g. the DB purge query fails) must not stop the
    // self-re-arming chain: the handler swallows + re-arms exactly once. If it
    // re-threw, the poller would retry to maxAttempts then markFailed with no
    // pending purge — the chain would die and no trashed profile would ever be
    // hard-deleted again.
    // Captured mock (read off the variable, not the object → no-unbound-method).
    const tickOnce = vi.fn().mockRejectedValue(new Error('db down'));
    const sweeper = { tickOnce } as unknown as ProfileTrashPurgeSweeperService;

    registerProfileTrashPurgeJob({
      scheduledJobs: f.scheduledJobs as never,
      sweeper,
      logger: silentLogger(),
      nowFn: () => NOW.getTime(),
    });

    // The handler must resolve (not reject) despite the failing tick.
    await expect(f.invoke()).resolves.toBeUndefined();
    // Exactly one re-arm enqueued → chain alive, no duplicate parallel chains.
    expect(f.enqueues).toHaveLength(1);
    expect(f.enqueues[0]).toMatchObject({
      jobType: PROFILE_TRASH_PURGE_JOB_TYPE,
      dedup: false,
    });
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
});

describe('purgeTrashedBefore data correctness (in-memory repo)', () => {
  const NEW = (name: string) => ({
    accountId: 'acc_1',
    name,
    archetype: 'iphone17_ios18_7_safari26_4',
    description: null,
  });

  it('NEVER purges a live profile; purges a trashed one only when its deletedAt < cutoff', async () => {
    const repo = new InMemoryProfilesRepo();
    const live = await repo.insert(NEW('keep-me'));
    const doomed = await repo.insert(NEW('trash-me'));
    await repo.delete({ id: doomed.id, accountId: 'acc_1' }); // soft delete → deletedAt = now

    // Cutoff in the PAST → the just-trashed row isn't old enough → nothing purged.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    expect(await repo.purgeTrashedBefore(past)).toEqual([]);
    // Both rows still resolvable (live via findById; trashed via listTrashed).
    expect(await repo.findById({ id: live.id, accountId: 'acc_1' })).not.toBeNull();
    expect((await repo.listTrashed({ accountId: 'acc_1' })).map((p) => p.id)).toEqual([doomed.id]);

    // Cutoff in the FUTURE → the trashed row is "older than cutoff" → purged.
    // Returns the purged id so the caller can delete its orphaned R2 blob.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(await repo.purgeTrashedBefore(future)).toEqual([doomed.id]);
    // Trash is now empty; the LIVE profile is untouched (the key safety invariant).
    expect(await repo.listTrashed({ accountId: 'acc_1' })).toHaveLength(0);
    expect(await repo.findById({ id: live.id, accountId: 'acc_1' })).not.toBeNull();
  });
});

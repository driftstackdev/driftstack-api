// L4b Step 4 — recycle-bin retention purge sweeper.

import { describe, expect, it } from 'vitest';
import type { ProfilesRepo } from '../../src/services/profiles.js';
import {
  ProfileTrashPurgeSweeperService,
  nextPurgeRunAt,
  PROFILE_TRASH_PURGE_JOB_TYPE,
} from '../../src/services/profile-trash-purge-sweeper.js';
import { InMemoryProfilesRepo } from '../integration/_helpers/in-memory-profiles-repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Minimal repo stub that records the cutoff tickOnce passes to purgeTrashedBefore.
function stubRepo(): { repo: ProfilesRepo; cutoffs: Date[] } {
  const cutoffs: Date[] = [];
  const repo = {
    purgeTrashedBefore: (cutoff: Date) => {
      cutoffs.push(cutoff);
      return Promise.resolve(3);
    },
  } as unknown as ProfilesRepo;
  return { repo, cutoffs };
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
    expect(await repo.purgeTrashedBefore(past)).toBe(0);
    // Both rows still resolvable (live via findById; trashed via listTrashed).
    expect(await repo.findById({ id: live.id, accountId: 'acc_1' })).not.toBeNull();
    expect((await repo.listTrashed({ accountId: 'acc_1' })).map((p) => p.id)).toEqual([doomed.id]);

    // Cutoff in the FUTURE → the trashed row is "older than cutoff" → purged.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(await repo.purgeTrashedBefore(future)).toBe(1);
    // Trash is now empty; the LIVE profile is untouched (the key safety invariant).
    expect(await repo.listTrashed({ accountId: 'acc_1' })).toHaveLength(0);
    expect(await repo.findById({ id: live.id, accountId: 'acc_1' })).not.toBeNull();
  });
});

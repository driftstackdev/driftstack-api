// A sealed profile blob that no profile owns is swept by the daily purge.
//
// #158 — the GDPR-erasure backstop for sealed profile blobs. A purge hard-deletes
// a profile row and best-effort deletes `profiles/<uuid>.sealed`, but a
// just-closed session's presigned save-back PUT can land AFTER the purge and
// re-create the object with no row behind it. Nothing selects that object
// through a row, so a pass lists the private bucket and deletes each sealed blob
// older than a grace window whose uuid has no profiles row at all.
//
// That pass used to be an in-process six-hour setTimeout chain armed at boot,
// first tick six hours after boot. Production deploys several times a day, so
// the process rarely lived six hours and the pass may never have run. It is now
// the `profile_blob_orphans` arm of the daily account-deletion purge, which is
// scheduled in the database and survives restarts — exactly the move made for
// the avatar orphan reaper (an-avatar-image-no-account-points-at-...).
//
// Its safety rules carry over unchanged, and every one of them is an arm here:
//   • only a key of exactly `profiles/<uuid>.sealed` is considered;
//   • only an object OLDER than the grace window (6h, which must exceed the
//     longest save-back PUT a session is given) is a candidate; a null
//     lastModified is treated as young;
//   • the existence check includes TRASHED profiles: a trashed profile owns its
//     blob until the retention purge;
//   • one failed delete never stops the pass; a refused listing deletes nothing.
//
// The existence query itself runs against Postgres in
// tests/integration/db-a-profile-blob-no-profile-owns-is-swept-by-the-daily-purge.test.ts.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AccountDeletionPurgeSweeperService,
  registerAccountDeletionPurgeJob,
  ACCOUNT_DELETION_PURGE_JOB_TYPE,
} from '../../src/services/account-deletion-purge-sweeper.js';
import * as reaperModule from '../../src/services/profile-blob-orphan-reaper.js';
import {
  PROFILE_BLOB_ORPHAN_GRACE_MS,
  PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN,
  ProfileBlobOrphanReaper,
  type ProfileBlobOrphanExistenceRepo,
} from '../../src/services/profile-blob-orphan-reaper.js';
import { profileSealedBlobKey, type R2 } from '../../src/lib/r2.js';
import { PROFILE_SAVE_BACK_PUT_TTL_SECONDS } from '../../src/routes/agent-sessions.js';
import type { Logger } from '../../src/lib/logger.js';
import type { ScheduledJobRow } from '../../src/services/scheduled-jobs.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-07-10T05:00:00.000Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * HOUR_MS);

const U_ORPHAN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const U_LIVE = '11111111-2222-4333-8444-555555555555';
const U_TRASHED = '99999999-8888-4777-8666-555555555555';
const U_YOUNG = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';
const U_NO_TIMESTAMP = '77777777-7777-4777-8777-777777777777';

const DASHES_36 = '------------------------------------';
const HEX_36_NO_DASHES = '0123456789abcdef0123456789abcdef0123';

interface Obj {
  key: string;
  lastModified: Date | null;
}
const blob = (uuid: string, ageHours: number): Obj => ({
  key: profileSealedBlobKey(uuid),
  lastModified: hoursAgo(ageHours),
});

/** The private bucket: lists what it holds, and a delete removes the object. */
function bucket(objs: Obj[], opts: { failDeleteOf?: string; failList?: boolean } = {}) {
  const objects = new Map(objs.map((o) => [o.key, o.lastModified]));
  const deleted: string[] = [];
  const prefixes: string[] = [];
  const r2 = {
    bucket: 'private',
    listObjects: (prefix: string) => {
      prefixes.push(prefix);
      if (opts.failList) {
        return Promise.reject(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }));
      }
      return Promise.resolve(
        [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, lastModified]) => ({ key, lastModified })),
      );
    },
    deleteObject: (key: string) => {
      if (key === opts.failDeleteOf) return Promise.reject(new Error('r2 delete down'));
      deleted.push(key);
      objects.delete(key);
      return Promise.resolve();
    },
  } as unknown as R2;
  return { r2, objects, deleted, prefixes };
}

/** `existing` = uuids with a profiles row, trashed ones included, as the real query returns. */
function profiles(existing: string[]) {
  const set = new Set(existing);
  const asked: string[][] = [];
  const repo: ProfileBlobOrphanExistenceRepo = {
    findExistingProfileIds: (ids) => {
      asked.push([...ids]);
      return Promise.resolve(new Set(ids.filter((id) => set.has(id))));
    },
  };
  return { repo, asked };
}

describe('which sealed blobs the reaper deletes', () => {
  it('CRITICAL deletes an old blob with NO profile row (the late save-back after a purge)', async () => {
    const store = bucket([blob(U_ORPHAN, 7)]);
    const { repo, asked } = profiles([]);
    const result = await new ProfileBlobOrphanReaper(store.r2, repo).reapOrphanedProfileBlobs(NOW);
    expect(result).toEqual({ scanned: 1, reaped: 1, failed: 0, capped: false });
    expect(store.deleted).toEqual([profileSealedBlobKey(U_ORPHAN)]);
    expect(asked).toEqual([[U_ORPHAN]]);
    expect(store.prefixes, 'lists the sealed-profile prefix only').toEqual(['profiles/']);
  });

  it('CRITICAL keeps a blob whose profile row exists, live OR trashed — a trashed profile owns its blob until the retention purge', async () => {
    const store = bucket([blob(U_LIVE, 48), blob(U_TRASHED, 480)]);
    const result = await new ProfileBlobOrphanReaper(
      store.r2,
      profiles([U_LIVE, U_TRASHED]).repo,
    ).reapOrphanedProfileBlobs(NOW);
    expect(store.deleted).toEqual([]);
    expect(result.reaped).toBe(0);
  });

  it('CRITICAL keeps a blob younger than the grace window even with no row, and never asks about it', async () => {
    const store = bucket([blob(U_YOUNG, 5.9)]);
    const { repo, asked } = profiles([]);
    await new ProfileBlobOrphanReaper(store.r2, repo).reapOrphanedProfileBlobs(NOW);
    expect(store.deleted).toEqual([]);
    expect(asked, 'too-young objects are filtered before the existence check').toEqual([]);
  });

  it('CRITICAL a null lastModified is treated as young: never deleted', async () => {
    const store = bucket([{ key: profileSealedBlobKey(U_NO_TIMESTAMP), lastModified: null }]);
    const { repo, asked } = profiles([]);
    await new ProfileBlobOrphanReaper(store.r2, repo).reapOrphanedProfileBlobs(NOW);
    expect(store.deleted).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('CRITICAL the grace is 6h and exceeds the longest save-back PUT a session is given, read from the constant the mint site uses — or an in-flight save-back is deleted mid-flight', () => {
    expect(PROFILE_BLOB_ORPHAN_GRACE_MS).toBe(6 * HOUR_MS);
    expect(PROFILE_BLOB_ORPHAN_GRACE_MS).toBeGreaterThan(PROFILE_SAVE_BACK_PUT_TTL_SECONDS * 1000);
  });

  it('a blob just past a custom grace is a candidate', async () => {
    const store = bucket([blob(U_ORPHAN, 1.5)]);
    const result = await new ProfileBlobOrphanReaper(store.r2, profiles([]).repo, {
      graceMs: HOUR_MS,
    }).reapOrphanedProfileBlobs(NOW);
    expect(result.reaped).toBe(1);
  });

  it('CRITICAL a key that is not exactly profiles/<uuid>.sealed is never touched, and never reaches the uuid-typed existence query (V-2007: one malformed id would fail every pass)', async () => {
    const strangers = [
      'profiles/not-a-uuid.sealed',
      `profiles/${DASHES_36}.sealed`,
      `profiles/${HEX_36_NO_DASHES}.sealed`,
      'profiles/index.json',
      `profiles/${U_ORPHAN}.sealed.bak`,
      `profiles/nested/${U_ORPHAN}.sealed`,
      'profiles/garbage',
    ];
    // The two 36-character fixtures are the only ones that reach the shape check.
    expect(DASHES_36.length).toBe(36);
    expect(HEX_36_NO_DASHES.length).toBe(36);
    const store = bucket(strangers.map((key) => ({ key, lastModified: hoursAgo(48) })));
    const { repo, asked } = profiles([]);
    const result = await new ProfileBlobOrphanReaper(store.r2, repo).reapOrphanedProfileBlobs(NOW);
    expect(store.deleted).toEqual([]);
    expect(asked).toEqual([]);
    expect(result).toEqual({ scanned: strangers.length, reaped: 0, failed: 0, capped: false });
  });

  it('one failed delete does not stop the pass; it is counted and the object stays for the next one', async () => {
    const other = '00000000-1111-4222-8333-444444444444';
    const store = bucket([blob(U_ORPHAN, 7), blob(other, 8)], {
      failDeleteOf: profileSealedBlobKey(U_ORPHAN),
    });
    const result = await new ProfileBlobOrphanReaper(
      store.r2,
      profiles([]).repo,
    ).reapOrphanedProfileBlobs(NOW);
    expect(result).toEqual({ scanned: 2, reaped: 1, failed: 1, capped: false });
    expect([...store.objects.keys()]).toEqual([profileSealedBlobKey(U_ORPHAN)]);
  });

  it('CRITICAL a listing the bucket refuses (a token without list permission) rejects, deleting nothing, so the purge reports it instead of a clean pass', async () => {
    const store = bucket([], { failList: true });
    const { repo, asked } = profiles([]);
    await expect(
      new ProfileBlobOrphanReaper(store.r2, repo).reapOrphanedProfileBlobs(NOW),
    ).rejects.toThrow(/Access Denied/);
    expect(store.deleted).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('mixed pass: deletes only the old orphan among live / trashed / young / not-a-sealed-key', async () => {
    const store = bucket([
      blob(U_ORPHAN, 7),
      blob(U_LIVE, 7),
      blob(U_TRASHED, 7),
      blob(U_YOUNG, 1),
      { key: 'profiles/garbage', lastModified: hoursAgo(7) },
    ]);
    const result = await new ProfileBlobOrphanReaper(
      store.r2,
      profiles([U_LIVE, U_TRASHED]).repo,
    ).reapOrphanedProfileBlobs(NOW);
    expect(result).toEqual({ scanned: 5, reaped: 1, failed: 0, capped: false });
    expect(store.deleted).toEqual([profileSealedBlobKey(U_ORPHAN)]);
  });
});

describe('the work one pass does is bounded', () => {
  const uuid = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

  it('the existence lookup is batched, so a large bucket never becomes one unbounded IN list', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => uuid(i));
    const store = bucket(ids.map((id) => blob(id, 24)));
    const { repo, asked } = profiles(ids); // every blob owned: nothing to delete, all checked
    await new ProfileBlobOrphanReaper(store.r2, repo).reapOrphanedProfileBlobs(NOW);
    expect(asked.map((b) => b.length)).toEqual([500, 500, 201]);
  });

  it(`CRITICAL at most ${String(PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN)} deletes per pass, oldest first; the rest wait for the next pass`, async () => {
    const extra = 7;
    const n = PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN + extra;
    // Blob i is (24 + i) hours old: the highest index is the oldest.
    const ids = Array.from({ length: n }, (_, i) => uuid(i));
    const store = bucket(ids.map((id, i) => blob(id, 24 + i)));
    const reaper = new ProfileBlobOrphanReaper(store.r2, profiles([]).repo);

    const first = await reaper.reapOrphanedProfileBlobs(NOW);
    expect(first).toMatchObject({ reaped: PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN, capped: true });
    expect([...store.objects.keys()].sort(), 'the youngest are the ones left').toEqual(
      ids
        .slice(0, extra)
        .map((id) => profileSealedBlobKey(id))
        .sort(),
    );

    const second = await reaper.reapOrphanedProfileBlobs(NOW);
    expect(second).toMatchObject({ reaped: extra, capped: false });
    expect(store.objects.size).toBe(0);
  });

  it('a pass that finds its orphans early stops asking once it has found one it must leave: the batch after the cap is asked, the rest never are', async () => {
    const n = PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN + 600;
    const ids = Array.from({ length: n }, (_, i) => uuid(i));
    const store = bucket(ids.map((id, i) => blob(id, 24 + n - i)));
    const { repo, asked } = profiles([]);
    const result = await new ProfileBlobOrphanReaper(store.r2, repo).reapOrphanedProfileBlobs(NOW);
    expect(asked.map((b) => b.length)).toEqual([500, 500]);
    expect(result).toMatchObject({ reaped: PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN, capped: true });
  });

  // The cap is checked before EACH delete, not once per existence batch. With
  // the batch-level check alone, a batch holding fewer orphans than the cap is
  // deleted whole and the next batch starts under the cap, so a pass could
  // delete far more than the cap (250 orphans in one batch and 500 in the next
  // is 750 deletes against a cap of 500). Here one batch holds five orphans
  // among owned blobs and the cap is three.
  it('CRITICAL the cap holds inside one existence batch: five orphans among owned blobs, a cap of three, exactly the three oldest orphans go', async () => {
    const orphans = [0, 1, 2, 3, 4].map((i) => uuid(100 + i));
    const owned = [0, 1, 2, 3, 4, 5].map((i) => uuid(200 + i));
    // Interleaved by age, oldest first: owned, orphan, owned, orphan, ...
    const objs = [
      blob(owned[0]!, 90),
      blob(orphans[0]!, 80),
      blob(owned[1]!, 70),
      blob(orphans[1]!, 60),
      blob(owned[2]!, 50),
      blob(orphans[2]!, 40),
      blob(owned[3]!, 35),
      blob(orphans[3]!, 30),
      blob(owned[4]!, 28),
      blob(orphans[4]!, 26),
      blob(owned[5]!, 25),
    ];
    const store = bucket(objs);
    const { repo, asked } = profiles(owned);
    const result = await new ProfileBlobOrphanReaper(store.r2, repo, {
      maxDeletesPerRun: 3,
    }).reapOrphanedProfileBlobs(NOW);
    expect(asked, 'one existence batch').toHaveLength(1);
    expect(store.deleted).toEqual(orphans.slice(0, 3).map((u) => profileSealedBlobKey(u)));
    expect(result).toEqual({ scanned: objs.length, reaped: 3, failed: 0, capped: true });
  });

  it('a failed delete counts against the cap, so a pass whose deletes fail still stops at the cap', async () => {
    const orphans = [0, 1, 2, 3].map((i) => uuid(300 + i));
    const store = bucket(
      orphans.map((u, i) => blob(u, 40 - i)),
      { failDeleteOf: profileSealedBlobKey(orphans[0]!) },
    );
    const result = await new ProfileBlobOrphanReaper(store.r2, profiles([]).repo, {
      maxDeletesPerRun: 2,
    }).reapOrphanedProfileBlobs(NOW);
    expect(result).toEqual({ scanned: 4, reaped: 1, failed: 1, capped: true });
    expect(store.deleted).toEqual([profileSealedBlobKey(orphans[1]!)]);
  });

  // `capped` tells the purge log that orphans are waiting for the next day. It
  // must mean that: an orphan was found and left. Reaching the cap exactly, with
  // every remaining blob owned, leaves nothing behind.
  it('capped is true only when an orphan was left behind: exactly the cap in orphans, then only owned blobs, is not capped', async () => {
    const orphans = [0, 1, 2].map((i) => uuid(400 + i));
    const owned = [0, 1, 2, 3].map((i) => uuid(500 + i));
    const store = bucket([
      ...orphans.map((u, i) => blob(u, 90 - i)),
      ...owned.map((u, i) => blob(u, 50 - i)),
    ]);
    const result = await new ProfileBlobOrphanReaper(store.r2, profiles(owned).repo, {
      maxDeletesPerRun: 3,
    }).reapOrphanedProfileBlobs(NOW);
    expect(result).toEqual({ scanned: 7, reaped: 3, failed: 0, capped: false });
  });

  it('capped across an existence batch boundary: the cap reached at the end of one batch is capped only if a LATER batch holds an orphan', async () => {
    const cap = PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN;
    // The first batch is exactly `cap` orphans; the second is owned blobs only.
    const orphans = Array.from({ length: cap }, (_, i) => uuid(i));
    const owned = Array.from({ length: 300 }, (_, i) => uuid(10_000 + i));
    const objs = [
      ...orphans.map((u, i) => blob(u, 5000 - i)),
      ...owned.map((u, i) => blob(u, 1000 - i)),
    ];
    const clean = await new ProfileBlobOrphanReaper(
      bucket(objs).r2,
      profiles(owned).repo,
    ).reapOrphanedProfileBlobs(NOW);
    expect(clean).toMatchObject({ reaped: cap, capped: false });

    // One more orphan, younger than every owned blob, sits in the second batch.
    const late = uuid(20_000);
    const store = bucket([...objs, blob(late, 24)]);
    const left = await new ProfileBlobOrphanReaper(
      store.r2,
      profiles(owned).repo,
    ).reapOrphanedProfileBlobs(NOW);
    expect(left).toMatchObject({ reaped: cap, capped: true });
    expect(store.objects.has(profileSealedBlobKey(late)), 'the late orphan waits').toBe(true);
  });
});

describe('what the code around the reaper says about it', () => {
  // The reaper used to be an in-process timer that caught and logged every
  // failure and never threw. It now rejects on a refused listing or a failed
  // existence query, and the purge arm reports `failed`. Three comments that
  // explain other code by pointing at the reaper still described the old
  // contract; a reader relying on them would expect a failure to disappear into
  // a log line.
  it('no source still says the reaper is wrapped to never throw, or that it no-ops a failed pass', () => {
    const STALE = /wrapped (?:so it |to )?never throws?|no-op the pass/i;
    for (const p of [
      'apps/server/src/lib/r2.ts',
      'apps/server/src/db/chunk-ids.ts',
      'apps/server/src/db/profiles-repo.ts',
      'apps/server/tests/integration/id-bind-ceiling-holds-across-repos.test.ts',
    ]) {
      const text = readFileSync(resolve(REPO_ROOT, p), 'utf8').replace(
        /\s*\n\s*(?:\/\/|\*)?\s*/g,
        ' ',
      );
      expect(text, p).not.toMatch(STALE);
    }
    const r2 = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/r2.ts'), 'utf8').replace(
      /\s*\n\s*(?:\/\/|\*)?\s*/g,
      ' ',
    );
    expect(r2).toMatch(/the purge reports the arm as failed/);
  });
});

describe('the reaper runs as the profile_blob_orphans arm of the daily purge', () => {
  const noByokRepo = { findDeletedAccountIdsWithByokKeyBefore: () => Promise.resolve([]) };

  function metrics(): MetricsRegistry {
    const m = new MetricsRegistry();
    m.registerCounter(METRIC_NAMES.retentionPurgeTotal, 'test', ['arm', 'outcome']);
    return m;
  }
  const samples = (m: MetricsRegistry): string[] =>
    m
      .render()
      .split('\n')
      .filter(
        (l) =>
          l.startsWith(METRIC_NAMES.retentionPurgeTotal) &&
          l.includes('arm="profile_blob_orphans"'),
      )
      .map((l) => `${/outcome="([^"]+)"/.exec(l)?.[1]}=${l.trim().split(/\s+/).pop()}`)
      .sort();

  /** The purge's registered job, driven the way the scheduler drives it. */
  function scheduled(sweeper: AccountDeletionPurgeSweeperService, logger: Logger) {
    const enqueued: Date[] = [];
    let handler: ((job: ScheduledJobRow) => Promise<void>) | null = null;
    registerAccountDeletionPurgeJob({
      scheduledJobs: {
        register: (type: string, h: (job: ScheduledJobRow) => Promise<void>) => {
          expect(type).toBe(ACCOUNT_DELETION_PURGE_JOB_TYPE);
          handler = h;
        },
        enqueue: (args: { runAt: Date }) => {
          enqueued.push(args.runAt);
          return Promise.resolve({ enqueued: true });
        },
      } as never,
      sweeper,
      logger,
      nowFn: () => NOW.getTime(),
    });
    return {
      enqueued,
      run: () =>
        handler!({
          id: 'job',
          jobType: ACCOUNT_DELETION_PURGE_JOB_TYPE,
          accountId: null,
          payload: {},
          runAt: NOW,
          attempts: 1,
          maxAttempts: 3,
        }),
    };
  }
  const quiet = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

  it('CRITICAL the daily purge job runs the arm: the orphan past its grace goes; a live profile’s blob, a trashed one’s, and one inside the grace stay; and a second run is a no-op', async () => {
    const store = bucket([
      blob(U_ORPHAN, 30),
      blob(U_LIVE, 30),
      blob(U_TRASHED, 30),
      blob(U_YOUNG, 2),
    ]);
    const m = metrics();
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      profileBlobOrphans: new ProfileBlobOrphanReaper(store.r2, profiles([U_LIVE, U_TRASHED]).repo),
      metrics: m,
    });
    const job = scheduled(sweeper, quiet);

    await job.run();
    expect(store.deleted).toEqual([profileSealedBlobKey(U_ORPHAN)]);
    expect([...store.objects.keys()].sort()).toEqual(
      [U_LIVE, U_TRASHED, U_YOUNG].map((u) => profileSealedBlobKey(u)).sort(),
    );
    expect(samples(m)).toEqual(['purged=1']);
    expect(job.enqueued, 'the daily chain re-arms').toHaveLength(1);

    await job.run();
    expect(store.deleted, 'the second run deletes nothing more').toEqual([
      profileSealedBlobKey(U_ORPHAN),
    ]);
    await expect(sweeper.tickOnce(NOW)).resolves.toMatchObject({ profileBlobOrphansReaped: 0 });
  });

  it('CRITICAL a refused listing is contained: the arm reports failed, says which permission it needs, deletes nothing, and the rest of the purge still runs', async () => {
    const m = metrics();
    const errors: Array<[Record<string, unknown>, string]> = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: (o: Record<string, unknown>, msg: string) => errors.push([o, msg]),
    } as unknown as Logger;
    const store = bucket([blob(U_ORPHAN, 30)], { failList: true });
    let byokRan = false;
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: {
        findDeletedAccountIdsWithByokKeyBefore: () => {
          byokRan = true;
          return Promise.resolve([]);
        },
      },
      byok: { clearKey: () => Promise.resolve() } as never,
      profileBlobOrphans: new ProfileBlobOrphanReaper(store.r2, profiles([]).repo),
      metrics: m,
      logger,
    });
    await expect(sweeper.tickOnce(NOW)).resolves.toMatchObject({ profileBlobOrphansReaped: 0 });
    expect(byokRan).toBe(true);
    expect(store.deleted).toEqual([]);
    expect(samples(m)).toEqual(['failed=1']);
    expect(errors.map(([, msg]) => msg).join('\n')).toMatch(/list permission/);
  });

  it('a pass with a failed delete reports failed, not a clean purge', async () => {
    const m = metrics();
    const store = bucket([blob(U_ORPHAN, 30)], { failDeleteOf: profileSealedBlobKey(U_ORPHAN) });
    await new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      profileBlobOrphans: new ProfileBlobOrphanReaper(store.r2, profiles([]).repo),
      metrics: m,
    }).tickOnce(NOW);
    expect(samples(m)).toEqual(['failed=1']);
  });

  it('unwired (no private bucket, so no sealed blobs) reports skipped rather than claiming a pass', async () => {
    const m = metrics();
    const result = await new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      metrics: m,
    }).tickOnce(NOW);
    expect(result.profileBlobOrphansReaped).toBe(0);
    expect(samples(m)).toEqual(['skipped=1']);
  });

  it('CRITICAL production wires it: bootstrap builds the reaper on the private bucket with the profiles repo and hands it to the daily purge', () => {
    const boot = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'), 'utf8');
    expect(boot).toMatch(/new ProfileBlobOrphanReaper\(\s*r2,\s*profilesRepo\s*\)/);
    const sweeperCall = boot.slice(boot.indexOf('new AccountDeletionPurgeSweeperService('));
    expect(sweeperCall.slice(0, sweeperCall.indexOf('});'))).toMatch(/\bprofileBlobOrphans\b/);
  });
});

describe('the in-process timer is gone', () => {
  it('CRITICAL nothing arms a timer for it any more: the reaper has no start/stop or interval, and its source schedules nothing', () => {
    expect(Object.keys(reaperModule).sort()).toEqual([
      'PROFILE_BLOB_ORPHAN_GRACE_MS',
      'PROFILE_BLOB_ORPHAN_MAX_DELETES_PER_RUN',
      'ProfileBlobOrphanReaper',
    ]);
    const proto = ProfileBlobOrphanReaper.prototype as unknown as Record<string, unknown>;
    expect(proto.start).toBeUndefined();
    expect(proto.stop).toBeUndefined();
    const code = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/profile-blob-orphan-reaper.ts'),
      'utf8',
    )
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/\bset(Timeout|Interval)\b/);
  });

  it('CRITICAL server source no longer constructs or starts the in-process sweeper', () => {
    const boot = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'), 'utf8');
    expect(boot).not.toMatch(/ProfileBlobOrphanSweeperService/);
    expect(boot).not.toMatch(/profileBlobOrphanSweeper\.start\(\)/);
  });
});

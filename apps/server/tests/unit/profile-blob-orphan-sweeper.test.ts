// #158 — R2 orphaned profile sealed-blob reaper (GDPR erasure backstop) unit tests.

import { describe, expect, it, vi } from 'vitest';
import type { R2 } from '../../src/lib/r2.js';
import { profileSealedBlobKey } from '../../src/lib/r2.js';
import {
  ProfileBlobOrphanSweeperService,
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
  type ProfileBlobOrphanExistenceRepo,
} from '../../src/services/profile-blob-orphan-sweeper.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-07-10T12:00:00.000Z').getTime();

// A valid 36-char uuid so it matches the ^profiles/<uuid>.sealed$ pattern.
const U_ORPHAN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const U_LIVE = '11111111-2222-3333-4444-555555555555';
const U_TRASHED = '99999999-8888-7777-6666-555555555555';
const U_YOUNG = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';

type Obj = { key: string; lastModified: Date | null };

// Fake R2: stub listObjects (or make it throw) + record deleteObject keys.
function fakeR2(opts: { objects?: Obj[]; listThrows?: Error; deleteFailOn?: string }): {
  r2: R2;
  deleted: string[];
} {
  const deleted: string[] = [];
  const r2 = {
    listObjects: (_prefix: string) => {
      if (opts.listThrows !== undefined) return Promise.reject(opts.listThrows);
      return Promise.resolve(opts.objects ?? []);
    },
    deleteObject: (key: string) => {
      if (opts.deleteFailOn !== undefined && key === opts.deleteFailOn) {
        return Promise.reject(new Error('r2 delete down'));
      }
      deleted.push(key);
      return Promise.resolve();
    },
  } as unknown as R2;
  return { r2, deleted };
}

// Fake profiles repo: `existing` = uuids that still have a DB row (trashed-inclusive).
function fakeProfiles(existing: string[]): {
  profiles: ProfileBlobOrphanExistenceRepo;
  queried: string[][];
} {
  const set = new Set(existing);
  const queried: string[][] = [];
  const profiles: ProfileBlobOrphanExistenceRepo = {
    findExistingProfileIds: (ids: string[]) => {
      queried.push(ids);
      return Promise.resolve(new Set(ids.filter((id) => set.has(id))));
    },
  };
  return { profiles, queried };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

// An object last-modified `hoursAgo` before NOW.
function obj(uuid: string, hoursAgo: number): Obj {
  return { key: profileSealedBlobKey(uuid), lastModified: new Date(NOW - hoursAgo * HOUR_MS) };
}

describe('ProfileBlobOrphanSweeperService.tickOnce', () => {
  it('(a) reaps an old blob with NO profile row (genuine orphan)', async () => {
    const { r2, deleted } = fakeR2({ objects: [obj(U_ORPHAN, 5)] });
    const { profiles, queried } = fakeProfiles([]); // no rows exist
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger: silentLogger,
      nowFn: () => NOW,
    });
    const res = await svc.tickOnce();
    expect(res.scanned).toBe(1);
    expect(res.reaped).toBe(1);
    expect(deleted).toEqual([profileSealedBlobKey(U_ORPHAN)]);
    // The candidate uuid was batched through the existence check.
    expect(queried).toEqual([[U_ORPHAN]]);
  });

  it('(b) does NOT reap a blob whose profile row survives (live or trashed)', async () => {
    const { r2, deleted } = fakeR2({ objects: [obj(U_LIVE, 5), obj(U_TRASHED, 10)] });
    // Both exist in the DB (findExistingProfileIds is trashed-inclusive), so
    // neither may be reaped.
    const { profiles } = fakeProfiles([U_LIVE, U_TRASHED]);
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger: silentLogger,
      nowFn: () => NOW,
    });
    const res = await svc.tickOnce();
    expect(res.scanned).toBe(2);
    expect(res.reaped).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('(c) does NOT reap a blob younger than the grace window (in-flight-create safety)', async () => {
    // 1h old < 2h grace → skipped even though no DB row exists.
    const { r2, deleted } = fakeR2({ objects: [obj(U_YOUNG, 1)] });
    const { profiles, queried } = fakeProfiles([]);
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger: silentLogger,
      nowFn: () => NOW,
    });
    const res = await svc.tickOnce();
    expect(res.scanned).toBe(1);
    expect(res.reaped).toBe(0);
    expect(deleted).toEqual([]);
    // Too-young objects are filtered BEFORE the existence check even runs.
    expect(queried).toEqual([]);
  });

  it('skips an object with a null lastModified (never reaped)', async () => {
    const { r2, deleted } = fakeR2({
      objects: [{ key: profileSealedBlobKey(U_ORPHAN), lastModified: null }],
    });
    const { profiles, queried } = fakeProfiles([]);
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger: silentLogger,
      nowFn: () => NOW,
    });
    const res = await svc.tickOnce();
    expect(res.reaped).toBe(0);
    expect(deleted).toEqual([]);
    expect(queried).toEqual([]);
  });

  it('ignores non-sealed keys + malformed uuids under the prefix', async () => {
    const { r2, deleted } = fakeR2({
      objects: [
        { key: 'profiles/not-a-uuid.sealed', lastModified: new Date(NOW - 5 * HOUR_MS) },
        { key: 'profiles/index.json', lastModified: new Date(NOW - 5 * HOUR_MS) },
        { key: `profiles/${U_ORPHAN}.sealed.bak`, lastModified: new Date(NOW - 5 * HOUR_MS) },
        obj(U_ORPHAN, 5), // the one real orphan
      ],
    });
    const { profiles } = fakeProfiles([]);
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger: silentLogger,
      nowFn: () => NOW,
    });
    const res = await svc.tickOnce();
    expect(res.scanned).toBe(4);
    expect(res.reaped).toBe(1);
    expect(deleted).toEqual([profileSealedBlobKey(U_ORPHAN)]);
  });

  it('(d) listObjects throwing (AccessDenied) → resolves without throwing, logs a warn, no deletes', async () => {
    const accessDenied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    const { r2, deleted } = fakeR2({ listThrows: accessDenied });
    const { profiles, queried } = fakeProfiles([]);
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() } as never;
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger,
      nowFn: () => NOW,
    });
    const res = await svc.tickOnce();
    expect(res).toEqual({ scanned: 0, reaped: 0 });
    expect(deleted).toEqual([]);
    expect(queried).toEqual([]); // never reached the existence check
    expect(warn).toHaveBeenCalledOnce();
    // The warn message names the s3:ListBucket dependency.
    const [, msg] = warn.mock.calls[0]!;
    expect(msg).toMatch(/needs s3:ListBucket/);
  });

  it('(e) a deleteObject failure on one key does not abort the others', async () => {
    const orphanA = U_ORPHAN;
    const orphanB = '00000000-1111-2222-3333-444444444444';
    const { r2, deleted } = fakeR2({
      objects: [obj(orphanA, 5), obj(orphanB, 6)],
      deleteFailOn: profileSealedBlobKey(orphanA),
    });
    const { profiles } = fakeProfiles([]); // both are orphans
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() } as never;
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger,
      nowFn: () => NOW,
    });
    const res = await svc.tickOnce();
    // orphanA's delete failed (logged); orphanB still got reaped.
    expect(res.scanned).toBe(2);
    expect(res.reaped).toBe(1);
    expect(deleted).toEqual([profileSealedBlobKey(orphanB)]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('honors a custom graceMs (a blob just past the custom grace is reaped)', async () => {
    // 90-min-old blob, custom grace = 1h → reap candidate.
    const { r2, deleted } = fakeR2({ objects: [obj(U_ORPHAN, 1.5)] });
    const { profiles } = fakeProfiles([]);
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger: silentLogger,
      graceMs: HOUR_MS,
      nowFn: () => NOW,
    });
    const res = await svc.tickOnce();
    expect(res.reaped).toBe(1);
    expect(deleted).toEqual([profileSealedBlobKey(U_ORPHAN)]);
  });

  it('mixed pass: reaps only the old orphan among live / trashed / young / non-sealed', async () => {
    const { r2, deleted } = fakeR2({
      objects: [
        obj(U_ORPHAN, 5), // old + no row → REAP
        obj(U_LIVE, 5), // old but has a row → keep
        obj(U_TRASHED, 5), // old but trashed row survives → keep
        obj(U_YOUNG, 1), // no row but too young → keep
        { key: 'profiles/garbage', lastModified: new Date(NOW - 5 * HOUR_MS) }, // non-sealed → ignore
      ],
    });
    const { profiles } = fakeProfiles([U_LIVE, U_TRASHED]);
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger: silentLogger,
      nowFn: () => NOW,
    });
    const res = await svc.tickOnce();
    expect(res.scanned).toBe(5);
    expect(res.reaped).toBe(1);
    expect(deleted).toEqual([profileSealedBlobKey(U_ORPHAN)]);
  });
});

describe('ProfileBlobOrphanSweeperService defaults + scheduling', () => {
  it('grace default = 2h, interval default = 6h', () => {
    expect(DEFAULT_ORPHAN_GRACE_MS).toBe(2 * HOUR_MS);
    expect(DEFAULT_ORPHAN_SWEEP_INTERVAL_MS).toBe(6 * HOUR_MS);
  });

  it('grace default (2h) exceeds the max presigned save-back PUT TTL (1h)', () => {
    // The reaper's whole safety hinge: grace MUST exceed the max minted
    // presigned save-back TTL (DEFAULT_PROFILE_URL_TTL_SECONDS = 3600s) so an
    // in-flight first save-back is never reaped mid-flight.
    expect(DEFAULT_ORPHAN_GRACE_MS).toBeGreaterThan(3600 * 1000);
  });

  it('start() arms a self-re-arming chain via the injected timer (re-arms after each tick)', async () => {
    // Deterministic manual timer queue: capture the scheduled callback so we can
    // fire it, then assert start re-arms for the next cycle.
    let scheduled: (() => void) | undefined;
    let armCount = 0;
    const setTimeoutFn = (cb: () => void, _ms: number): ReturnType<typeof setTimeout> => {
      armCount += 1;
      scheduled = cb;
      // Return a handle with an unref() no-op so .unref() is exercised.
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    };

    const { r2 } = fakeR2({ objects: [] });
    const { profiles } = fakeProfiles([]);
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger: silentLogger,
      nowFn: () => NOW,
      setTimeoutFn,
    });

    svc.start();
    expect(armCount).toBe(1); // armed once on start
    // Fire the scheduled tick; it runs tickOnce then re-arms.
    const fire = scheduled!;
    fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(armCount).toBe(2); // re-armed after the tick
    svc.stop();
  });

  it('a tick whose listObjects throws still re-arms the chain (chain survival)', async () => {
    let scheduled: (() => void) | undefined;
    let armCount = 0;
    const setTimeoutFn = (cb: () => void, _ms: number): ReturnType<typeof setTimeout> => {
      armCount += 1;
      scheduled = cb;
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    };

    const { r2 } = fakeR2({ listThrows: new Error('boom') });
    const { profiles } = fakeProfiles([]);
    const svc = new ProfileBlobOrphanSweeperService({
      r2,
      profiles,
      logger: silentLogger,
      nowFn: () => NOW,
      setTimeoutFn,
    });

    svc.start();
    expect(armCount).toBe(1);
    scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    // Even though the tick's list failed, the chain re-armed.
    expect(armCount).toBe(2);
    svc.stop();
  });
});

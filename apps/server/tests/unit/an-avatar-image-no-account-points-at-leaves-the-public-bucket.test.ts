// Security sweep E-23, the data that was already out there.
//
// The route fix deletes an avatar's objects on removal and on replacement, and
// the purge arm deletes a terminated account's avatar. All three act only at the
// moment of a future event, and all three find the object through the account's
// pointer. Every image removed or replaced before that fix therefore stayed on
// the public bucket with nothing pointing at it: the pointer was already NULL,
// or named the newer image, so no later removal, upload or purge would ever
// select it. The same holds for an account that removed its avatar and was
// deleted afterwards, and for a replaced image whose cleanup delete failed.
//
// The reaper lists `avatars/` on the public bucket and deletes each object older
// than a grace window that is not its account's current avatar. It runs as the
// `avatar_orphans` arm of the daily account-deletion purge, which is scheduled
// in the database and so survives the many restarts a day of continuous deploys.
//
// The pointer query itself runs against Postgres in
// tests/integration/db-terminated-account-avatar-purge-query.test.ts.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AccountDeletionPurgeSweeperService } from '../../src/services/account-deletion-purge-sweeper.js';
import {
  AVATAR_ORPHAN_GRACE_MS,
  AvatarOrphanReaper,
  type AvatarPointerRepo,
} from '../../src/services/avatar-orphan-reaper.js';
import { avatarKey, type R2 } from '../../src/lib/r2.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const NOW = new Date('2026-08-01T00:00:00Z');
const OLD = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
const YOUNG = new Date(NOW.getTime() - AVATAR_ORPHAN_GRACE_MS / 2);

const REPLACED = '11111111-1111-4111-8111-111111111111';
const REMOVED = '22222222-2222-4222-8222-222222222222';
const REMOVED_THEN_DELETED = '33333333-3333-4333-8333-333333333333';
const NO_ROW = '44444444-4444-4444-8444-444444444444';
const DELETED_IN_WINDOW = '55555555-5555-4555-8555-555555555555';
const JUST_UPLOADED = '66666666-6666-4666-8666-666666666666';
const NO_TIMESTAMP = '77777777-7777-4777-8777-777777777777';

const png = (id: string) => avatarKey(id, 'image/png');
const jpg = (id: string) => avatarKey(id, 'image/jpeg');
const webp = (id: string) => avatarKey(id, 'image/webp');

interface Obj {
  key: string;
  lastModified: Date | null;
}

function bucket(objs: Obj[], opts: { failDeleteOf?: string; failList?: boolean } = {}) {
  const objects = new Map(objs.map((o) => [o.key, o.lastModified]));
  const deleted: string[] = [];
  const prefixes: string[] = [];
  const r2 = {
    bucket: 'public',
    listObjects: (prefix: string) => {
      prefixes.push(prefix);
      if (opts.failList) return Promise.reject(new Error('AccessDenied'));
      return Promise.resolve(
        [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, lastModified]) => ({ key, lastModified })),
      );
    },
    deleteObject: (key: string) => {
      if (key === opts.failDeleteOf) return Promise.reject(new Error('bucket unavailable'));
      deleted.push(key);
      objects.delete(key);
      return Promise.resolve();
    },
  } as unknown as R2;
  return { r2, objects, deleted, prefixes };
}

/** The accounts table as the reaper sees it: id → current pointer. Absent = no row. */
function pointers(rows: Record<string, string | null>) {
  const asked: string[][] = [];
  const repo: AvatarPointerRepo = {
    findAvatarKeysForAccounts: (ids) => {
      asked.push([...ids]);
      const out = new Map<string, string | null>();
      for (const id of ids) if (id in rows) out.set(id, rows[id] ?? null);
      return Promise.resolve(out);
    },
  };
  return { repo, asked };
}

const TABLE: Record<string, string | null> = {
  [REPLACED]: jpg(REPLACED),
  [REMOVED]: null,
  [REMOVED_THEN_DELETED]: null,
  [DELETED_IN_WINDOW]: png(DELETED_IN_WINDOW),
  [JUST_UPLOADED]: null,
  [NO_TIMESTAMP]: null,
};

describe('an avatar image no account points at leaves the public bucket', () => {
  it('CRITICAL deletes the images left behind before the fix: a removed one, the old format of a replaced one, a removed-then-deleted account’s, and one whose account row is gone', async () => {
    const pub = bucket([
      { key: png(REPLACED), lastModified: OLD },
      { key: jpg(REPLACED), lastModified: OLD },
      { key: webp(REMOVED), lastModified: OLD },
      { key: png(REMOVED_THEN_DELETED), lastModified: OLD },
      { key: png(NO_ROW), lastModified: OLD },
    ]);
    const { repo } = pointers(TABLE);

    const result = await new AvatarOrphanReaper(pub.r2, repo).reapOrphanedAvatars(NOW);

    expect(
      [...pub.objects.keys()],
      'only the current avatar of the replaced account remains',
    ).toEqual([jpg(REPLACED)]);
    expect(result).toEqual({ scanned: 5, reaped: 4, failed: 0 });
    expect(pub.prefixes, 'lists the avatar prefix only').toEqual(['avatars/']);
  });

  it("CRITICAL keeps every image an account still points at, including a deleted account's inside its retention window (the purge arm removes that one on time)", async () => {
    const pub = bucket([
      { key: jpg(REPLACED), lastModified: OLD },
      { key: png(DELETED_IN_WINDOW), lastModified: OLD },
    ]);
    const result = await new AvatarOrphanReaper(pub.r2, pointers(TABLE).repo).reapOrphanedAvatars(
      NOW,
    );
    expect(pub.deleted).toEqual([]);
    expect(result.reaped).toBe(0);
  });

  it('CRITICAL an image younger than the grace window is never deleted: an upload writes the object before it sets the pointer, and the reaper must not read that gap as an orphan', async () => {
    const pub = bucket([
      { key: png(JUST_UPLOADED), lastModified: YOUNG },
      { key: png(NO_TIMESTAMP), lastModified: null },
    ]);
    const { repo, asked } = pointers(TABLE);

    await new AvatarOrphanReaper(pub.r2, repo).reapOrphanedAvatars(NOW);

    expect(pub.deleted).toEqual([]);
    expect(asked, 'no candidate, so no pointer lookup').toEqual([]);
  });

  it('CRITICAL a key that is not exactly avatars/<account id>.<png|jpg|webp|bin> is never touched, and never reaches the uuid-typed pointer query', async () => {
    const strangers = [
      'avatars/not-a-uuid.png',
      `avatars/${NO_ROW}.gif`,
      // Upper case: account ids are written lower case, so this is nobody's key.
      'avatars/ABCDEF01-2345-4678-89AB-CDEF01234567.png',
      `avatars/${NO_ROW}.png.bak`,
      `avatars/nested/${NO_ROW}.png`,
      'avatars/------------------------------------.png',
    ];
    const pub = bucket(strangers.map((key) => ({ key, lastModified: OLD })));
    const { repo, asked } = pointers(TABLE);

    const result = await new AvatarOrphanReaper(pub.r2, repo).reapOrphanedAvatars(NOW);

    expect(pub.deleted).toEqual([]);
    expect(asked).toEqual([]);
    expect(result).toEqual({ scanned: strangers.length, reaped: 0, failed: 0 });
  });

  it('every stored format of an account is recognised, the unknown-type .bin included', async () => {
    const pub = bucket(
      ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'].map((t) => ({
        key: avatarKey(NO_ROW, t),
        lastModified: OLD,
      })),
    );
    const result = await new AvatarOrphanReaper(pub.r2, pointers({}).repo).reapOrphanedAvatars(NOW);
    expect(result.reaped).toBe(4);
    expect([...pub.objects.keys()]).toEqual([]);
  });

  it('one failed delete does not stop the pass; it is counted, and the object stays for the next one', async () => {
    const pub = bucket(
      [
        { key: webp(REMOVED), lastModified: OLD },
        { key: png(NO_ROW), lastModified: OLD },
      ],
      { failDeleteOf: webp(REMOVED) },
    );
    const result = await new AvatarOrphanReaper(pub.r2, pointers(TABLE).repo).reapOrphanedAvatars(
      NOW,
    );
    expect(result).toEqual({ scanned: 2, reaped: 1, failed: 1 });
    expect([...pub.objects.keys()]).toEqual([webp(REMOVED)]);
  });

  it('the pointer lookup is batched, so a large bucket never becomes one unbounded IN list', async () => {
    const ids = Array.from(
      { length: 1201 },
      (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    );
    const pub = bucket(ids.map((id) => ({ key: png(id), lastModified: OLD })));
    const { repo, asked } = pointers({});

    const result = await new AvatarOrphanReaper(pub.r2, repo).reapOrphanedAvatars(NOW);

    expect(asked.map((batch) => batch.length)).toEqual([500, 500, 201]);
    expect(result.reaped).toBe(1201);
  });

  it('a listing the bucket refuses (a token without list permission) rejects, so the caller reports it instead of a clean pass', async () => {
    const pub = bucket([], { failList: true });
    await expect(
      new AvatarOrphanReaper(pub.r2, pointers(TABLE).repo).reapOrphanedAvatars(NOW),
    ).rejects.toThrow(/AccessDenied/);
  });
});

describe('the reaper runs as the avatar_orphans arm of the daily purge', () => {
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
        (l) => l.startsWith(METRIC_NAMES.retentionPurgeTotal) && l.includes('arm="avatar_orphans"'),
      )
      .map((l) => `${/outcome="([^"]+)"/.exec(l)?.[1]}=${l.trim().split(/\s+/).pop()}`)
      .sort();

  it('CRITICAL a pass deletes the orphans and reports purged, with the count in the result', async () => {
    const pub = bucket([
      { key: webp(REMOVED), lastModified: OLD },
      { key: jpg(REPLACED), lastModified: OLD },
    ]);
    const m = metrics();
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      avatarOrphans: new AvatarOrphanReaper(pub.r2, pointers(TABLE).repo),
      metrics: m,
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.avatarOrphansReaped).toBe(1);
    expect([...pub.objects.keys()]).toEqual([jpg(REPLACED)]);
    expect(samples(m)).toEqual(['purged=1']);
  });

  it('CRITICAL a refused listing is contained: the arm reports failed and the tick still completes', async () => {
    const m = metrics();
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      avatarOrphans: new AvatarOrphanReaper(bucket([], { failList: true }).r2, pointers({}).repo),
      metrics: m,
    });
    await expect(sweeper.tickOnce(NOW)).resolves.toMatchObject({ avatarOrphansReaped: 0 });
    expect(samples(m)).toEqual(['failed=1']);
  });

  it('a pass with a failed delete reports failed, not a clean purge', async () => {
    const m = metrics();
    const pub = bucket([{ key: png(NO_ROW), lastModified: OLD }], { failDeleteOf: png(NO_ROW) });
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      avatarOrphans: new AvatarOrphanReaper(pub.r2, pointers({}).repo),
      metrics: m,
    });
    await sweeper.tickOnce(NOW);
    expect(samples(m)).toEqual(['failed=1']);
  });

  it('unwired (no public bucket, so no avatars) reports skipped rather than claiming a pass', async () => {
    const m = metrics();
    const result = await new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      metrics: m,
    }).tickOnce(NOW);
    expect(result.avatarOrphansReaped).toBe(0);
    expect(samples(m)).toEqual(['skipped=1']);
  });

  it('CRITICAL production wires it: bootstrap builds the reaper on the public bucket and hands it to the purge sweeper', () => {
    const boot = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'), 'utf8');
    expect(boot).toMatch(/new AvatarOrphanReaper\(\s*r2Public,\s*new DrizzleAvatarPointerRepo\(/);
    const sweeperCall = boot.slice(boot.indexOf('new AccountDeletionPurgeSweeperService('));
    expect(sweeperCall.slice(0, sweeperCall.indexOf('});'))).toMatch(/\bavatarOrphans\b/);
  });
});

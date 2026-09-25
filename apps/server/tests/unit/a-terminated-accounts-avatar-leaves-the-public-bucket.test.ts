// Security sweep E-23 (2026-09-24), the account-purge half. An avatar is
// customer-supplied personal data on the PUBLIC bucket at a key derived from the
// account id, and account deletion never removed it:
// account-deletion-purge-sweeper.ts mentioned avatars zero times, so a
// terminated account's image stayed publicly readable indefinitely.
//
// The sweeper now has an `avatars` arm: once an account is past the retention
// cutoff it deletes every avatar object the account can have, then clears the
// pointer — in that order, so a failed delete leaves the account in the
// candidate set for the next tick instead of forgetting an object that still
// exists. Like every other arm, an unwired arm reports `skipped`. The arm is a
// TerminatedAccountAvatarPurge bound to the public bucket, so the sweeper itself
// never holds a second R2 client beside its private one.
//
// The candidate query itself runs against Postgres in
// tests/integration/db-terminated-account-avatar-purge-query.test.ts.

import { describe, expect, it } from 'vitest';

import { AccountDeletionPurgeSweeperService } from '../../src/services/account-deletion-purge-sweeper.js';
import { TerminatedAccountAvatarPurge } from '../../src/services/terminated-account-avatar-purge.js';
import { avatarKey, type R2 } from '../../src/lib/r2.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

const NOW = new Date('2026-08-01T00:00:00Z');
const ACC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const noByokRepo = { findDeletedAccountIdsWithByokKeyBefore: () => Promise.resolve([]) };

function bucket(keys: string[], opts: { failDeletes?: boolean } = {}) {
  const objects = new Set(keys);
  const deleted: string[] = [];
  const r2 = {
    bucket: 'public',
    deleteObject: (key: string) => {
      if (opts.failDeletes) return Promise.reject(new Error('bucket unavailable'));
      deleted.push(key);
      objects.delete(key);
      return Promise.resolve();
    },
  } as unknown as R2;
  return { r2, objects, deleted };
}

function avatarsRepo(candidates: string[]) {
  const cleared: string[] = [];
  const cutoffs: Date[] = [];
  return {
    cleared,
    cutoffs,
    repo: {
      findTerminatedAccountIdsWithAvatarBefore: (cutoff: Date) => {
        cutoffs.push(cutoff);
        return Promise.resolve(candidates);
      },
      clearAvatarKey: (accountId: string) => {
        cleared.push(accountId);
        return Promise.resolve();
      },
    },
  };
}

function metrics(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.retentionPurgeTotal, 'test', ['arm', 'outcome']);
  return m;
}

const avatarSamples = (m: MetricsRegistry): string[] =>
  m
    .render()
    .split('\n')
    .filter((l) => l.startsWith(METRIC_NAMES.retentionPurgeTotal) && l.includes('arm="avatars"'))
    .map((l) => `${/outcome="([^"]+)"/.exec(l)?.[1]}=${l.trim().split(/\s+/).pop()}`)
    .sort();

describe("a terminated account's avatar leaves the public bucket", () => {
  it('CRITICAL every avatar object the account can have is deleted, then the pointer is cleared', async () => {
    const keys = ['image/png', 'image/jpeg', 'image/webp'].map((t) => avatarKey(ACC, t));
    const other = avatarKey(OTHER, 'image/png');
    const pub = bucket([...keys, other]);
    const av = avatarsRepo([ACC]);
    const m = metrics();
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      avatars: new TerminatedAccountAvatarPurge(pub.r2, av.repo),
      metrics: m,
    });

    const result = await sweeper.tickOnce(NOW);

    expect([...pub.objects], 'only the other account’s avatar remains').toEqual([other]);
    expect(av.cleared).toEqual([ACC]);
    expect(result.avatarsPurged).toBe(1);
    expect(avatarSamples(m)).toEqual(['purged=1']);
    // The retention window applies: candidates are asked for with the 30-day cutoff.
    expect(av.cutoffs[0]?.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });

  it('CRITICAL a failed delete does NOT clear the pointer, so the account stays a candidate and the next tick retries', async () => {
    const pub = bucket([avatarKey(ACC, 'image/png')], { failDeletes: true });
    const av = avatarsRepo([ACC]);
    const m = metrics();
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      avatars: new TerminatedAccountAvatarPurge(pub.r2, av.repo),
      metrics: m,
    });

    const result = await sweeper.tickOnce(NOW);

    expect(av.cleared, 'the pointer is the only record that an object is still out there').toEqual(
      [],
    );
    expect(result.avatarsPurged).toBe(0);
    expect(avatarSamples(m)).toEqual(['failed=1']);
  });

  it('an unwired arm (no public bucket, so bootstrap builds none) reports skipped rather than claiming a purge', async () => {
    const m = metrics();
    const sweeper = new AccountDeletionPurgeSweeperService({ repo: noByokRepo, metrics: m });
    const result = await sweeper.tickOnce(NOW);
    expect(result.avatarsPurged).toBe(0);
    expect(avatarSamples(m)).toEqual(['skipped=1']);
  });

  it('a throwing candidate query is contained: the arm reports failed and the tick still completes', async () => {
    const m = metrics();
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      avatars: new TerminatedAccountAvatarPurge(bucket([]).r2, {
        findTerminatedAccountIdsWithAvatarBefore: () => Promise.reject(new Error('db down')),
        clearAvatarKey: () => Promise.resolve(),
      }),
      metrics: m,
    });
    await expect(sweeper.tickOnce(NOW)).resolves.toMatchObject({ avatarsPurged: 0 });
    expect(avatarSamples(m)).toEqual(['failed=1']);
  });
});

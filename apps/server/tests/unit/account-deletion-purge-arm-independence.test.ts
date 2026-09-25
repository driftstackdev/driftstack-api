// Each retention arm of the account-deletion purge runs on its own.
//
// This sweeper carries three separate privacy-policy.md §9 commitments — the
// BYOK Anthropic key, the wrapped proxy credentials, and the account's profiles
// and snapshots. They are erased on one 30-day clock but they are NOT one
// capability: the BYOK key needs MFA_ENCRYPTION_KEY, proxy secrets are wrapped
// under PROFILE_MASTER_KEY, and the profile purge needs no key at all.
//
// The whole sweeper used to be gated on the BYOK service being wired. That was
// correct when the BYOK key was the only thing it purged and "no key storage
// configured" really did mean "nothing to do". It stopped being correct the
// moment the other two arms were added: an unset MFA_ENCRYPTION_KEY then
// switched off three retention promises, two of which had nothing to do with
// that flag, and it would have done so SILENTLY — the sweeper simply never
// being constructed produces no error, no log line, and a green suite.
//
// So the property worth guarding is not "the purge works". It is that no arm's
// absence can take another arm down with it.

import { describe, expect, it } from 'vitest';

import { AccountDeletionPurgeSweeperService } from '../../src/services/account-deletion-purge-sweeper.js';
import type { BYOKAnthropicService } from '../../src/services/byok-anthropic.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-31T00:00:00Z');

function byokArm(cleared: string[]): {
  repo: { findDeletedAccountIdsWithByokKeyBefore: (c: Date) => Promise<string[]> };
  byok: BYOKAnthropicService;
} {
  return {
    repo: { findDeletedAccountIdsWithByokKeyBefore: () => Promise.resolve(['acc_byok']) },
    byok: {
      clearKey: ({ accountId }: { accountId: string }) => {
        cleared.push(accountId);
        return Promise.resolve(undefined);
      },
    } as unknown as BYOKAnthropicService,
  };
}

function proxyArm(cleared: string[]) {
  return {
    findDeletedAccountIdsWithProxySecretsBefore: () => Promise.resolve(['acc_proxy']),
    clearProxySecretsForAccount: (accountId: string) => {
      cleared.push(accountId);
      return Promise.resolve(1);
    },
  };
}

function profileArm(calls: string[]) {
  return {
    purgeProfilesForTerminatedAccountsBefore: () => {
      calls.push('profiles');
      return Promise.resolve(['prof_1']);
    },
    purgeSnapshotsForTerminatedAccountsBefore: () => {
      calls.push('snapshots');
      return Promise.resolve(2);
    },
  };
}

/** The receipt + session arms, recording their calls so a later arm can be
 *  proved to have run after an earlier one failed. */
function turnReceiptArm(calls: string[], opts: { throws?: boolean } = {}) {
  return {
    purgeForTerminatedAccountsBefore: (): Promise<number> => {
      calls.push('turn_receipts');
      return opts.throws === true ? Promise.reject(new Error('db down')) : Promise.resolve(3);
    },
  };
}

function agentSessionArm(calls: string[], opts: { throws?: boolean } = {}) {
  return {
    purgeForTerminatedAccountsBefore: (): Promise<number> => {
      calls.push('agent_sessions');
      return opts.throws === true ? Promise.reject(new Error('db down')) : Promise.resolve(4);
    },
  };
}

/** Snapshots succeed, the profile delete then fails — the partial case, which
 *  is the one the source comment calls out as leaving stranded snapshots. */
function profileArmFailing(calls: string[]) {
  return {
    purgeSnapshotsForTerminatedAccountsBefore: (): Promise<number> => {
      calls.push('snapshots');
      return Promise.resolve(2);
    },
    purgeProfilesForTerminatedAccountsBefore: (): Promise<string[]> => {
      calls.push('profiles');
      return Promise.reject(new Error('db down'));
    },
  };
}

/**
 * A repo whose BYOK query throws if it is ever reached, and records that it was.
 * The throw alone no longer fails a tick: a throwing candidate query is now
 * contained to its own arm (reported failed, the rest still run). So the record
 * is what the never-queried arm below checks.
 */
const byokQueries: Date[] = [];
const byokRepoNeverCalled = {
  findDeletedAccountIdsWithByokKeyBefore: (cutoff: Date): Promise<string[]> => {
    byokQueries.push(cutoff);
    throw new Error('BYOK candidate query must not run when the service is unwired');
  },
};

describe('no purge arm can be disabled by another arm being unavailable', () => {
  it('CRITICAL with the BYOK service UNWIRED, the proxy and profile arms still run. This is the regression that mattered: the sweeper used to be gated on BYOK, so an unset MFA_ENCRYPTION_KEY silently switched off two unrelated §9 commitments and produced no error, no log and a green suite.', async () => {
    const proxies: string[] = [];
    const profiles: string[] = [];
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepoNeverCalled,
      proxySecrets: proxyArm(proxies),
      profiles: profileArm(profiles),
    });

    const result = await sweeper.tickOnce(NOW);

    expect(proxies, 'proxy credentials are still erased').toEqual(['acc_proxy']);
    expect(profiles, 'profiles and snapshots are still erased').toEqual(['snapshots', 'profiles']);
    expect(result.proxySecretsPurged).toBe(1);
    expect(result.profilesPurged).toBe(1);
    expect(result.snapshotsPurged).toBe(2);
    expect(result.purged, 'the BYOK arm reports nothing rather than pretending').toBe(0);
  });

  it('CRITICAL an unwired BYOK service does not even QUERY for candidates. Fetching a candidate list it cannot act on would burn a query per tick and, worse, would report accounts as "found" that nothing will ever purge.', async () => {
    byokQueries.length = 0;
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepoNeverCalled,
      profiles: profileArm([]),
    });

    await expect(sweeper.tickOnce(NOW)).resolves.toMatchObject({ purged: 0 });
    expect(byokQueries, 'the BYOK candidate query ran with no BYOK service wired').toEqual([]);
  });

  it('CRITICAL with proxy and profile arms absent, the BYOK arm still runs. The independence has to hold in every direction, not just the one that broke.', async () => {
    const cleared: string[] = [];
    const sweeper = new AccountDeletionPurgeSweeperService(byokArm(cleared));

    const result = await sweeper.tickOnce(NOW);

    expect(cleared, 'the BYOK key is still erased').toEqual(['acc_byok']);
    expect(result.purged).toBe(1);
    expect(result.proxySecretsPurged).toBe(0);
    expect(result.profilesPurged).toBe(0);
  });

  it('CRITICAL a THROWING proxy arm does not stop the profile arm. A per-arm failure must be isolated, or one broken retention promise takes the others down with it on every tick.', async () => {
    const profiles: string[] = [];
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepoNeverCalled,
      proxySecrets: {
        findDeletedAccountIdsWithProxySecretsBefore: () => Promise.resolve(['acc_proxy']),
        clearProxySecretsForAccount: () => Promise.reject(new Error('db down')),
      },
      profiles: profileArm(profiles),
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.proxySecretsPurged, 'the failing arm purged nothing').toBe(0);
    expect(profiles, 'the profile arm still ran').toEqual(['snapshots', 'profiles']);
    expect(result.profilesPurged).toBe(1);
  });

  // Per-arm failure isolation was proved for the proxy arm only. Measured on
  // the rest: making the profiles, turn-receipt or agent-session catch rethrow
  // reds NOTHING across 20 purge/retention files and 115 tests, while the byok
  // and proxy arms red 1 and 2. `profiles` even appears in this file already —
  // but as the arm that must KEEP RUNNING when another fails, never as the one
  // that fails. Being named in an independence test is not the same as having
  // your own failure path covered.
  //
  // It matters more here than the isolation alone suggests: the arms run in
  // sequence in one method, so an escaping throw from an EARLY arm skips every
  // LATER one. A profiles failure would silently stop the receipt and session
  // purges too, and this sweeper is the erasure we committed to — data that is
  // not purged is data retained.
  it('CRITICAL a THROWING profile arm does not stop the receipt or session arms', async () => {
    const calls: string[] = [];
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepoNeverCalled,
      profiles: profileArmFailing(calls),
      turnReceipts: turnReceiptArm(calls),
      agentSessions: agentSessionArm(calls),
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.profilesPurged, 'the failing arm purged nothing').toBe(0);
    expect(calls, 'both later arms still ran').toEqual([
      'snapshots',
      'profiles',
      'turn_receipts',
      'agent_sessions',
    ]);
    expect(result.turnReceiptsPurged).toBe(3);
    expect(result.agentSessionsPurged).toBe(4);
  });

  it('CRITICAL a THROWING receipt arm does not stop the session arm', async () => {
    const calls: string[] = [];
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepoNeverCalled,
      profiles: profileArm(calls),
      turnReceipts: turnReceiptArm(calls, { throws: true }),
      agentSessions: agentSessionArm(calls),
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.turnReceiptsPurged, 'the failing arm purged nothing').toBe(0);
    expect(calls.at(-1), 'the session arm still ran after it').toBe('agent_sessions');
    expect(result.agentSessionsPurged).toBe(4);
  });

  it('CRITICAL a THROWING session arm still leaves the tick successful and the earlier arms applied', async () => {
    // The last arm in the sequence: nothing runs after it, so what this proves
    // is that its failure does not turn the whole sweep into a rejection —
    // which would take the scheduled job down with it every tick.
    const calls: string[] = [];
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepoNeverCalled,
      profiles: profileArm(calls),
      turnReceipts: turnReceiptArm(calls),
      agentSessions: agentSessionArm(calls, { throws: true }),
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.agentSessionsPurged).toBe(0);
    expect(result.profilesPurged, 'the earlier arms still applied').toBe(1);
    expect(result.turnReceiptsPurged).toBe(3);
  });

  // After the profile rows are deleted, each sealed blob is removed from R2 in
  // its own swallow. The comment there is the reason this arm exists: an
  // undeleted blob is the customer's data outliving the erasure we committed
  // to, so the log is the ONLY record that it happened.
  //
  // Making that catch rethrow reds nothing across 20 purge and retention files.
  // The failure it would cause is subtle rather than loud: the throw lands in
  // the enclosing profiles catch, so a purge whose database rows were deleted
  // successfully gets reported as a FAILED profiles arm — and the next tick
  // finds no profiles left to retry, so neither the count nor the orphan is
  // ever corrected.
  it('CRITICAL an R2 blob-delete failure leaves the profile purge successful and logs the orphan', async () => {
    const errors: Array<Record<string, unknown>> = [];
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepoNeverCalled,
      profiles: profileArm([]),
      r2: {
        deleteObject: () => Promise.reject(new Error('r2 unavailable')),
      } as unknown as ConstructorParameters<typeof AccountDeletionPurgeSweeperService>[0]['r2'],
      logger: {
        error: (obj: Record<string, unknown>) => {
          errors.push(obj);
        },
      } as unknown as ConstructorParameters<typeof AccountDeletionPurgeSweeperService>[0]['logger'],
    });

    const result = await sweeper.tickOnce(NOW);

    expect(
      result.profilesPurged,
      'the rows WERE deleted, so the arm must not report itself failed because a blob lingered',
    ).toBe(1);
    expect(
      errors.some((e) => e['profileId'] === 'prof_1'),
      'the orphaned blob must be logged — that log is the only record it was left behind',
    ).toBe(true);
  });

  it('CRITICAL every arm reports its own count, so a silently-skipped arm is visible rather than absorbed into a single number.', async () => {
    const sweeper = new AccountDeletionPurgeSweeperService({ repo: byokRepoNeverCalled });

    const result = await sweeper.tickOnce(NOW);

    // Exhaustive on purpose: `toEqual` fails when an arm is ADDED as well as
    // when one is dropped, so a new erasure promise cannot be wired in without
    // someone confirming it reports a count of its own. It caught the
    // turn-receipts arm on the commit that introduced it.
    expect(result).toEqual({
      purged: 0,
      proxySecretsPurged: 0,
      profilesPurged: 0,
      snapshotsPurged: 0,
      turnReceiptsPurged: 0,
      agentSessionsPurged: 0,
      // V-1607 — recipes deliberately survive agent-session cleanup
      // (`agent_session_id` ON DELETE SET NULL), so purging sessions does NOT
      // reach them and they need their own arm and their own count.
      recipesPurged: 0,
      // Security sweep E-23 (2026-09-24) — avatars sit on the PUBLIC bucket, which
      // no other arm touches, so they need their own arm and their own count.
      avatarsPurged: 0,
      // And the avatar images nothing points at, which no pointer-driven arm can
      // find; a count of their own for the same reason.
      avatarOrphansReaped: 0,
      // 2026-09-25 — sealed profile blobs no profile owns, which no row-driven
      // arm can find; moved onto this daily tick from an in-process timer.
      profileBlobOrphansReaped: 0,
    });
  });

  // The BYOK and proxy-secret arms each start with a CANDIDATE query, and those
  // two queries sat outside any try: every later arm is wrapped per arm, but a
  // throw from either candidate query rejected the whole tick. The scheduled job
  // catches that and re-arms for tomorrow, so nothing crashed — but every arm
  // after it (profiles, receipts, sessions, recipes, both avatar arms and the
  // profile-blob orphan sweep) was skipped with no metric of its own, and the
  // failing arm reported nothing either. One broken query took every other
  // erasure promise down with it, every day it kept failing.
  describe('a throwing CANDIDATE query is contained to its own arm', () => {
    function registry(): MetricsRegistry {
      const m = new MetricsRegistry();
      m.registerCounter(METRIC_NAMES.retentionPurgeTotal, 'test', ['arm', 'outcome']);
      return m;
    }
    const outcomes = (m: MetricsRegistry, arm: string): string[] =>
      m
        .render()
        .split('\n')
        .filter((l) => l.startsWith(METRIC_NAMES.retentionPurgeTotal) && l.includes(`arm="${arm}"`))
        .map((l) => /outcome="([^"]+)"/.exec(l)?.[1] ?? '?')
        .sort();

    /** Every arm after the proxy arm, each recording that it ran. */
    function laterArms(calls: string[]) {
      return {
        profiles: profileArm(calls),
        turnReceipts: turnReceiptArm(calls),
        agentSessions: agentSessionArm(calls),
        recipes: {
          purgeForTerminatedAccountsBefore: (): Promise<number> => {
            calls.push('recipes');
            return Promise.resolve(1);
          },
        },
        avatars: {
          findTerminatedAccountIdsWithAvatarBefore: (): Promise<string[]> => {
            calls.push('avatars');
            return Promise.resolve([]);
          },
          deleteAvatarObjects: (): Promise<void> => Promise.resolve(),
          clearAvatarKey: (): Promise<void> => Promise.resolve(),
        },
        avatarOrphans: {
          reapOrphanedAvatars: () => {
            calls.push('avatar_orphans');
            return Promise.resolve({ scanned: 0, reaped: 0, failed: 0 });
          },
        },
        profileBlobOrphans: {
          reapOrphanedProfileBlobs: () => {
            calls.push('profile_blob_orphans');
            return Promise.resolve({ scanned: 1, reaped: 1, failed: 0, capped: false });
          },
        },
      };
    }
    const EVERY_LATER_ARM = [
      'snapshots',
      'profiles',
      'turn_receipts',
      'agent_sessions',
      'recipes',
      'avatars',
      'avatar_orphans',
      'profile_blob_orphans',
    ];

    it('CRITICAL a throwing BYOK candidate query: the tick resolves, BYOK reports failed and logs, and the proxy arm and every arm after it still run', async () => {
      const calls: string[] = [];
      const proxies: string[] = [];
      const errors: string[] = [];
      const m = registry();
      const sweeper = new AccountDeletionPurgeSweeperService({
        repo: {
          findDeletedAccountIdsWithByokKeyBefore: () => Promise.reject(new Error('db down')),
        },
        byok: byokArm([]).byok,
        proxySecrets: proxyArm(proxies),
        ...laterArms(calls),
        metrics: m,
        logger: {
          info: () => {},
          warn: () => {},
          error: (_o: Record<string, unknown>, msg: string) => errors.push(msg),
        } as unknown as ConstructorParameters<
          typeof AccountDeletionPurgeSweeperService
        >[0]['logger'],
      });

      const result = await sweeper.tickOnce(NOW);

      expect(result.purged).toBe(0);
      expect(outcomes(m, 'byok')).toEqual(['failed']);
      expect(errors.join('\n')).toMatch(/BYOK/);
      expect(proxies, 'the proxy arm still ran').toEqual(['acc_proxy']);
      expect(calls, 'every later arm still ran').toEqual(EVERY_LATER_ARM);
      expect(result.profileBlobOrphansReaped).toBe(1);
      expect(outcomes(m, 'profile_blob_orphans')).toEqual(['purged']);
    });

    it('CRITICAL a throwing proxy-secret candidate query: the tick resolves, the proxy arm reports failed, and every arm after it still runs', async () => {
      const calls: string[] = [];
      const m = registry();
      const sweeper = new AccountDeletionPurgeSweeperService({
        repo: byokRepoNeverCalled,
        proxySecrets: {
          findDeletedAccountIdsWithProxySecretsBefore: () => Promise.reject(new Error('db down')),
          clearProxySecretsForAccount: () => Promise.resolve(0),
        },
        ...laterArms(calls),
        metrics: m,
      });

      const result = await sweeper.tickOnce(NOW);

      expect(result.proxySecretsPurged).toBe(0);
      expect(outcomes(m, 'proxy_secrets')).toEqual(['failed']);
      expect(calls, 'every later arm still ran').toEqual(EVERY_LATER_ARM);
      expect(result.profileBlobOrphansReaped).toBe(1);
    });
  });

  it('sanity — the retention window is still applied, so none of the above accidentally proves a sweeper that ignores the clock', async () => {
    let seenCutoff: Date | null = null;
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepoNeverCalled,
      proxySecrets: {
        findDeletedAccountIdsWithProxySecretsBefore: (cutoff: Date) => {
          seenCutoff = cutoff;
          return Promise.resolve([]);
        },
        clearProxySecretsForAccount: () => Promise.resolve(0),
      },
    });

    await sweeper.tickOnce(NOW);

    expect(seenCutoff, 'the candidate query receives a cutoff').not.toBeNull();
    expect(NOW.getTime() - (seenCutoff as unknown as Date).getTime()).toBe(30 * DAY_MS);
  });
});

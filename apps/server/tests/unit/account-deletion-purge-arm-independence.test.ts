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

/** A repo whose BYOK query would throw if it were ever reached. */
const byokRepoNeverCalled = {
  findDeletedAccountIdsWithByokKeyBefore: (): Promise<string[]> => {
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
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepoNeverCalled,
      profiles: profileArm([]),
    });

    // byokRepoNeverCalled throws on contact, so reaching it fails this outright.
    await expect(sweeper.tickOnce(NOW)).resolves.toMatchObject({ purged: 0 });
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

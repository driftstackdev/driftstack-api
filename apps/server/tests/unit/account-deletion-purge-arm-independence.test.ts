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

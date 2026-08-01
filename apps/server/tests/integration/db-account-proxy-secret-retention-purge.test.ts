// Wrapped proxy credentials are erased 30 days after account termination.
//
// privacy-policy.md §3.5 defines Customer-Provided Secrets in its own words to
// include "HTTP/SOCKS5 proxy credentials", and the §9 retention table commits
// to deleting them "within 30 days of Customer Account termination". Nothing
// did. `deleteAccount` is a SOFT delete — it flips status and reclaims
// sessions, web sessions, API keys and webhooks, and touches no proxy row. The
// accounts row is never hard-deleted, so the ON DELETE CASCADE on
// account_proxies never fires. The account-deletion purge sweeper cleared only
// the BYOK Anthropic key, and the only other retention sweeper keys off a
// PROFILE's own deletedAt rather than the account's. So a terminated account's
// wrapped proxy password, OpenVPN config blob and WireGuard private key were
// retained indefinitely, against a published commitment.
//
// This runs against real Postgres deliberately. The whole safety of the purge
// is two SQL predicates — `status = 'deleted'` and `deleted_at < cutoff` — and
// an in-memory fake would prove nothing about whether they hold. The cases that
// matter most here are the ones that must NOT be touched.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';
import type { Database } from '../../src/db/client.js';

// Runs against its OWN database: every purge here is GLOBAL — it selects and
// DELETES by cutoff across all accounts, so on a shared database it reaches
// other test files' fixtures and they reach its. See
// _helpers/isolated-database.ts; the agent-session purge already destroyed the
// receipt test's rows once via ON DELETE CASCADE, and that was patched with a
// fixture workaround, which is the fix that does not hold.
const ISOLATED_DB_NAME = 'driftstack_iso_purge_proxy';
let DB_URL = '';
const DAY_MS = 24 * 60 * 60 * 1000;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM account_proxies LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM account_proxies WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

/** An account in a given lifecycle state, owning one secret-bearing proxy. */
async function seedAccountWithProxy(args: {
  status: 'active' | 'suspended' | 'deleted';
  deletedDaysAgo: number | null;
}): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seeded.push(accountId);
  const deletedAt =
    args.deletedDaysAgo === null
      ? null
      : new Date(Date.now() - args.deletedDaysAgo * DAY_MS).toISOString();
  await client`
    INSERT INTO accounts (id, email, status, deleted_at)
    VALUES (${accountId}, ${`proxy-retention-${accountId}@test.local`}, ${args.status}::account_status, ${deletedAt})`;
  await client`
    INSERT INTO account_proxies (id, account_id, label, scheme, host, port, wrapped_password, wrapped_secret)
    VALUES (${randomUUID()}, ${accountId}, 'p', 'socks5', 'proxy.example.com', 1080, 'v2:wrapped-password', 'v2:wrapped-secret')`;
  return accountId;
}

function repoOf(): DrizzleAccountProxiesRepo {
  if (!client) throw new Error('no client');
  return new DrizzleAccountProxiesRepo({
    client,
    db: null,
    close: async () => {},
  } as unknown as Database);
}

async function secretsOf(
  accountId: string,
): Promise<Array<{ pw: string | null; sec: string | null }>> {
  const rows = await client!<
    Array<{ wrapped_password: string | null; wrapped_secret: string | null }>
  >`
    SELECT wrapped_password, wrapped_secret FROM account_proxies WHERE account_id = ${accountId}::uuid`;
  return rows.map((r) => ({ pw: r.wrapped_password, sec: r.wrapped_secret }));
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'wrapped proxy credentials are erased 30 days after account termination',
  () => {
    it('CRITICAL the database was actually reached. Every assertion below is DB-backed, so a connection failure would return early from all of them and this file would report green while proving nothing about a credential wipe.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL an account terminated PAST the window is a purge candidate, and clearing it nulls both wrapped columns. This is the published commitment: the credential is gone, not merely unreachable.', async () => {
      const accountId = await seedAccountWithProxy({ status: 'deleted', deletedDaysAgo: 45 });
      const repo = repoOf();
      const cutoff = new Date(Date.now() - 30 * DAY_MS);

      expect(
        await repo.findDeletedAccountIdsWithProxySecretsBefore(cutoff),
        'a 45-day-old termination is past a 30-day cutoff',
      ).toContain(accountId);

      expect(await repo.clearProxySecretsForAccount(accountId)).toBe(1);
      expect(await secretsOf(accountId)).toEqual([{ pw: null, sec: null }]);
    });

    it('CRITICAL an ACTIVE account is never a candidate and its credentials survive a direct clear. This is the case that matters most — the purge must be incapable of wiping a live customer, even if a stale id reaches it.', async () => {
      const accountId = await seedAccountWithProxy({ status: 'active', deletedDaysAgo: null });
      const repo = repoOf();
      const cutoff = new Date(Date.now() - 30 * DAY_MS);

      expect(
        await repo.findDeletedAccountIdsWithProxySecretsBefore(cutoff),
        'a live account must never be selected',
      ).not.toContain(accountId);

      // Called DIRECTLY with a live account's id, as a stale candidate list
      // computed on an earlier tick would. The status predicate is repeated
      // inside the UPDATE precisely so this cannot wipe anything.
      expect(await repo.clearProxySecretsForAccount(accountId)).toBe(0);
      expect(await secretsOf(accountId)).toEqual([
        { pw: 'v2:wrapped-password', sec: 'v2:wrapped-secret' },
      ]);
    });

    it('CRITICAL an account terminated INSIDE the window is not yet a candidate. Erasing early would destroy credentials a customer can still reinstate within the disclosed window.', async () => {
      const accountId = await seedAccountWithProxy({ status: 'deleted', deletedDaysAgo: 5 });
      const repo = repoOf();
      const cutoff = new Date(Date.now() - 30 * DAY_MS);

      expect(
        await repo.findDeletedAccountIdsWithProxySecretsBefore(cutoff),
        'a 5-day-old termination is inside a 30-day window',
      ).not.toContain(accountId);
      expect(await secretsOf(accountId)).toEqual([
        { pw: 'v2:wrapped-password', sec: 'v2:wrapped-secret' },
      ]);
    });

    it('CRITICAL a SUSPENDED account is not a candidate. Suspension is reversible and is not termination; conflating the two would erase the credentials of an account that gets reinstated.', async () => {
      const accountId = await seedAccountWithProxy({ status: 'suspended', deletedDaysAgo: 45 });
      const repo = repoOf();
      const cutoff = new Date(Date.now() - 30 * DAY_MS);

      expect(
        await repo.findDeletedAccountIdsWithProxySecretsBefore(cutoff),
        'suspension is not termination',
      ).not.toContain(accountId);
      expect(await repo.clearProxySecretsForAccount(accountId)).toBe(0);
    });

    it('CRITICAL the purge is self-limiting — a cleared account drops out of the candidate set, so repeated ticks converge instead of rewriting rows forever.', async () => {
      const accountId = await seedAccountWithProxy({ status: 'deleted', deletedDaysAgo: 45 });
      const repo = repoOf();
      const cutoff = new Date(Date.now() - 30 * DAY_MS);

      await repo.clearProxySecretsForAccount(accountId);

      expect(
        await repo.findDeletedAccountIdsWithProxySecretsBefore(cutoff),
        'nothing left to purge for this account',
      ).not.toContain(accountId);
      expect(await repo.clearProxySecretsForAccount(accountId), 'a second clear is a no-op').toBe(
        0,
      );
    });
  },
);

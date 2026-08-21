// V-1231 — one contract for the account-audit counter, against BOTH implementations of
// `AccountAuditRepo`.
//
// The twenty-first of the twenty-nine. `countActionsSince(accountId, action, since)` answers "how
// many times has this account done this in the last window?", which is what abuse and
// rate-of-change controls read. A counter that under-reports is a control that does not fire; one
// that over-reports locks a customer out of their own account for activity they did not perform.
//
//   Drizzle  count(*) WHERE account_id = $1 AND action = $2 AND timestamp >= $since
//   double   rows.filter(r => r.accountId === … && r.action === … && r.timestamp >= since).length
//
// THE BOUNDARY IS INCLUSIVE — `>=`, not `>` — on both sides, and that is the arm worth having.
// Off by one in either direction changes the count by exactly the entry sitting on the window edge,
// which is the entry a caller passing "the timestamp of the last thing I saw" is asking about.
//
// AND IT IS TESTABLE HERE, unlike V-1228 and V-1229. Both implementations stamp `timestamp`
// themselves, so a fixture cannot choose it — but `insert` RETURNS the row, so the test can read the
// stamp back and pass it as `since`. That makes the boundary exact on both sides without a
// millisecond-versus-microsecond race, and without needing a DB-only arm. Worth stating because the
// previous two contracts hit the same wall and had to work around it; here the interface hands the
// value back and the workaround is unnecessary.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { AccountAuditRepo } from '../../src/services/account-audit.js';
import { DrizzleAccountAuditRepo } from '../../src/db/account-audit-repo.js';
import { InMemoryAccountAuditRepo } from './_helpers/in-memory-account-audit-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const LOGIN = 'account.login' as const;
const LOGOUT = 'account.logout' as const;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM account_audit_log LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const a of seeded) {
      await client`DELETE FROM account_audit_log WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: AccountAuditRepo;
  account: () => Promise<string>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryAccountAuditRepo(),
    account: () => Promise.resolve(randomUUID()),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleAccountAuditRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`audit-${id}@test.local`})`;
      return id;
    },
  };
}

async function record(s: Subject, accountId: string, action: typeof LOGIN | typeof LOGOUT) {
  return s.repo.insert({
    accountId,
    actorType: 'customer',
    actorAccountId: accountId,
    action,
  });
}

function auditCountContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`AccountAuditRepo counter contract — ${label}`, () => {
    it('CRITICAL the since boundary is INCLUSIVE, in both. The entry stamped exactly at `since` counts. A caller passing the timestamp of the last entry it saw is asking about that entry, and `>` instead of `>=` silently drops it — one event per window, always the one on the edge.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const entry = await record(s, account, LOGIN);

      expect(
        await s.repo.countActionsSince(account, LOGIN, entry.timestamp),
        'an entry stamped exactly at `since` was not counted — the boundary is exclusive',
      ).toBe(1);
    });

    it('CRITICAL an entry strictly BEFORE the window is excluded, in both. Without this the inclusive arm above is satisfied by an implementation that ignores `since` entirely and counts everything.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const entry = await record(s, account, LOGIN);
      const justAfter = new Date(entry.timestamp.getTime() + 1);

      expect(
        await s.repo.countActionsSince(account, LOGIN, justAfter),
        'an entry before the window was counted',
      ).toBe(0);
    });

    it('CRITICAL only the requested ACTION is counted, in both. These counters gate on one action at a time, so folding others in makes an unrelated login trip a control aimed at something else.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const first = await record(s, account, LOGIN);
      await record(s, account, LOGOUT);
      await record(s, account, LOGOUT);

      expect(
        await s.repo.countActionsSince(account, LOGIN, first.timestamp),
        'entries with a different action were counted',
      ).toBe(1);
    });

    it("CRITICAL only the requested ACCOUNT is counted, in both. A shared counter would let one customer's activity trip another customer's control — locking someone out for something they did not do.", async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      const mine = await record(s, owner, LOGIN);
      await record(s, stranger, LOGIN);
      await record(s, stranger, LOGIN);

      expect(
        await s.repo.countActionsSince(owner, LOGIN, mine.timestamp),
        "another account's entries were counted",
      ).toBe(1);
    });

    it('CRITICAL repeated actions accumulate, in both. Without this every arm above is satisfied by an implementation that returns 1 for anything it finds and never actually counts.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const first = await record(s, account, LOGIN);
      await record(s, account, LOGIN);
      await record(s, account, LOGIN);

      expect(
        await s.repo.countActionsSince(account, LOGIN, first.timestamp),
        'repeated actions did not accumulate',
      ).toBe(3);
    });
  });
}

auditCountContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'AccountAuditRepo counter contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    auditCountContract('drizzle', drizzleSubject, () => dbReachable);
  },
);

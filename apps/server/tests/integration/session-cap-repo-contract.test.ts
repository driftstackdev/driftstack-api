// V-1219 — one contract for the session cap, executed against BOTH implementations of `SessionRepo`.
//
// The tenth of the twenty-nine. `countActiveSessions` is what enforces a tier's concurrent-session
// limit, so the number it returns is the difference between a customer being allowed to start
// another session and being told they are at their cap.
//
// THE PROPERTY WORTH PINNING is what "active" means here, because it is not what it sounds like:
//
//     .where(and(eq(sessions.accountId, accountId), isNull(sessions.destroyedAt)))
//
// The cap keys on `destroyed_at IS NULL` and NOT on status. A session that has ERRORED but was
// never destroyed still holds a slot, deliberately — the driver session may still exist, and the
// row is the only record that it might. An implementation that "tidied this up" by counting only
// live-looking statuses would free slots the platform has not actually reclaimed, and the customer
// would be allowed past their cap. The double happens to key on the same thing today; nothing
// asserted it, and the two words that would drift apart — "active" the status and "active" the cap
// — are the same word.
//
// I checked this pair in V-1218 and found it faithful, then declined to write the contract because
// the Drizzle fixture needs an account and an api key. That is the same deferral-on-cost the log
// criticised in V-1212, so the fixture is here and the contract is written.
//
// The arms use only interface methods — `insertSession`, `updateSessionStatus`, `countActiveSessions`,
// `listActiveByAccount` — so neither implementation is driven through a private seam the other
// lacks, which is the failure mode that makes a contract test quietly about one side.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { SessionRepo } from '../../src/services/sessions.js';
import { DrizzleSessionRepo } from '../../src/db/sessions-repo.js';
import { InMemorySessionsRepo } from './_helpers/in-memory-sessions-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM sessions LIMIT 0`;
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
      await client`DELETE FROM sessions WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM api_keys WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Tenant {
  accountId: string;
  apiKeyId: string;
}

interface Subject {
  repo: SessionRepo;
  /** An account with an api key, because `sessions.api_key_id` is NOT NULL with an FK. */
  tenant: () => Promise<Tenant>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemorySessionsRepo(),
    tenant: () => Promise.resolve({ accountId: randomUUID(), apiKeyId: randomUUID() }),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleSessionRepo({ client: c, db, close: async () => {} }),
    tenant: async () => {
      const accountId = randomUUID();
      const apiKeyId = randomUUID();
      seeded.push(accountId);
      const tag = accountId.slice(0, 8);
      await c`INSERT INTO accounts (id, email)
              VALUES (${accountId}, ${`cap-contract-${accountId}@test.local`})`;
      await c`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes)
              VALUES (${apiKeyId}::uuid, ${accountId}::uuid, ${`cap-${tag}`},
                      ${`ds_cap_${tag}`}, ${`hash-${tag}`}, ${['read', 'write']})`;
      return { accountId, apiKeyId };
    },
  };
}

async function startSession(s: Subject, t: Tenant): Promise<string> {
  const row = await s.repo.insertSession({
    accountId: t.accountId,
    apiKeyId: t.apiKeyId,
    driverSessionId: `drv_${randomUUID()}`,
    archetype: 'iphone17_ios18_7_safari26_4',
    // Real enum member — the in-memory double accepted 'automation' and Postgres did not, which
    // is the fixture equivalent of the divergence this whole file is about.
    purpose: 'production_customer',
    label: null,
    metadata: null,
  });
  return row.id;
}

function sessionCapContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`SessionRepo cap contract — ${label}`, () => {
    it('CRITICAL a session that ERRORED but was never destroyed still holds a cap slot, in both. The cap keys on destroyed_at IS NULL and not on status, deliberately: the driver session may still exist and this row is the only record that it might. An implementation counting only live-looking statuses frees slots the platform has not reclaimed and lets the customer past their limit.', async () => {
      if (!enabled()) return;
      const s = make();
      const t = await s.tenant();
      const id = await startSession(s, t);

      await s.repo.updateSessionStatus(id, 'errored');

      expect(
        await s.repo.countActiveSessions(t.accountId),
        'a terminal STATUS released the cap slot even though the session was never destroyed',
      ).toBe(1);
    });

    it('CRITICAL destroying a session DOES free the slot, in both. Without this the arm above is satisfied by an implementation whose count never goes down at all.', async () => {
      if (!enabled()) return;
      const s = make();
      const t = await s.tenant();
      const id = await startSession(s, t);
      expect(await s.repo.countActiveSessions(t.accountId), 'the session did not count').toBe(1);

      await s.repo.updateSessionStatus(id, 'destroyed', { destroyedAt: new Date() });

      expect(
        await s.repo.countActiveSessions(t.accountId),
        'destroying the session did not release its slot',
      ).toBe(0);
    });

    it("CRITICAL the cap is account-scoped, in both. A neighbour's sessions counting against this account's limit would lock a paying customer out of a product they are entitled to.", async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.tenant();
      const stranger = await s.tenant();
      await startSession(s, stranger);

      expect(
        await s.repo.countActiveSessions(owner.accountId),
        "another account's session counted against this cap",
      ).toBe(0);
    });

    it('CRITICAL listActiveByAccount and countActiveSessions describe the SAME set, in both. They are read by different callers — the dashboard lists, the cap counts — so a customer shown two sessions and refused a third at a limit of five is looking at two answers to one question.', async () => {
      if (!enabled()) return;
      const s = make();
      const t = await s.tenant();
      const kept = await startSession(s, t);
      const gone = await startSession(s, t);
      await s.repo.updateSessionStatus(gone, 'destroyed', { destroyedAt: new Date() });

      const listed = (await s.repo.listActiveByAccount(t.accountId)).map((r) => r.id);
      expect(listed, 'the list disagrees with the count about which sessions are active').toEqual([
        kept,
      ]);
      expect(
        await s.repo.countActiveSessions(t.accountId),
        'the count disagrees with the list',
      ).toBe(listed.length);
    });
  });
}

sessionCapContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'SessionRepo cap contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    sessionCapContract('drizzle', drizzleSubject, () => dbReachable);
  },
);

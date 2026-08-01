// The repo layer's own account boundary, exercised directly.
//
// Found by mutation sweep, not by reading. Every `eq(table.accountId, …)`
// predicate in `agent-sessions-repo.ts` (8) and `account-proxies-repo.ts` (6)
// was neutralised — rewritten to `eq(t.accountId, t.accountId)`, which is
// always true — and the ENTIRE suite stayed green: 2,564 files, 26,584 tests,
// zero failures. Fourteen cross-account checks, none of them proving anything.
//
// They are not the only defence and this was not a live vulnerability: the
// service and route layers check ownership before these methods are reached,
// and there ARE route tests for that ("cross-account guard rejects before
// setMode"). But those tests drive a repo DOUBLE, so they exercise the service
// check and never the SQL. The five DB integration files that do use the real
// Drizzle repos test idempotency, concurrency, transcript migration and
// receipts — none of them ever passes a mismatched account id.
//
// So the repo predicate is a second line of defence in a codebase where the
// first line is well tested and the second is not tested at all. That is worth
// closing on its own terms: defence in depth that nothing verifies is defence
// in belief. If a service refactor ever drops the outer check — or a new caller
// reaches the repo directly, which is exactly what the sweeper arms added this
// week do — the backstop is what stands between one customer and another's
// agent transcripts or proxy credentials.
//
// Drives the REAL repos against real Postgres, because the thing under test is
// the SQL predicate. A fake repo would assert the fake.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import { DrizzleAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const TRANSCRIPT_KEY = Buffer.alloc(32, 11).toString('base64');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let sessions: DrizzleAgentSessionsRepo | null = null;
let proxies: DrizzleAccountProxiesRepo | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM agent_sessions LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
  const db = drizzle(client, { schema });
  const handle = { client, db, close: async () => {} };
  sessions = new DrizzleAgentSessionsRepo(handle, {
    transcriptEncryptionKeyBase64: TRANSCRIPT_KEY,
  });
  proxies = new DrizzleAccountProxiesRepo(handle);
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM account_proxies WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccount(): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seeded.push(accountId);
  await client`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`ownership-${accountId}@test.local`}, 'active')`;
  return accountId;
}

/**
 * Seeded through the repo rather than raw SQL: `transcript` is stored as an
 * encrypted v2 envelope and the read path refuses anything else, so a
 * hand-written INSERT produces a row the repo cannot decode — a fixture failure
 * that looks exactly like a boundary failure.
 */
async function seedSession(accountId: string): Promise<string> {
  if (!sessions) throw new Error('no repo');
  const session = await sessions.create({ accountId, tokenBudgetTotal: 1000 });
  return session.id;
}

async function seedProxy(accountId: string): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO account_proxies (id, account_id, label, scheme, host, port, username)
    VALUES (${id}, ${accountId}, ${`proxy-${id}`}, 'http', 'proxy.test', 8080, 'user')`;
  return id;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'repo methods enforce their own account boundary',
  () => {
    it('CRITICAL the database is reachable. Every case here is a SQL round-trip; if the connection failed they would skip and this file would report success while proving nothing about a cross-account boundary.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL the fixtures are real — victim rows exist and ARE reachable by their true owner. Every check below is an absence; without this positive arm a repo that returned nothing to anyone would satisfy all of them.', async () => {
      const owner = await seedAccount();
      await seedSession(owner);
      const proxyId = await seedProxy(owner);

      expect((await sessions!.listByAccount(owner)).length, 'the owner sees the session').toBe(1);
      expect((await proxies!.list(owner)).length, 'the owner sees the proxy').toBe(1);
      expect(
        (await proxies!.findById({ id: proxyId, accountId: owner }))?.id,
        'and can fetch it by id',
      ).toBe(proxyId);
    });

    it('CRITICAL agent sessions are not listed to another account. `listByAccount` is the read behind the customer-facing session list; without the SQL predicate it returns whatever the caller asks for.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedSession(victim);

      expect(
        await sessions!.listByAccount(attacker),
        'the attacker sees nothing of the victim’s',
      ).toEqual([]);
    });

    it('CRITICAL the paged agent-session read enforces the same boundary as the unpaged one. Two reads of the same table diverging is how a boundary gets fixed in one place and left open in the other.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedSession(victim);

      const page = await sessions!.listPageByAccount(attacker, { limit: 50 });
      expect(page.items, 'the attacker’s page is empty').toEqual([]);
    });

    it('CRITICAL the active-session count is per account. It feeds the concurrency cap, so a count that leaks across accounts lets one customer’s usage exhaust another’s quota.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedSession(victim);

      expect(await sessions!.countActive(attacker), 'the attacker counts none').toBe(0);
    });

    it('CRITICAL proxies are not listed to another account. The rows carry wrapped credentials, so this boundary is the one protecting a customer’s proxy password.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedProxy(victim);

      expect(await proxies!.list(attacker), 'the attacker sees no proxies').toEqual([]);
    });

    it('CRITICAL a proxy cannot be fetched by id from another account. Guessing or leaking an id must not be enough — the id alone is not authorisation.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      const proxyId = await seedProxy(victim);

      expect(
        await proxies!.findById({ id: proxyId, accountId: attacker }),
        'a known id under the wrong account resolves to nothing',
      ).toBeNull();
    });

    it('CRITICAL a proxy cannot be DELETED from another account. This is the irreversible one: without the predicate, an id is enough to destroy another customer’s proxy configuration.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      const proxyId = await seedProxy(victim);

      await proxies!.delete({ id: proxyId, accountId: attacker }).catch(() => undefined);

      expect(
        (await proxies!.list(victim)).length,
        'the victim’s proxy survives an attacker’s delete',
      ).toBe(1);
    });
  },
);

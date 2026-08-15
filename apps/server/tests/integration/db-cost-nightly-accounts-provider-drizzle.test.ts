// Drizzle-backed integration test for DrizzleCostNightlyAccountIdProvider.
//
// One of the last two zero-coverage modules from item 5e, and unlike
// `audit-archive-repo` this one is live: bootstrap.ts:2071 constructs it as the
// account source for the V-541.E nightly cost-recompute job.
//
// The whole module is one query with one predicate, and that predicate is the
// entire contract:
//
//     .where(eq(accounts.status, 'active'))
//
// The source states why in its own comment — suspended and deleted accounts are
// skipped "because their cost summaries would be stale / already-resolved". The
// two failure directions are opposite and both quiet:
//
//   predicate dropped   every suspended and deleted account is re-costed every
//                       night. Deleted accounts are the ones that matter: the
//                       nightly job would keep recomputing spend for customers
//                       who have left, and any alerting hung off those summaries
//                       fires about accounts nobody can act on.
//
//   predicate inverted  the live fleet stops being costed at all, and because
//                       the job still runs, still logs a tick and still writes
//                       summaries for whatever it did select, the failure looks
//                       like "costs are flat" rather than like an outage.
//
// Shared-database discipline: `listAllAccountIds` takes no scope and returns the
// whole active fleet, so every arm filters to accounts this run seeded and
// asserts membership. A count, or any assertion about the fleet as a whole,
// would pass alone and fail in a full run.
//
// MUTATION-PROVED against cost-nightly-accounts-provider.ts — control 6/6 green:
//
//   the active filter dropped        3 red   (suspended and deleted re-costed)
//   the filter inverted to suspended 4 red   (the live fleet stops being costed)
//
// Both directions are covered because only one of them looks like a failure.
// There is no source pin on this module to compare against — it is one of the
// two `src/db` modules the sweep found with neither an importer nor a pin.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleCostNightlyAccountIdProvider } from '../../src/db/cost-nightly-accounts-provider.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let provider: DrizzleCostNightlyAccountIdProvider | null = null;
const seeded: string[] = [];

async function seedAccount(status: 'active' | 'suspended' | 'deleted'): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
    VALUES (${id}, ${`costnightly-${id.slice(0, 8)}@example.test`}, ${'Cost Nightly Fixture'},
            'free'::account_tier, ${status}::account_status, now(), now())`;
  seeded.push(id);
  return id;
}

/** The provider's output, restricted to accounts this run created. */
async function selectedIds(): Promise<string[]> {
  if (!provider) throw new Error('no provider');
  const ids = await provider.listAllAccountIds();
  return ids.filter((id) => seeded.includes(id));
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM accounts LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  provider = new DrizzleCostNightlyAccountIdProvider({
    client,
    db: drizzle(client, { schema }),
    close: async () => {},
  });
});

afterAll(async () => {
  if (client) {
    for (const id of seeded) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleCostNightlyAccountIdProvider (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and the table present').toBe(true);
      expect(provider, 'provider constructed').not.toBeNull();
    });

    it('CRITICAL an active account is in the nightly set. The recompute only ever touches accounts this returns, so an account missing here is simply never costed — and the job reports a normal tick either way.', async () => {
      if (!dbReachable || !provider) return;
      const id = await seedAccount('active');
      expect(await selectedIds(), 'the live account is selected').toContain(id);
    });

    it('CRITICAL a suspended account is excluded. Its cost summary is stale by definition — the account is not running work — so recomputing it every night produces movement on a figure nothing is generating.', async () => {
      if (!dbReachable || !provider) return;
      const id = await seedAccount('suspended');
      expect(await selectedIds(), 'suspended is not re-costed').not.toContain(id);
    });

    it('CRITICAL a deleted account is excluded. This is the one that matters: without the predicate the nightly job keeps recomputing spend for customers who have left, and anything hung off those summaries alerts about accounts nobody can act on.', async () => {
      if (!dbReachable || !provider) return;
      const id = await seedAccount('deleted');
      expect(await selectedIds(), 'deleted is not re-costed').not.toContain(id);
    });

    it('CRITICAL the two exclusions hold at the same time, and the live account still comes back. Asserted together because both exclusion arms above would also pass against a provider that returned nothing at all — which is exactly what the inverted predicate produces, and what would read as "costs are flat" rather than as an outage.', async () => {
      if (!dbReachable || !provider) return;
      const live = await seedAccount('active');
      const suspended = await seedAccount('suspended');
      const deleted = await seedAccount('deleted');

      const ids = await selectedIds();
      expect(ids, 'the live one is still there').toContain(live);
      expect(ids, 'and neither dormant one is').not.toContain(suspended);
      expect(ids, 'nor the deleted one').not.toContain(deleted);
    });

    it('CRITICAL the provider returns bare id strings the job can iterate. The consumer treats each entry as an account id directly, so a row object here would be recomputed against an id of "[object Object]" and silently cost nothing.', async () => {
      if (!dbReachable || !provider) return;
      const id = await seedAccount('active');
      const ids = await provider.listAllAccountIds();
      const mine = ids.find((x) => x === id);
      expect(typeof mine, 'a string, not a row').toBe('string');
      expect(mine, 'and it is the id that was seeded').toBe(id);
    });
  },
);

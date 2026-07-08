// C6 — real-Postgres verification of DrizzleAccountLifecycleRepo.claimBillingEmail.
//
// The claim is an INSERT ... ON CONFLICT (stripe_event_id, kind) DO NOTHING
// RETURNING, whose composite-PK arbiter matching is DB-behaviour that the
// in-memory twin (used by build-test-app + the unit tests) cannot verify — the
// exact "DB-gated code unverified against real infra" trap. This CI-gated test
// runs the actual Drizzle path against a migrated Postgres.
//
// Local dev: skipped unless DATABASE_URL is set. In CI the DB service + migrate
// step run, so an unreachable/unmigrated DB must FAIL, not vacuous-pass.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountLifecycleRepo } from '../../src/db/account-lifecycle-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccountIds: string[] = [];

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
    await client`SELECT 1 FROM billing_email_sends LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const id of seededAccountIds) {
      // cascade clears billing_email_sends via the account_id FK on delete
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleAccountLifecycleRepo.claimBillingEmail (composite-PK ON CONFLICT against real Postgres)',
  () => {
    it('the first claim wins, a duplicate (event, kind) loses, and a different kind wins', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG billing-claim test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAccountLifecycleRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`c6-${accountId}@test.local`})`;

      const eventId = `evt_c6_${accountId}`;
      const now = new Date();

      // First claim for (event, 'billing-receipt') wins.
      const first = await repo.claimBillingEmail({
        stripeEventId: eventId,
        kind: 'billing-receipt',
        accountId,
        at: now,
      });
      expect(first).toBe(true);

      // A duplicate (same event + same kind) — the ON CONFLICT arbiter matches
      // the composite PK → DO NOTHING → no row returned → false.
      const dup = await repo.claimBillingEmail({
        stripeEventId: eventId,
        kind: 'billing-receipt',
        accountId,
        at: now,
      });
      expect(dup).toBe(false);

      // A different kind for the SAME event is a distinct claim → wins.
      const otherKind = await repo.claimBillingEmail({
        stripeEventId: eventId,
        kind: 'billing-failure',
        accountId,
        at: now,
      });
      expect(otherKind).toBe(true);

      // Exactly two rows landed for this event (receipt + failure).
      const rows =
        (await client`SELECT kind FROM billing_email_sends WHERE stripe_event_id = ${eventId} ORDER BY kind`) as unknown as Array<{
          kind: string;
        }>;
      expect(rows.map((r) => r.kind)).toEqual(['billing-failure', 'billing-receipt']);
    });
  },
);

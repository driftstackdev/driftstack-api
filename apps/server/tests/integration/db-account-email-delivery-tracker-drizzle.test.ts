// V-1388 — `createDrizzleAccountEmailDeliveryTracker` against real Postgres.
//
// This is the tracker bootstrap wires (`bootstrap.ts` passes it to
// `createEmailService` as `accountEmailDeliveryTracker`), so it is what runs in
// production. All three of its methods were in the never-executed set: the email
// service's call sites are covered, but only through a test double, so the SQL that
// actually reads and writes `accounts.email_delivery_failed_at` had never run.
//
// The only other reference to it anywhere is `lib-bootstrap-content-parity`, which
// pins the wiring LINE as source text. Text is not effect — the same gap V-1387
// found in the logger's redaction list.
//
// What it costs when this is wrong is asymmetric, which is why the arms below are
// split the way they are:
//
//   `markDeliveryFailed` with a broken WHERE marks EVERY account as undeliverable —
//   the dashboard then tells every customer their address is bouncing.
//   `markDeliveryFailed` writing nothing means a genuinely bouncing address is never
//   flagged, so a customer locked out of password reset gets no signal at all.
//
// Run scope: CI always (postgres:17, migrated). Local dev skips unless a reachable
// DATABASE_URL is set.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleAccountEmailDeliveryTracker } from '../../src/services/email.js';
import type { Database } from '../../src/db/client.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 3 });
  try {
    await client`SELECT email_delivery_failed_at FROM accounts LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const id of seeded) {
    await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'createDrizzleAccountEmailDeliveryTracker (real Postgres)',
  () => {
    const mkTracker = (): ReturnType<typeof createDrizzleAccountEmailDeliveryTracker> => {
      if (!client) throw new Error('no client');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const database: Database = { client, db, close: async () => {} };
      return createDrizzleAccountEmailDeliveryTracker(database);
    };

    async function seedAccount(email: string): Promise<string> {
      if (!client) throw new Error('no client');
      const id = randomUUID();
      seeded.push(id);
      await client`INSERT INTO accounts (id, email, tier, status)
                   VALUES (${id}, ${email}, 'free'::account_tier, 'active')`;
      return id;
    }

    /** Normalised to an ISO string: the driver's timestamptz representation is not the
     *  property under test, and coercing here keeps the arms about the column's value. */
    async function failedAt(id: string): Promise<string | null> {
      if (!client) throw new Error('no client');
      const rows = await client<Array<{ email_delivery_failed_at: unknown }>>`
        SELECT email_delivery_failed_at FROM accounts WHERE id = ${id}`;
      const raw = rows[0]?.email_delivery_failed_at;
      return raw === null || raw === undefined ? null : new Date(raw as string).toISOString();
    }

    it('CRITICAL resolves an account id by email, normalising case and surrounding whitespace. Postmark hands back the address as the remote reported it, so a lookup that matched only the exact stored bytes would fail to attribute the bounce and silently track nothing.', async () => {
      if (!dbReachable) return;
      const email = `tracker-${randomUUID()}@test.local`;
      const id = await seedAccount(email);
      const tracker = mkTracker();

      expect(await tracker.findAccountIdByEmail(email)).toBe(id);
      expect(
        await tracker.findAccountIdByEmail(`  ${email.toUpperCase()}  `),
        'a bounce reported in different case must still find the account',
      ).toBe(id);
      expect(
        await tracker.findAccountIdByEmail(`absent-${randomUUID()}@test.local`),
        'and an address we do not hold resolves to nothing rather than a wrong row',
      ).toBeNull();
    });

    it('CRITICAL marks and clears the delivery-failure stamp on the accounts row, so the column bootstrap wires this tracker to write is actually written. The email service call sites are covered only through a double; this is the SQL.', async () => {
      if (!dbReachable) return;
      const id = await seedAccount(`tracker-${randomUUID()}@test.local`);
      const tracker = mkTracker();
      expect(await failedAt(id), 'a fresh account has no failure stamp').toBeNull();

      const at = new Date('2026-08-01T12:00:00.000Z');
      await tracker.markDeliveryFailed(id, at);
      expect(await failedAt(id), 'the stamp lands with the time given').toBe(at.toISOString());

      await tracker.clearDeliveryFailed(id);
      expect(await failedAt(id), 'and a later success clears it').toBeNull();
    });

    it('CRITICAL both writes are scoped to ONE account. These are bare UPDATEs on `accounts`; a lost or wrong WHERE would mark every customer undeliverable at once — the dashboard then tells all of them their address is bouncing — and on the clear side would erase a real bounce nobody has fixed.', async () => {
      if (!dbReachable) return;
      const target = await seedAccount(`tracker-a-${randomUUID()}@test.local`);
      const bystander = await seedAccount(`tracker-b-${randomUUID()}@test.local`);
      const tracker = mkTracker();

      await tracker.markDeliveryFailed(target, new Date('2026-08-01T12:00:00.000Z'));
      expect(await failedAt(target), 'the target is marked').not.toBeNull();
      expect(await failedAt(bystander), 'the bystander is untouched by the mark').toBeNull();

      // Now the mirror: with BOTH marked, clearing one must leave the other standing.
      await tracker.markDeliveryFailed(bystander, new Date('2026-08-02T12:00:00.000Z'));
      await tracker.clearDeliveryFailed(target);
      expect(await failedAt(target), 'the target is cleared').toBeNull();
      expect(
        await failedAt(bystander),
        'the bystander keeps its own failure — a broad clear would hide a live bounce',
      ).not.toBeNull();
    });
  },
);

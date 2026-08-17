// V-173.R — Drizzle-backed test for DrizzleWebhooksRepo.claim reclaiming
// STALE in_flight rows against a REAL Postgres.
//
// A worker that crashed / was deployed mid-batch leaves rows stuck
// `in_flight` forever — the original claim only selected `pending`, so those
// deliveries were silently lost (skipped every retry). The fix broadens the
// claim to also re-select in_flight rows whose `updated_at` is older than
// RECLAIM_STALE_IN_FLIGHT_MS (5 min, ≫ the 10s per-attempt timeout, so a
// merely-slow delivery isn't reclaimed out from under a live worker). No new
// column — `updated_at` (set to NOW() on claim) is the staleness anchor.
//
// Run scope:
//   - CI: build-test job has postgres at localhost:5432 (migrated); runs here.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
const TEST_SCHEMA = `webhook_claim_reclaim_${randomUUID().replaceAll('-', '')}`;

beforeAll(async () => {
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
    dbReachable = true;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    return;
  }
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  for (const table of [
    'accounts',
    'webhook_endpoints',
    'webhook_deliveries',
    'webhook_delivery_attempts',
  ]) {
    await admin.unsafe(
      `CREATE TABLE "${TEST_SCHEMA}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client.unsafe(`SET search_path TO "${TEST_SCHEMA}", public`);
    const [current] = await client<Array<{ value: string }>>`SELECT current_schema() AS value`;
    expect(current?.value).toBe(TEST_SCHEMA);
    await client`SELECT 1 FROM webhook_deliveries LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleWebhooksRepo.claim — stale in_flight reclaim (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the dependency was reachable, so a green here is not "no service". V-793 — this arm previously sat inside beforeAll, where vitest registers nothing: the assertion existed as text, never ran, and the hole it was written to close stayed open.', () => {
      // Every arm below early-returns when the handle is absent. Without this
      // one, a run against a dead service reports PASSED — a green meaning
      // "nothing was tested", indistinguishable from "the service agreed".
      expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
    });

    it('reclaims a stale in_flight row + a due pending row, but leaves a fresh in_flight row alone', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleWebhooksRepo(
        { client, db, close: async () => {} },
        { secretEncryptionKeyBase64: Buffer.alloc(32, 17).toString('base64') },
      );

      const accountId = randomUUID();
      const webhookId = randomUUID();
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`reclaim-${accountId}@test.local`})`;
      await client`INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events)
        VALUES (${webhookId}, ${accountId}, 'https://example.test/hook', 'whsec_abcdefghijklmnopqrstuvwxyz234567', 'whsec_test',
                ARRAY['session.completed']::webhook_event_type[])`;

      const now = new Date();
      const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
      const oneMinAgo = new Date(now.getTime() - 60 * 1000);

      const insert = async (
        status: string,
        updatedAt: Date,
        nextAttemptAt: Date,
      ): Promise<string> => {
        const [row] = await client!`
          INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, status, updated_at, next_attempt_at)
          VALUES (${webhookId}, ${randomUUID()}, 'session.completed',
                  ${JSON.stringify({ body: '{}', emittedAtSec: 1 })}::text::jsonb,
                  ${status}::webhook_delivery_status, ${updatedAt.toISOString()}, ${nextAttemptAt.toISOString()})
          RETURNING id`;
        return row?.id as string;
      };

      // A: stale in_flight (updated 10 min ago > 5 min threshold) → reclaim.
      const staleInFlight = await insert('in_flight', tenMinAgo, tenMinAgo);
      // B: fresh in_flight (updated now, live worker on it) → must NOT reclaim.
      const freshInFlight = await insert('in_flight', now, now);
      // C: due pending → claimed as usual.
      const duePending = await insert('pending', oneMinAgo, oneMinAgo);

      const claimed = await repo.claim({ batchSize: 10, now });
      const claimedIds = new Set(claimed.map((r) => r.id));

      expect(claimedIds.has(staleInFlight)).toBe(true);
      expect(claimedIds.has(duePending)).toBe(true);
      expect(claimedIds.has(freshInFlight)).toBe(false);

      // The fresh in_flight row is untouched (still in_flight, not re-claimed
      // into this batch); the two claimed rows are now in_flight.
      const [freshRow] =
        await client`SELECT status FROM webhook_deliveries WHERE id = ${freshInFlight}`;
      expect(freshRow?.status).toBe('in_flight');
    });
  },
);

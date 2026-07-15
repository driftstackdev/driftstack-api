// V-173.R — Drizzle-backed test for DurableWebhookWorker.processTick against a
// REAL Postgres. Covers the two correctness gaps the durable worker had vs the
// already-fenced live DrizzleWebhooksRepo path:
//
//   (B) STALE in_flight reclaim. A worker that crashed / was deployed mid-batch
//       leaves a row stuck `in_flight` forever — the original claim only
//       selected `pending`, so those deliveries were silently lost (skipped
//       every retry). processTick now also re-selects in_flight rows whose
//       `updated_at` is older than RECLAIM_STALE_IN_FLIGHT_MS (5 min), and sets
//       `updated_at = now` on the claim so the staleness anchor advances.
//
//   (A) The terminal/retry UPDATEs fence on status = 'in_flight' (review
//       wjf04whfl #1). A >5min-stalled worker whose finalize write lands after
//       another tick reclaimed + finalized the same row matches 0 rows → no-op,
//       so it cannot resurrect a finalized delivery + corrupt its state.
//
// Run scope:
//   - CI: build-test job has postgres at localhost:5432 (migrated); runs here.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDurableWebhookDelivery } from '../../src/services/durable-webhook-delivery.js';
import { webhookDeliveries } from '../../src/db/schema.js';
import type { Database } from '../../src/db/client.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
const TEST_SCHEMA = `webhook_reclaim_fence_${randomUUID().replaceAll('-', '')}`;

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
  'DurableWebhookWorker.processTick — stale in_flight reclaim + terminal fence (Drizzle path against real Postgres)',
  () => {
    async function seedEndpoint(): Promise<{
      accountId: string;
      webhookId: string;
      database: Database;
    }> {
      const accountId = randomUUID();
      const webhookId = randomUUID();
      await client!`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`fence-${accountId}@test.local`})`;
      await client!`INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events)
        VALUES (${webhookId}, ${accountId}, 'https://example.test/hook', 'whsec_test_secret', 'whsec_test',
                ARRAY['session.completed']::webhook_event_type[])`;
      const db = drizzle(client!) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const database: Database = { client: client!, db, close: () => Promise.resolve() };
      return { accountId, webhookId, database };
    }

    async function insertDelivery(
      webhookId: string,
      status: string,
      updatedAt: Date,
      nextAttemptAt: Date,
    ): Promise<string> {
      const [row] = await client!`
        INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, status, updated_at, next_attempt_at)
        VALUES (${webhookId}, ${randomUUID()}, 'session.completed',
                ${JSON.stringify({ body: '{}', emittedAtSec: 1 })}::jsonb,
                ${status}::webhook_delivery_status, ${updatedAt.toISOString()}, ${nextAttemptAt.toISOString()})
        RETURNING id`;
      return row?.id as string;
    }

    it('reclaims a stale in_flight row + delivers it; leaves a fresh in_flight row alone', async () => {
      if (!dbReachable || !client) return;
      const { webhookId, database } = await seedEndpoint();

      const now = new Date();
      const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);

      // A: stale in_flight (updated 10 min ago > 5 min threshold) → reclaim+deliver.
      const staleInFlight = await insertDelivery(webhookId, 'in_flight', tenMinAgo, tenMinAgo);
      // B: fresh in_flight (a live worker on it) → must NOT reclaim.
      const freshInFlight = await insertDelivery(webhookId, 'in_flight', now, now);

      const okFetch: typeof fetch = () => Promise.resolve(new Response('ok', { status: 200 }));

      const handles = createDurableWebhookDelivery({
        database,
        fetch: okFetch,
        now: () => now.getTime(),
      });
      const result = await handles.processTick({ batchSize: 10 });

      // The stale row was reclaimed and delivered; the fresh one was not touched.
      expect(result.pulled).toBe(1);
      expect(result.delivered).toBe(1);

      const [staleRow] =
        await client`SELECT status FROM webhook_deliveries WHERE id = ${staleInFlight}`;
      expect(staleRow?.status).toBe('delivered');

      const [freshRow] =
        await client`SELECT status FROM webhook_deliveries WHERE id = ${freshInFlight}`;
      expect(freshRow?.status).toBe('in_flight');
    });

    it('a stale worker cannot resurrect a finalized delivery — the terminal UPDATE is fenced on status=in_flight (0-row no-op)', async () => {
      if (!dbReachable || !client) return;
      const { webhookId, database } = await seedEndpoint();

      const now = new Date();

      // The race: a >5min-stalled worker still believes it owns a row it claimed
      // in_flight, but another tick reclaimed + finalized it to `delivered`. The
      // stalled worker now issues its late terminal write. This replays that
      // exact write — the same fenced UPDATE shape the worker's deliver() uses
      // (eq(id) AND eq(status,'in_flight')) — against the already-delivered row.
      // The fence makes it match 0 rows, so the finalized state is untouched.
      const finalized = await insertDelivery(webhookId, 'delivered', now, now);

      const fenced = await database.db
        .update(webhookDeliveries)
        .set({
          status: 'dlq',
          attempts: 6,
          lastError: 'stale worker late write',
          updatedAt: now,
        })
        .where(and(eq(webhookDeliveries.id, finalized), eq(webhookDeliveries.status, 'in_flight')))
        .returning({ id: webhookDeliveries.id });

      // 0 rows updated → the late write was a no-op (the worker treats this as
      // an early-return, never bumping the metric / corrupting the row).
      expect(fenced.length).toBe(0);

      const [row] =
        await client`SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = ${finalized}`;
      expect(row?.status).toBe('delivered');
      expect(Number(row?.attempts)).toBe(0);
      expect(row?.last_error).toBeNull();
    });

    it('the in_flight claim advances updated_at so a just-reclaimed row is not re-reclaimed on the next tick', async () => {
      if (!dbReachable || !client) return;
      const { webhookId, database } = await seedEndpoint();

      const t0 = new Date();
      const tenMinAgo = new Date(t0.getTime() - 10 * 60 * 1000);
      const stale = await insertDelivery(webhookId, 'in_flight', tenMinAgo, tenMinAgo);

      // First tick: the endpoint errors → the row goes back to pending (retry),
      // but critically the claim stamped updated_at = now first.
      const failFetch: typeof fetch = () => Promise.reject(new Error('endpoint down'));
      const handles = createDurableWebhookDelivery({
        database,
        fetch: failFetch,
        now: () => t0.getTime(),
      });
      const first = await handles.processTick({ batchSize: 10 });
      expect(first.pulled).toBe(1);
      expect(first.retried).toBe(1);

      // The row is pending again with a future next_attempt_at (backoff), so a
      // second tick at the same clock does not re-pull it.
      const second = await handles.processTick({ batchSize: 10 });
      expect(second.pulled).toBe(0);

      const [row] = await client`SELECT status FROM webhook_deliveries WHERE id = ${stale}`;
      expect(row?.status).toBe('pending');
    });

    it('replay() rejects an in_flight delivery instead of clobbering its lease (audit fix 2026-07-01)', async () => {
      if (!dbReachable || !client) return;
      const { webhookId, database } = await seedEndpoint();
      const now = new Date();
      const inFlight = await insertDelivery(webhookId, 'in_flight', now, now);

      const handles = createDurableWebhookDelivery({
        database,
        fetch: () => Promise.resolve(new Response('ok', { status: 200 })),
        now: () => now.getTime(),
      });

      await expect(handles.deliveries.replay(inFlight)).rejects.toThrow(/in_flight/);

      // The row is untouched — still in_flight, not reset to pending.
      const [row] = await client`SELECT status FROM webhook_deliveries WHERE id = ${inFlight}`;
      expect(row?.status).toBe('in_flight');
    });

    it("replay() succeeds on 'failed' and 'delivered' deliveries (the documented-eligible statuses, no regression)", async () => {
      if (!dbReachable || !client) return;
      const { webhookId, database } = await seedEndpoint();
      const now = new Date();
      const failed = await insertDelivery(webhookId, 'failed', now, now);
      const delivered = await insertDelivery(webhookId, 'delivered', now, now);

      const handles = createDurableWebhookDelivery({
        database,
        fetch: () => Promise.resolve(new Response('ok', { status: 200 })),
        now: () => now.getTime(),
      });

      const r1 = await handles.deliveries.replay(failed);
      expect(r1.status).toBe('pending');
      const r2 = await handles.deliveries.replay(delivered);
      expect(r2.status).toBe('pending');
    });

    it("requeue() rejects a non-'dlq' delivery instead of clobbering it (audit fix 2026-07-01)", async () => {
      if (!dbReachable || !client) return;
      const { webhookId, database } = await seedEndpoint();
      const now = new Date();
      const inFlight = await insertDelivery(webhookId, 'in_flight', now, now);

      const handles = createDurableWebhookDelivery({
        database,
        fetch: () => Promise.resolve(new Response('ok', { status: 200 })),
        now: () => now.getTime(),
      });

      await expect(handles.dlq.requeue({ deliveryId: inFlight })).rejects.toThrow(/dlq/);

      const [row] = await client`SELECT status FROM webhook_deliveries WHERE id = ${inFlight}`;
      expect(row?.status).toBe('in_flight');
    });

    it("requeue() succeeds on a genuinely 'dlq' delivery (no regression)", async () => {
      if (!dbReachable || !client) return;
      const { webhookId, database } = await seedEndpoint();
      const now = new Date();
      const dlqRow = await insertDelivery(webhookId, 'dlq', now, now);

      const handles = createDurableWebhookDelivery({
        database,
        fetch: () => Promise.resolve(new Response('ok', { status: 200 })),
        now: () => now.getTime(),
      });

      const requeued = await handles.dlq.requeue({ deliveryId: dlqRow });
      expect(requeued.status).toBe('pending');
    });
  },
);

// V-771 — requeue and replay must reset the retry BUDGET, against a REAL Postgres.
//
// `DlqManager.requeue` documents "Resets attempt counter; new attempts append to the existing
// attempt log so postmortem stays intact", `WebhookDeliveryService.replay` documents "Resets
// attempts", and the admin panel tells a staff operator "delivery resets to attempt=1 + retry
// budget refreshes". The durable implementation set only status / nextAttemptAt / deliveredAt
// and left the `attempts` counter alone — the counter the worker gates on
// (`attemptNumber = delivery.attempts + 1` against DEFAULT_MAX_ATTEMPTS = 6).
//
// So a DLQ'd delivery requeued after six failures got ONE more attempt with no backoff curve,
// and replaying a row that failed on attempt 6 sent it back to DLQ on its first failure. For an
// operator recovering webhooks from a customer endpoint that is still flapping, that is the
// difference between a real retry budget and a single shot — while the screen in front of them
// says the budget refreshed.
//
// Latent rather than live: the currently-wired path is `webhooks-repo.resetDeliveryToPending`,
// which does set `attempts: 0`. This is the V-173 forward path. Pinned here so the cutover
// cannot ship the wrong behaviour.
//
// The two assertions are deliberately separate: the counter resets, AND the attempt log does
// not — "resets the budget" and "keeps the postmortem" are both halves of the contract, and a
// fix that truncated the log would satisfy the first while destroying the second.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDurableWebhookDelivery } from '../../src/services/durable-webhook-delivery.js';
import type { Database } from '../../src/db/client.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const TEST_SCHEMA = `wh_requeue_${randomUUID().replaceAll('-', '')}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;
let reachable = false;

const NOW = new Date('2026-08-14T12:00:00.000Z');

beforeAll(async () => {
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
    reachable = true;
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
  // Built once, before seeding: drizzle rewrites this client's timestamp/jsonb serializers.
  db = drizzle(client);
  try {
    await client.unsafe(`SET search_path TO "${TEST_SCHEMA}", public`);
    await client`SELECT 1 FROM webhook_deliveries LIMIT 0`;
  } catch {
    reachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'requeue/replay reset the retry budget (V-771, real Postgres)',
  () => {
    async function seed(status: string, attempts: number): Promise<string> {
      const accountId = randomUUID();
      await client!`
        INSERT INTO accounts (id, email, tier, status)
        VALUES (${accountId}, ${`w-${accountId}@t.test`}, 'api_scale', 'active')`;
      const [ep] = await client!`
        INSERT INTO webhook_endpoints (account_id, url, secret, secret_prefix, events)
        VALUES (${accountId}, 'https://customer.example/hook', 'whsec_test', 'whsec_te',
                ARRAY['session.completed']::webhook_event_type[])
        RETURNING id`;
      const [row] = await client!`
        INSERT INTO webhook_deliveries
          (webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at)
        VALUES (${ep!.id as string}, ${randomUUID()}, 'session.completed',
                ${JSON.stringify({ body: '{}', emittedAtSec: 1 })}::text::jsonb,
                ${status}::webhook_delivery_status, ${attempts},
                ${NOW.toISOString()})
        RETURNING id`;
      const deliveryId = row!.id as string;
      // Six real attempt rows — the postmortem log the contract promises to preserve.
      for (let i = 1; i <= attempts; i += 1) {
        await client!`
          INSERT INTO webhook_delivery_attempts
            (delivery_id, attempt_number, completed_at_ms, duration_ms, outcome, error_message)
          VALUES (${deliveryId}, ${i}, ${NOW.getTime()}, 12, 'failed',
                  ${`connection refused (attempt ${String(i)})`})`;
      }
      return deliveryId;
    }

    function handles() {
      const database = { client: client!, db: db!, close: async () => {} } as unknown as Database;
      return createDurableWebhookDelivery({ database, now: () => NOW.getTime() });
    }

    async function read(id: string): Promise<{ attempts: number; status: string; log: number }> {
      const [d] = await client!<Array<{ attempts: number; status: string }>>`
        SELECT attempts, status FROM webhook_deliveries WHERE id = ${id}`;
      const [c] = await client!<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM webhook_delivery_attempts WHERE delivery_id = ${id}`;
      return { attempts: d!.attempts, status: d!.status, log: Number(c!.n) };
    }

    it('CRITICAL requeue resets the counter to 0 — the worker gates on attempts + 1 against a max of 6, so leaving it at 6 gave a requeued delivery a single shot while the admin panel promised a refreshed budget', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const id = await seed('dlq', 6);

      await handles().dlq.requeue({ deliveryId: id });

      const after = await read(id);
      expect(after.attempts, 'the retry budget must be fresh').toBe(0);
      expect(after.status).toBe('pending');
      // ...and the postmortem survives: "new attempts append to the existing attempt log".
      expect(after.log, 'the attempt log must NOT be truncated').toBe(6);
    });

    it('CRITICAL replay resets the counter too — a delivery that failed on attempt 6 would otherwise be returned to DLQ by its first replay failure', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const id = await seed('failed', 6);

      await handles().deliveries.replay(id);

      const after = await read(id);
      expect(after.attempts).toBe(0);
      expect(after.status).toBe('pending');
      expect(after.log).toBe(6);
    });
  },
);

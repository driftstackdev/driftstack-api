// Drizzle-backed integration test: `webhook_endpoints.consecutive_failures` is a
// per-DELIVERY counter, against a REAL Postgres.
//
// Why this exists. The customer contract states it twice:
//   - webhooks/endpoints.md — "`consecutive_failures` increments on each failed
//     delivery + zeros on the next success"
//   - webhooks/events.md — "auto-disabled after 50 consecutive failed deliveries
//     … Monitor the `consecutive_failures` field on GET /v1/webhooks to catch a
//     drifting endpoint before it trips the auto-disable threshold"
//
// recordRetry used to increment it too. A retry is an ATTEMPT inside one delivery
// and MAX_ATTEMPTS is 6, so one failed delivery counted up to six times: the
// endpoint tombstoned after roughly 9 failed deliveries instead of 50, and that
// tombstone is sticky — a customer must mint a new endpoint. Someone watching the
// exact signal the docs point them at, during a brief receiver outage, lost the
// endpoint permanently and ~6x sooner than the headroom they were promised.
//
// This lives against real Postgres deliberately: the increment is SQL inside
// recordRetry/recordDlq, so the worker's fake-repo unit tests structurally cannot
// see it — they passed both before and after the fix.
//
// Run scope: CI always (postgres:17-alpine, migrated). Local dev skips unless a
// reachable DATABASE_URL is set.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleWebhooksRepo | null = null;
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
    await client`SELECT 1 FROM webhook_endpoints LIMIT 0`;
    await client`SELECT 1 FROM webhook_deliveries LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleWebhooksRepo({ db: drizzle(client, { schema }) } as never);
});

afterAll(async () => {
  if (client) {
    for (const id of seededAccountIds) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

/** Seed an account + endpoint, and one in_flight delivery on it. */
async function seed(): Promise<{ endpointId: string; deliveryId: string }> {
  const c = client!;
  const accountId = randomUUID();
  seededAccountIds.push(accountId);
  await c`
    INSERT INTO accounts (id, email, name, tier, status)
    VALUES (${accountId}, ${`wh-${accountId}@drift.test`}, 'Seeded', 'api_builder', 'active')`;
  const endpointId = randomUUID();
  await c`
    INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events, active)
    VALUES (${endpointId}, ${accountId}, 'https://receiver.example/hook',
            'driftstack:webhook-secret:v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'whsec_te', ARRAY['session.completed']::webhook_event_type[], true)`;
  const deliveryId = randomUUID();
  await c`
    INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, attempts)
    VALUES (${deliveryId}, ${endpointId}, ${randomUUID()}, 'session.completed',
            ${'{}'}::jsonb, 'in_flight', 0)`;
  return { endpointId, deliveryId };
}

async function failuresOf(endpointId: string): Promise<number> {
  const rows = await client!<{ n: number }[]>`
    SELECT consecutive_failures AS n FROM webhook_endpoints WHERE id = ${endpointId}`;
  return rows[0]!.n;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'webhook_endpoints.consecutive_failures counts DELIVERIES, not attempts',
  () => {
    it('a retried attempt does not advance the customer-facing failure counter', async () => {
      if (!dbReachable || repo === null) return;
      const { endpointId, deliveryId } = await seed();
      expect(await failuresOf(endpointId)).toBe(0);

      await repo.recordRetry(deliveryId, {
        attempts: 1,
        nextAttemptAt: new Date(Date.now() + 1000),
        responseStatus: 500,
        responseExcerpt: 'boom',
        lastError: 'HTTP 500',
      });

      // The delivery has NOT failed yet — it is scheduled to retry. Counting it
      // here is what made 50 documented deliveries land at roughly 9.
      expect(await failuresOf(endpointId)).toBe(0);
    });

    it('exhausting a delivery advances it exactly once', async () => {
      if (!dbReachable || repo === null) return;
      const { endpointId, deliveryId } = await seed();

      await repo.recordDlq(deliveryId, {
        responseStatus: 500,
        lastError: 'HTTP 500',
        at: new Date(),
      });

      expect(await failuresOf(endpointId)).toBe(1);
    });

    it('a whole delivery lifecycle — five retries then DLQ — counts as ONE failed delivery', async () => {
      if (!dbReachable || repo === null) return;
      const { endpointId, deliveryId } = await seed();

      for (let attempt = 1; attempt <= 5; attempt++) {
        await client!`UPDATE webhook_deliveries SET status = 'in_flight' WHERE id = ${deliveryId}`;
        await repo.recordRetry(deliveryId, {
          attempts: attempt,
          nextAttemptAt: new Date(Date.now() + 1000),
          responseStatus: 500,
          responseExcerpt: 'boom',
          lastError: 'HTTP 500',
        });
      }
      await client!`UPDATE webhook_deliveries SET status = 'in_flight' WHERE id = ${deliveryId}`;
      await repo.recordDlq(deliveryId, {
        responseStatus: 500,
        lastError: 'HTTP 500',
        at: new Date(),
      });

      // MAX_ATTEMPTS is 6, so the old per-attempt increment made this 6. At the
      // documented threshold of 50 that is the difference between an endpoint
      // surviving 50 failed deliveries and being permanently tombstoned after 9.
      expect(await failuresOf(endpointId)).toBe(1);
    });

    it('a success still zeroes the counter, as documented', async () => {
      if (!dbReachable || repo === null) return;
      const { endpointId, deliveryId } = await seed();
      await repo.recordDlq(deliveryId, {
        responseStatus: 500,
        lastError: 'HTTP 500',
        at: new Date(),
      });
      expect(await failuresOf(endpointId)).toBe(1);

      const second = randomUUID();
      await client!`
        INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, attempts)
        VALUES (${second}, ${endpointId}, ${randomUUID()}, 'session.completed',
                ${'{}'}::jsonb, 'in_flight', 1)`;
      await repo.recordDelivered(second, { responseStatus: 200, at: new Date() });

      expect(await failuresOf(endpointId)).toBe(0);
    });
  },
);

// V-1276 — ONE contract for the three delivery-outcome writers, against BOTH implementations of
// `WebhooksRepo`.
//
// This file is the structure V-1274c said was missing. `recordDelivered`, `recordRetry` and
// `recordDlq` carry two invariants that the customer sees directly, and until now each was asserted
// on one side only: the counter semantics lived in a Drizzle-only integration test, and the worker's
// unit arms drove the in-memory double. So when the Drizzle repo stopped counting retries as failed
// deliveries, nothing failed — the double went on incrementing, and every worker arm standing on it
// was calibrated against a counter production no longer keeps. The divergence survived because no
// single arm ran against both.
//
// THE TWO INVARIANTS.
//
//   consecutive_failures counts DELIVERIES, not attempts. The docs state it twice — "increments on
//   each failed delivery + zeros on the next success" (webhooks/endpoints.md) and "auto-disabled
//   after 50 consecutive failed deliveries … Monitor the `consecutive_failures` field"
//   (webhooks/events.md). A retry is an ATTEMPT inside one delivery and MAX_ATTEMPTS is 6, so
//   counting retries billed one failed delivery up to six times: the endpoint tombstoned after
//   roughly 9 failed deliveries rather than 50, stickily, and the customer watching the exact field
//   they were pointed at lost the endpoint ~6x sooner than promised.
//
//   The writers FENCE on in_flight. The worker only writes for a row it claimed, so a >5-minute
//   stalled worker's late report — arriving after another tick reclaimed and finalised the row —
//   must be a no-op. Without the fence it resurrects a delivered delivery into the DLQ and advances
//   its endpoint toward an auto-disable it never earned.
//
// WHY THE ARRANGEMENT IS A SUBJECT SEAM AND NOT `claim()`. Both invariants need a delivery that is
// already in_flight, and the obvious way to get one is to claim it. That is safe on the double,
// whose state is process-local, but Drizzle's claim selects due rows across the WHOLE
// `webhook_deliveries` table — it would claim rows belonging to every other file running
// concurrently and finalise them here. So each subject arranges an in_flight delivery its own way,
// and only the BEHAVIOUR under test goes through the shared interface.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WebhooksRepo } from '../../src/services/webhooks.js';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { InMemoryWebhooksRepo } from './_helpers/in-memory-webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seededAccounts: string[] = [];
const seededEndpoints: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM webhook_deliveries LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const id of seededEndpoints) {
      await client`DELETE FROM webhook_deliveries WHERE webhook_id = ${id}::uuid`.catch(() => {});
      await client`DELETE FROM webhook_endpoints WHERE id = ${id}::uuid`.catch(() => {});
    }
    for (const id of seededAccounts) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: WebhooksRepo;
  /** An endpoint with a zeroed failure counter. */
  endpoint: () => Promise<string>;
  /** A delivery for that endpoint, already claimed — the only state the writers act on. */
  inFlightDelivery: (endpointId: string) => Promise<string>;
  /** Put a requeued delivery back in_flight, as the next worker tick's claim would. */
  reclaim: (deliveryId: string) => Promise<void>;
}

function endpointInput(accountId: string): Parameters<WebhooksRepo['insertEndpoint']>[0] {
  return {
    accountId,
    url: 'https://receiver.example/hook',
    secret: 'whsec_abcdefghijklmnopqrstuvwxyz234567',
    secretPrefix: 'whsec_te',
    events: ['session.completed'],
    description: null,
  };
}

function deliveryInput(webhookId: string): Parameters<WebhooksRepo['enqueueDelivery']>[0] {
  const eventId = randomUUID();
  return {
    webhookId,
    eventId,
    eventType: 'session.completed',
    payload: { id: eventId, type: 'session.completed', data: {} },
  };
}

function inMemorySubject(): Subject {
  const repo = new InMemoryWebhooksRepo();
  return {
    repo,
    endpoint: async () => (await repo.insertEndpoint(endpointInput(randomUUID()))).id,
    // Safe here precisely because it is NOT safe on the other side: this repo's state is
    // process-local, so a claim can only ever see the rows this subject enqueued.
    inFlightDelivery: async (endpointId) => {
      const id = await repo.enqueueDelivery(deliveryInput(endpointId));
      await repo.claim({ batchSize: 32, now: new Date() });
      return id;
    },
    // Far enough forward that a backoff scheduled a minute out is due.
    reclaim: async () => {
      await repo.claim({ batchSize: 32, now: new Date(Date.now() + 10 * 60_000) });
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  const repo = new DrizzleWebhooksRepo(
    { client: c, db, close: async () => {} },
    { secretEncryptionKeyBase64: ENCRYPTION_KEY },
  );
  return {
    repo,
    endpoint: async () => {
      const accountId = randomUUID();
      seededAccounts.push(accountId);
      await c`INSERT INTO accounts (id, email)
              VALUES (${accountId}, ${`whoutcome-${accountId}@test.local`})`;
      const row = await repo.insertEndpoint(endpointInput(accountId));
      seededEndpoints.push(row.id);
      return row.id;
    },
    // Written straight to in_flight rather than claimed: DrizzleWebhooksRepo.claim takes due rows
    // from the whole table, so claiming here would reach into every other file's deliveries.
    inFlightDelivery: async (endpointId) => {
      const id = randomUUID();
      const eventId = randomUUID();
      await c`INSERT INTO webhook_deliveries
                (id, webhook_id, event_id, event_type, payload, status, attempts)
              VALUES (${id}::uuid, ${endpointId}::uuid, ${eventId}::uuid, 'session.completed',
                      ${'{}'}::jsonb, 'in_flight', 0)`;
      return id;
    },
    reclaim: async (deliveryId) => {
      await c`UPDATE webhook_deliveries SET status = 'in_flight' WHERE id = ${deliveryId}::uuid`;
    },
  };
}

const failuresOf = async (s: Subject, endpointId: string): Promise<number | undefined> =>
  (await s.repo.findEndpointById(endpointId))?.consecutiveFailures;

const statusOf = async (s: Subject, deliveryId: string): Promise<string | undefined> =>
  (await s.repo.findDeliveryById(deliveryId))?.status;

function deliveryOutcomeContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`WebhooksRepo delivery-outcome contract — ${label}`, () => {
    it('CRITICAL the arrangement really produces an in_flight delivery on a zeroed endpoint, in both. Every arm below is about what happens to a claimed row, so an arrangement that quietly produced a pending one would make the fence arms pass by describing the wrong situation — and the counter arms would be measuring a no-op.', async () => {
      if (!enabled()) return;
      const s = make();
      const endpointId = await s.endpoint();
      const deliveryId = await s.inFlightDelivery(endpointId);

      expect(await statusOf(s, deliveryId), 'the delivery was not left in_flight').toBe(
        'in_flight',
      );
      expect(await failuresOf(s, endpointId), 'the endpoint did not start at zero failures').toBe(
        0,
      );
    });

    it('CRITICAL a RETRY does not advance consecutive_failures, in both. The delivery has not failed — it is scheduled to try again. Counting it here is what turned the documented fifty failed deliveries into roughly nine, and the double kept doing it for as long as no arm ran against both sides.', async () => {
      if (!enabled()) return;
      const s = make();
      const endpointId = await s.endpoint();
      const deliveryId = await s.inFlightDelivery(endpointId);

      await s.repo.recordRetry(deliveryId, {
        responseStatus: 500,
        responseExcerpt: 'boom',
        lastError: 'HTTP 500',
        attempts: 1,
        nextAttemptAt: new Date(Date.now() + 60_000),
      });

      expect(
        await failuresOf(s, endpointId),
        'a retry advanced the customer-facing failure counter',
      ).toBe(0);
      expect(await statusOf(s, deliveryId), 'the retry did not requeue the delivery').toBe(
        'pending',
      );
    });

    it('CRITICAL a DLQ advances consecutive_failures exactly once, in both. This is the point at which a delivery has definitively failed, so it is the one write that owns the increment.', async () => {
      if (!enabled()) return;
      const s = make();
      const endpointId = await s.endpoint();
      const deliveryId = await s.inFlightDelivery(endpointId);

      await s.repo.recordDlq(deliveryId, {
        responseStatus: 500,
        lastError: 'HTTP 500',
        at: new Date(),
      });

      expect(await failuresOf(s, endpointId), 'the failed delivery did not count once').toBe(1);
      expect(await statusOf(s, deliveryId), 'the delivery did not reach the DLQ').toBe('dlq');
    });

    it('CRITICAL a whole lifecycle — five retries then a DLQ — counts as ONE failed delivery, in both. This is the arm that fails loudest if either side starts counting attempts: six writes for one delivery, and the counter must read 1.', async () => {
      if (!enabled()) return;
      const s = make();
      const endpointId = await s.endpoint();
      const deliveryId = await s.inFlightDelivery(endpointId);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await s.repo.recordRetry(deliveryId, {
          responseStatus: 500,
          responseExcerpt: null,
          lastError: 'HTTP 500',
          attempts: attempt,
          nextAttemptAt: new Date(Date.now() + 60_000),
        });
        // A retry requeues the row, and the writers only act on a claimed one — so the next
        // attempt is preceded by the claim the worker would really make.
        await s.reclaim(deliveryId);
      }
      await s.repo.recordDlq(deliveryId, {
        responseStatus: 500,
        lastError: 'HTTP 500',
        at: new Date(),
      });

      expect(
        await failuresOf(s, endpointId),
        'six writes for ONE delivery did not count as one failed delivery',
      ).toBe(1);
    });

    it('CRITICAL a SUCCESS zeroes consecutive_failures, in both. Without the reset an endpoint that failed forty-nine times, then delivered cleanly for a month, is tombstoned by its next single failure.', async () => {
      if (!enabled()) return;
      const s = make();
      const endpointId = await s.endpoint();

      const failed = await s.inFlightDelivery(endpointId);
      await s.repo.recordDlq(failed, {
        responseStatus: 500,
        lastError: 'HTTP 500',
        at: new Date(),
      });
      expect(await failuresOf(s, endpointId), 'the failed delivery did not count').toBe(1);

      const ok = await s.inFlightDelivery(endpointId);
      await s.repo.recordDelivered(ok, { responseStatus: 200, at: new Date() });

      expect(
        await failuresOf(s, endpointId),
        'a successful delivery did not zero the counter',
      ).toBe(0);
    });

    it('CRITICAL a late write from a stalled worker is a NO-OP once the row is finalised, in both. The writers fence on in_flight because the worker only writes for a row it claimed: a >5-minute-stalled worker reporting failure after another tick reclaimed and delivered that row must not resurrect it into the DLQ, and must not push its endpoint toward an auto-disable the endpoint never earned.', async () => {
      if (!enabled()) return;
      const s = make();
      const endpointId = await s.endpoint();
      const deliveryId = await s.inFlightDelivery(endpointId);
      await s.repo.recordDelivered(deliveryId, { responseStatus: 200, at: new Date() });

      await s.repo.recordDlq(deliveryId, {
        responseStatus: 500,
        lastError: 'HTTP 500',
        at: new Date(),
      });

      expect(
        await statusOf(s, deliveryId),
        'a stale write resurrected a delivered row into the DLQ',
      ).toBe('delivered');
      expect(
        await failuresOf(s, endpointId),
        'a stale write advanced the endpoint toward auto-disable',
      ).toBe(0);
    });

    it('CRITICAL a write for a delivery nobody claimed is a NO-OP, in both. The pending state is the one the fence exists to protect: a record* that lands on an unclaimed row is a write from a worker that never held it, and honouring it lets a test — or a caller — arrange a state the real repo refuses.', async () => {
      if (!enabled()) return;
      const s = make();
      const endpointId = await s.endpoint();
      const deliveryId = await s.inFlightDelivery(endpointId);
      // Back to pending, and NOT re-claimed.
      await s.repo.recordRetry(deliveryId, {
        responseStatus: 500,
        responseExcerpt: null,
        lastError: 'HTTP 500',
        attempts: 1,
        nextAttemptAt: new Date(Date.now() + 60_000),
      });
      expect(await statusOf(s, deliveryId), 'the row was not left pending').toBe('pending');

      await s.repo.recordDlq(deliveryId, {
        responseStatus: 500,
        lastError: 'HTTP 500',
        at: new Date(),
      });

      expect(await statusOf(s, deliveryId), 'an unclaimed delivery was moved to the DLQ').toBe(
        'pending',
      );
      expect(
        await failuresOf(s, endpointId),
        'an unclaimed delivery advanced the failure counter',
      ).toBe(0);
    });
  });
}

deliveryOutcomeContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'WebhooksRepo delivery-outcome contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty. A run against a dead service otherwise reports PASSED — a green meaning "nothing was tested", indistinguishable from "the database agreed".', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    deliveryOutcomeContract('drizzle', drizzleSubject, () => dbReachable);
  },
);

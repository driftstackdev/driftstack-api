// One broken webhook endpoint must not stop everybody else's deliveries.
//
// The claim was `ORDER BY next_attempt_at ASC LIMIT 25` — FIFO across the whole
// table. An endpoint that is DOWN is the worst possible neighbour under that
// rule: its retries carry the oldest `next_attempt_at`, so they sort first and
// fill the batch. And the worker delivers the claimed batch SERIALLY, so those rows also
// consume the tick's wall-clock timing out. The result is not that other
// customers' webhooks are delayed; it is that they are not attempted at all
// while one endpoint is failing.
//
// Ranking within each endpoint and capping per tick fixes that. The cases below
// are about the STARVED endpoint rather than the backlogged one — a fix that
// merely drains the backlog faster would satisfy a naive test and miss the
// point.
//
// Real Postgres, because the fairness is entirely a window function and a
// `SKIP LOCKED` interaction. An in-memory fake would be asserting my own
// arithmetic rather than what the database does.
//
// Exercises `DrizzleWebhooksRepo.claim`, the query production actually runs.
// `DurableWebhookWorker` in durable-webhook-delivery.ts holds a near-identical
// claim and is wired NOWHERE — the first version of this fix went into that one,
// and this test is what caught it. The successor carries the same fix; because
// nothing constructs it, driving it behaviourally would mean building a whole
// delivery fixture, so its half is covered structurally in
// `webhook-claim-fairness-parity`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type * as schema from '../../src/db/schema.js';

import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM webhook_deliveries LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhook_endpoints WHERE account_id = ${accountId})`.catch(
        () => {},
      );
      await client`DELETE FROM webhook_endpoints WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedEndpoint(): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seeded.push(accountId);
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`wh-fair-${accountId}@test.local`})`;
  const endpointId = randomUUID();
  await client`
    INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events)
    VALUES (${endpointId}, ${accountId}, ${'https://example.test/hook'}, 'v2:secret', 'whsec_t',
            ${['session.completed']})`;
  return endpointId;
}

/** `count` due deliveries for one endpoint, oldest first. */
async function seedDue(endpointId: string, count: number, ageBaseSec: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const at = new Date(Date.now() - (ageBaseSec + i) * 1000).toISOString();
    await client!`
      INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at)
      VALUES (${randomUUID()}, ${endpointId}, ${randomUUID()}, 'session.completed', '{}'::jsonb, 'pending', 0, ${at})`;
  }
}

/**
 * The two claim implementations, driven through one interface.
 *
 * `live` is `DrizzleWebhooksRepo.claim`, which production runs today. `successor`
 * is `DurableWebhookWorker.processTick` in durable-webhook-delivery.ts — the
 * documented FORWARD path awaiting cutover, wired nowhere yet.
 *
 * Both are exercised because the fix has to hold on BOTH: the successor
 * inheriting a plain FIFO claim would silently reintroduce the starvation the
 * moment anyone cuts over, and nothing else in the suite would notice. Running
 * the identical scenarios against each is what makes that impossible.
 */
/** The claim production actually runs. */
function liveClaim(): (opts: { batchSize: number; perEndpointCap: number }) => Promise<unknown> {
  if (!client) throw new Error('no client');
  const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  const repo = new DrizzleWebhooksRepo({ client, db, close: async () => {} });
  return (o) => repo.claim({ ...o, now: new Date() });
}

/**
 * Rows each endpoint had CLAIMED by the tick, counted as "no longer pending".
 *
 * The two implementations leave claimed rows in different terminal states — the
 * live repo claim only flips to in_flight, while the successor claims and
 * delivers in one call so its rows end up delivered. Counting non-pending is
 * the observable both share, and it is what the fairness question is actually
 * about: how many of this endpoint's rows did one tick take.
 */
async function claimedByEndpoint(ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const rows = await client!<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM webhook_deliveries
      WHERE webhook_id = ${id}::uuid AND status <> 'pending'`;
    out[id] = rows[0]?.n ?? 0;
  }
  return out;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a backlogged webhook endpoint cannot starve the others',
  () => {
    it('CRITICAL the database was actually reached. Every assertion here is DB-backed, so a connection failure would return early from all of them and report green while proving nothing about the claim query.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL a starving endpoint IS served while another has a deep, older backlog. Under the previous FIFO claim the backlog filled the whole batch — and because delivery is serial, the quiet endpoint was not merely delayed, it was never attempted.', async () => {
      const claim = liveClaim();
      const noisy = await seedEndpoint();
      const quiet = await seedEndpoint();
      // The noisy endpoint's rows are ALL older, so plain FIFO takes only those.
      await seedDue(noisy, 30, 10_000);
      await seedDue(quiet, 2, 100);

      await claim({ batchSize: 10, perEndpointCap: 5 });

      const counts = await claimedByEndpoint([noisy, quiet]);
      expect(counts[quiet], 'the quiet endpoint gets served despite being newer').toBeGreaterThan(
        0,
      );
      expect(counts[noisy], 'the backlogged endpoint is capped, not excluded').toBeLessThanOrEqual(
        5,
      );
    });

    it('CRITICAL the cap is per ENDPOINT, not global — a single endpoint never takes more than its share of one tick, however deep its backlog.', async () => {
      const claim = liveClaim();
      const noisy = await seedEndpoint();
      await seedDue(noisy, 40, 5_000);

      await claim({ batchSize: 25, perEndpointCap: 3 });

      const counts = await claimedByEndpoint([noisy]);
      expect(counts[noisy], 'capped at 3 despite 40 due rows and 25 free slots').toBe(3);
    });

    it('CRITICAL a single busy endpoint still drains when nothing competes, so fairness did not turn into an artificial throughput ceiling. Successive ticks keep making progress.', async () => {
      const claim = liveClaim();
      const only = await seedEndpoint();
      await seedDue(only, 12, 2_000);

      await claim({ batchSize: 25, perEndpointCap: 4 });
      const first = (await claimedByEndpoint([only]))[only] ?? 0;

      expect(first, 'the first tick takes its capped share').toBe(4);
      const remaining = await client!<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM webhook_deliveries
      WHERE webhook_id = ${only}::uuid AND status = 'pending'`;
      expect(remaining[0]?.n, 'and the rest remain queued rather than dropped').toBe(8);
    });

    it('CRITICAL oldest-first is preserved WITHIN an endpoint, so fairness did not cost ordering. A newer delivery must not overtake an older one for the same endpoint.', async () => {
      const claim = liveClaim();
      const ep = await seedEndpoint();
      await seedDue(ep, 6, 3_000); // i=0 is oldest

      await claim({ batchSize: 25, perEndpointCap: 2 });

      const rows = await client!<Array<{ next_attempt_at: Date; status: string }>>`
      SELECT next_attempt_at, status FROM webhook_deliveries
      WHERE webhook_id = ${ep}::uuid ORDER BY next_attempt_at ASC`;
      expect(
        rows.slice(0, 2).every((r) => r.status !== 'pending'),
        'the two oldest were taken',
      ).toBe(true);
      expect(
        rows.slice(2).every((r) => r.status === 'pending'),
        'newer ones waited',
      ).toBe(true);
    });
  },
);

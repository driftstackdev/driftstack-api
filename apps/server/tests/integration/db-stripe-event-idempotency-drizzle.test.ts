// The Stripe replay guard, executed as SQL rather than re-implemented.
//
// `StripeWebhooksService.handle` dedupes an event in two steps: a `hasEvent`
// short-circuit, and — for the race where two concurrent deliveries both pass
// that check — an `INSERT … ON CONFLICT DO NOTHING` whose `inserted` flag decides
// which delivery owns the event. The second step is the one that actually holds
// under concurrency, and it is pure SQL: a conflict on the `event_id` primary key
// must return zero rows rather than raise.
//
// The existing coverage exercises both paths, including the race, through
// `buildTestApp` — which wires an InMemory repo that re-implements
// `onConflictDoNothing` by hand. So the assertion has always been about the
// double's behaviour, never the shipped statement's.
//
// The failure that leaves is specific and loud in the wrong place: if the ON
// CONFLICT clause or its target were changed, a duplicate delivery would raise a
// unique-violation instead of returning `inserted: false`. Stripe sees a 500,
// retries on its schedule, and the event is never marked processed — a retry loop
// on an event that can never complete.
//
// Not isolated, deliberately: this is a two-row insert keyed by a random event id,
// not a whole-table sweep, so it does not fall under the global-operation rule
// that governs the purge tests.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

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
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM processed_stripe_events LIMIT 0`;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const eventId of seeded) {
      await client`DELETE FROM processed_stripe_events WHERE event_id = ${eventId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'Stripe event idempotency (real Postgres)',
  () => {
    it('CRITICAL a repeated event id returns inserted:false instead of raising. That flag is what resolves two concurrent deliveries; if the conflict clause raised instead, Stripe would see a 500, retry on its own schedule, and the event would never be marked processed.', async () => {
      if (!client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG stripe-idempotency test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const pg = client;
      const db = drizzle(pg) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleStripeWebhooksRepo({ client: pg, db, close: async () => {} });

      const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
      seeded.push(eventId);
      const receivedAt = new Date('2026-07-01T00:00:00.000Z');

      expect(await repo.hasEvent(eventId), 'unknown before the first delivery').toBe(false);

      const first = await repo.recordEvent({
        eventId,
        eventType: 'checkout.session.completed',
        payloadHash: 'a'.repeat(64),
        result: 'handled',
        receivedAt,
      });
      expect(first.inserted, 'the first delivery owns the event').toBe(true);

      // The replay. A DIFFERENT payload hash and result on purpose: the conflict
      // target is the event id alone, so a duplicate must be rejected on identity
      // rather than on the row happening to match.
      const second = await repo.recordEvent({
        eventId,
        eventType: 'checkout.session.completed',
        payloadHash: 'b'.repeat(64),
        result: 'ignored',
        receivedAt: new Date('2026-07-02T00:00:00.000Z'),
      });
      expect(second.inserted, 'the replay must lose, not raise').toBe(false);

      expect(await repo.hasEvent(eventId)).toBe(true);

      // DO NOTHING, not DO UPDATE: the first delivery's record is authoritative,
      // so the replay must not have overwritten the stored outcome. Without this
      // an upsert would satisfy every assertion above while quietly rewriting
      // history on every retry.
      const [row] = await pg<Array<{ result: string; payload_hash: string }>>`
        SELECT result, payload_hash FROM processed_stripe_events WHERE event_id = ${eventId}`;
      expect(row?.result, "the first delivery's outcome stands").toBe('handled');
      expect(row?.payload_hash).toBe('a'.repeat(64));

      // Not destructured: `noUncheckedIndexedAccess` types an index access as
      // possibly-undefined, so `const [{ count }]` fails the tests typecheck even
      // though vitest runs it happily.
      const counted = await pg<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM processed_stripe_events WHERE event_id = ${eventId}`;
      expect(Number(counted[0]?.count), 'exactly one row survives the replay').toBe(1);
    });
  },
);

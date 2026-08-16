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
import {
  encryptWebhookSecret,
  readWebhookSecret,
} from '../../src/lib/webhook-secret-encryption.js';
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
            'whsec_abcdefghijklmnopqrstuvwxyz234567', 'whsec_te', ARRAY['session.completed']::webhook_event_type[], true)`;
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

    it('CRITICAL a customer rotation inside a FORCE-rotation grace keeps the CUSTOMER live secret in the grace slot', async () => {
      // V-359.G.2. `rotateSecret` normally moves the outgoing current secret into
      // the grace slot. The exception is when a force rotation is still inside its
      // window: there, `secret` holds the SERVER's force-rotated value, which the
      // customer only ever saw as a 12-character prefix and never deployed, while
      // `secret_prev` holds what the customer actually has live. Moving the
      // current value across would make the worker dual-sign {new, force} — and
      // BOTH would fail the customer's verifier, which is still on the original.
      // Every delivery to that endpoint fails signature verification.
      //
      // The rule lives in a raw SQL CASE, so no fake-repo test can reach it.
      // Removing it redded exactly one test, and that test was the module's
      // CONTENT-PARITY pin — it fires on the source text changing, not on the
      // behaviour, so the rule was behaviourally unpinned.
      if (!dbReachable || !client) return;
      const c = client;
      const KEY = Buffer.alloc(32, 23).toString('base64');
      const keyedRepo = new DrizzleWebhooksRepo(
        { client: c, db: drizzle(c, { schema }), close: async () => {} },
        { secretEncryptionKeyBase64: KEY },
      );

      // whsec_ + 32 lowercase base32 characters; three values distinguishable
      // at a glance so a wrong one is obvious in a failure message.
      const CUSTOMER_LIVE = `whsec_${'c'.repeat(32)}`;
      const FORCE = `whsec_${'f'.repeat(32)}`;
      const NEW = `whsec_${'n'.repeat(32)}`;

      async function rotateFrom(args: { forceRotated: boolean }): Promise<{
        secret: string;
        secretPrev: string;
      }> {
        const accountId = randomUUID();
        seededAccountIds.push(accountId);
        await c`INSERT INTO accounts (id, email)
                VALUES (${accountId}, ${`wh-rot-${accountId}@test.local`})`;
        const endpointId = randomUUID();
        const ctx = { accountId, endpointId };
        const future = new Date(Date.now() + 12 * 60 * 60 * 1000);
        // V-359.G blocks a second CUSTOMER rotation while a prior customer grace
        // window is still live, and a force window is exempt. So the control arm
        // must use an already-elapsed window — otherwise it is refused by that
        // guard and proves nothing about the CASE under test. (Learned by
        // writing it the other way first and watching the control fail.)
        const past = new Date(Date.now() - 12 * 60 * 60 * 1000);
        const graceEnds = args.forceRotated ? future : past;
        await c`INSERT INTO webhook_endpoints
                  (id, account_id, url, secret, secret_prefix, secret_prev,
                   secret_prev_expires_at, force_rotated_at, events)
                VALUES (${endpointId}, ${accountId}, ${'https://hooks.example.test/rot'},
                        ${encryptWebhookSecret(FORCE, KEY, ctx)}, ${FORCE.slice(0, 12)},
                        ${encryptWebhookSecret(CUSTOMER_LIVE, KEY, ctx)},
                        ${graceEnds.toISOString()}::timestamptz,
                        ${args.forceRotated ? future.toISOString() : null},
                        ARRAY['session.completed']::webhook_event_type[])`;

        const rotated = await keyedRepo.rotateSecret({
          id: endpointId,
          accountId,
          newSecret: NEW,
          newPrefix: NEW.slice(0, 12),
          graceExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          now: new Date(),
        });
        expect(rotated, 'the rotation itself must succeed').not.toBeNull();

        const rows = await c<{ secret: string; secret_prev: string }[]>`
          SELECT secret, secret_prev FROM webhook_endpoints WHERE id = ${endpointId}`;
        expect(rows).toHaveLength(1);
        return {
          secret: readWebhookSecret(rows[0]!.secret, KEY, ctx),
          secretPrev: readWebhookSecret(rows[0]!.secret_prev, KEY, ctx),
        };
      }

      // Inside a live force-rotation window: the customer's deployed secret is
      // what must survive into the grace slot, NOT the force value.
      const underForce = await rotateFrom({ forceRotated: true });
      expect(underForce.secret).toBe(NEW);
      expect(
        underForce.secretPrev,
        'the grace slot must carry the secret the customer actually deployed',
      ).toBe(CUSTOMER_LIVE);
      expect(
        underForce.secretPrev,
        'the un-deployed force value must never become the dual-signed grace secret',
      ).not.toBe(FORCE);

      // The ordinary path — no force rotation — still moves the outgoing current
      // secret across. Without this arm the exception could be made unconditional
      // and nothing would notice.
      const ordinary = await rotateFrom({ forceRotated: false });
      expect(ordinary.secret).toBe(NEW);
      expect(ordinary.secretPrev, 'the normal rule is unchanged').toBe(FORCE);
    });
  },
);

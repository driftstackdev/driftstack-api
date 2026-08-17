// Drizzle-backed integration test for DurableWebhookDeliveryService.list
// keyset pagination — same-created_at completeness against a REAL Postgres.
//
// Sibling of db-sessions-repo-keyset-drizzle.test.ts. The V-173 durable
// delivery service pages a webhook endpoint's history on a compound
// (createdAt desc, id desc) keyset (fix e2d8f5f5). Deliveries fanned out
// from one event batch share an identical created_at; the previous
// timestamp-only cursor silently dropped rows sharing the cursor's
// created_at when a page boundary landed inside such a batch. This
// validates the shipped keyset SQL on real PG — the residual flagged when
// the fix landed (the build-test app uses the in-memory impl, so the
// Drizzle path had only typecheck + in-memory-twin coverage).
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DurableWebhookDeliveryService } from '../../src/services/durable-webhook-delivery.js';
import { assertStableUnderMidWalkInserts } from './_helpers/keyset-stable-under-inserts.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// (accountId, webhookId) pairs seeded — cleaned in FK order:
// webhook_deliveries → webhook_endpoints → accounts.
const seeded: Array<{ accountId: string; webhookId: string }> = [];

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
    await client`SELECT 1 FROM webhook_deliveries LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const { accountId, webhookId } of seeded) {
      await client`DELETE FROM webhook_deliveries WHERE webhook_id = ${webhookId}`.catch(() => {});
      await client`DELETE FROM webhook_endpoints WHERE id = ${webhookId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DurableWebhookDeliveryService.list keyset (Drizzle path against real Postgres)',
  () => {
    it('pages a same-created_at tie group larger than the page size WITHOUT dropping rows', async () => {
      if (!dbReachable || !client) {
        // Local dev without DATABASE_URL: skip quietly. In CI the DB
        // service + migrate step are part of the job — an unreachable or
        // unmigrated DB must FAIL the test, not vacuous-pass (this exact
        // silent skip hid a from-birth Date-bind crash in every one of
        // these tests until 2026-06-12).
        if (process.env.CI) {
          throw new Error(
            'real-PG keyset test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const svc = new DurableWebhookDeliveryService({ client, db, close: async () => {} }, () =>
        Date.now(),
      );

      const accountId = randomUUID();
      const webhookId = randomUUID();
      seeded.push({ accountId, webhookId });
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`durable-wh-${accountId}@test.local`})`;
      await client`INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events)
        VALUES (${webhookId}, ${accountId}, 'https://example.test/hook', 'whsec_abcdefghijklmnopqrstuvwxyz234567', 'whsec_test',
                ARRAY['session.completed']::webhook_event_type[])`;

      // 2 newest, 5 in a tie group (> page size 2), 2 oldest — all on the
      // same endpoint, so the tie group spans page boundaries.
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      const groups: Array<{ ts: Date; n: number }> = [
        { ts: new Date(base + 2000), n: 2 },
        { ts: new Date(base + 1000), n: 5 },
        { ts: new Date(base), n: 2 },
      ];
      const inserted: string[] = [];
      for (const g of groups) {
        for (let i = 0; i < g.n; i++) {
          const [row] = await client`
            INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, created_at)
            VALUES (${webhookId}, ${randomUUID()}, 'session.completed',
                    ${JSON.stringify({ body: '{}', emittedAtSec: 1 })}::text::jsonb, ${g.ts.toISOString()})
            RETURNING id`;
          inserted.push(row?.id as string);
        }
      }
      expect(inserted).toHaveLength(9);

      const collected: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await svc.list(
          cursor === undefined
            ? { endpointId: webhookId, limit: 2 }
            : { endpointId: webhookId, limit: 2, cursor },
        );
        collected.push(...page.data.map((d) => d.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // Completeness: every seeded delivery returned exactly once.
      expect(collected).toHaveLength(9);
      expect(new Set(collected).size).toBe(9);
      expect([...collected].sort()).toEqual([...inserted].sort());
    });

    it('CRITICAL another endpoint’s delivery id cannot be used as a page cursor', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG keyset test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const svc = new DurableWebhookDeliveryService({ client, db, close: async () => {} }, () =>
        Date.now(),
      );

      const seedEndpoint = async (): Promise<string> => {
        const accountId = randomUUID();
        const webhookId = randomUUID();
        seeded.push({ accountId, webhookId });
        await client!`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`durable-wh-${accountId}@test.local`})`;
        await client!`INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events)
          VALUES (${webhookId}, ${accountId}, 'https://example.test/hook', 'whsec_abcdefghijklmnopqrstuvwxyz234567', 'whsec_test',
                  ARRAY['session.completed']::webhook_event_type[])`;
        return webhookId;
      };
      const seedDelivery = async (webhookId: string, at: Date): Promise<string> => {
        const [row] = await client!`
          INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, created_at)
          VALUES (${webhookId}, ${randomUUID()}, 'session.completed',
                  ${JSON.stringify({ body: '{}', emittedAtSec: 1 })}::text::jsonb, ${at.toISOString()})
          RETURNING id`;
        return row?.id as string;
      };

      // Theirs is OLDER than mine, deliberately. The keyset pages strictly
      // BACKWARDS from the anchor, so if their row resolves as an anchor my
      // newer delivery is filtered out and the page comes back empty. Ordered
      // the other way round this arm would pass either way.
      const theirs = await seedEndpoint();
      const mine = await seedEndpoint();
      const theirDelivery = await seedDelivery(theirs, new Date(Date.UTC(2026, 0, 1)));
      const myDelivery = await seedDelivery(mine, new Date(Date.UTC(2026, 0, 2)));

      const page = await svc.list({ endpointId: mine, limit: 50, cursor: theirDelivery });
      expect(
        page.data.map((d) => d.id),
        'another endpoint’s delivery id resolved as a page anchor. The anchor lookup must be ' +
          'scoped to the endpoint being listed, or a customer can page their own history from a ' +
          'stranger’s position — which both shifts their listing and confirms when that ' +
          'stranger’s delivery was created',
      ).toEqual([myDelivery]);
    });

    // The case above pages a fixed set. This one enqueues deliveries WHILE the
    // walk runs — the ordinary state of a delivery list, which grows every time
    // the endpoint fires. See _helpers/keyset-stable-under-inserts.ts.
    it('does not repeat or drop a delivery when deliveries are enqueued mid-walk (the documented concurrent-insert promise)', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG concurrent-enqueue test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const sql = client;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const svc = new DurableWebhookDeliveryService(
        { client: sql, db, close: async () => {} },
        () => Date.now(),
      );

      const accountId = randomUUID();
      const webhookId = randomUUID();
      seeded.push({ accountId, webhookId });
      await sql`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`midwalk-wh-${accountId}@test.local`})`;
      await sql`INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events)
        VALUES (${webhookId}, ${accountId}, 'https://example.test/hook', 'whsec_abcdefghijklmnopqrstuvwxyz234567', 'whsec_test',
                ARRAY['session.completed']::webhook_event_type[])`;

      const base = Date.UTC(2026, 4, 1, 0, 0, 0);
      await assertStableUnderMidWalkInserts({
        noun: 'delivery',
        seed: async (offsetMs) => {
          const [row] = await sql`
            INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, created_at)
            VALUES (${webhookId}, ${randomUUID()}, 'session.completed',
                    ${JSON.stringify({ body: '{}', emittedAtSec: 1 })}::text::jsonb, ${new Date(base + offsetMs).toISOString()})
            RETURNING id`;
          return row?.id as string;
        },
        list: async ({ limit, cursor }) => {
          const page = await svc.list(
            cursor === undefined
              ? { endpointId: webhookId, limit }
              : { endpointId: webhookId, limit, cursor },
          );
          return { ids: page.data.map((d) => d.id), nextCursor: page.nextCursor };
        },
      });
    });
  },
);

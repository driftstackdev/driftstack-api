// A Postgres database of its own for a webhook DELIVERY test.
//
// `DrizzleWebhooksRepo.claim` is GLOBAL: it takes due deliveries across every
// account. A test that drives the worker against the shared database would
// claim — and, through its stubbed fetch, "deliver" — rows other test files
// seeded, and theirs would claim mine. So every file that claims gets its own
// isolated database (one distinct name per file; `DRIFTSTACK_ISO_DB_SUFFIX`
// keeps two concurrent runs of the same file apart), and wipes the two webhook
// tables between arms only after proving it is connected to that database.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../../src/db/schema.js';
import { DrizzleWebhooksRepo } from '../../../src/db/webhooks-repo.js';
import { assertIsolatedDatabase, ensureIsolatedDatabase } from './isolated-database.js';

/** The key every fixture repo encrypts endpoint secrets under. */
export const WEBHOOK_FIXTURE_KEY = Buffer.alloc(32, 23).toString('base64');

export interface WebhookDeliveryDb {
  client: ReturnType<typeof postgres>;
  repo: DrizzleWebhooksRepo;
  /** A fresh account row. */
  seedAccount(): Promise<string>;
  /** An endpoint written through the real repo, so its secret is a real envelope. */
  seedEndpoint(accountId: string, url?: string): Promise<string>;
  /**
   * `count` pending deliveries for one endpoint, all due, the first the oldest.
   * `ageSec` is how far in the past the OLDEST one became due.
   */
  seedDue(endpointId: string, count: number, ageSec: number): Promise<string[]>;
  /** Delete every delivery and endpoint — only ever on the isolated database. */
  wipe(): Promise<void>;
  close(): Promise<void>;
}

export async function openWebhookDeliveryDb(name: string): Promise<WebhookDeliveryDb | null> {
  const url = await ensureIsolatedDatabase(name);
  if (url === null) return null;
  const client = postgres(url, { max: 12 });
  try {
    await assertIsolatedDatabase(client, name);
  } catch (err) {
    await client.end({ timeout: 1 });
    throw err;
  }
  const repo = new DrizzleWebhooksRepo(
    { client, db: drizzle(client, { schema }), close: async () => {} },
    { secretEncryptionKeyBase64: WEBHOOK_FIXTURE_KEY },
  );
  return {
    client,
    repo,
    async seedAccount() {
      const id = randomUUID();
      await client`INSERT INTO accounts (id, email) VALUES (${id}, ${`wh-${id}@test.local`})`;
      return id;
    },
    async seedEndpoint(accountId, endpointUrl = `https://hooks.test.local/${randomUUID()}`) {
      const row = await repo.insertEndpoint({
        accountId,
        url: endpointUrl,
        secret: `whsec_${'a'.repeat(32)}`,
        secretPrefix: 'whsec_aaaaaa',
        events: ['session.completed'],
        description: null,
      });
      return row.id;
    },
    async seedDue(endpointId, count, ageSec) {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const id = randomUUID();
        const eventId = randomUUID();
        const due = new Date(Date.now() - (ageSec - i) * 1000).toISOString();
        await client`
          INSERT INTO webhook_deliveries
            (id, webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at)
          VALUES (${id}, ${endpointId}, ${eventId}, 'session.completed',
                  ${JSON.stringify({ id: eventId, type: 'session.completed', data: {} })}::jsonb,
                  'pending', 0, ${due}::timestamptz)`;
        ids.push(id);
      }
      return ids;
    },
    async wipe() {
      await assertIsolatedDatabase(client, name);
      await client`DELETE FROM webhook_deliveries`;
      await client`DELETE FROM webhook_endpoints`;
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

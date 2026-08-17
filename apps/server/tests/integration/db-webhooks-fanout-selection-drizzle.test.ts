// Which endpoints an event is delivered to.
//
// v8 coverage: `webhooks-repo.ts` sits at 47% of lines with 8 methods at zero
// executed statements. `listEndpointsSubscribedTo` is the one worth taking
// first — it is the fan-out decision itself. Every event the platform emits is
// routed by this single where-clause, and its three filters fail in three
// different directions:
//
//   accountId    the tenant boundary. Without it one customer's event fans out
//                to ANOTHER customer's endpoint — their session ids, their
//                order data, POSTed to a server that has no relationship with
//                them. There is no recovering from that once it is sent.
//   active       an endpoint disabled after repeated failures must stop
//                receiving. Without it, disabling is decorative: the deliveries
//                keep being enqueued against a URL already known to be dead.
//   events @>    the subscription itself. Without it an endpoint that asked
//                only for crypto.order.paid also receives session.completed —
//                payloads the customer never opted into and may not be
//                prepared to handle.
//
// Against a real Postgres, and specifically because of the third filter: it is
// a raw `@>` array-containment against a `webhook_event_type[]` column. That
// operator's behaviour with enum arrays is the thing under test, and no
// in-memory double reproduces it — a JS `.includes()` would agree with my
// reading rather than with Postgres.

import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { encryptWebhookSecret } from '../../src/lib/webhook-secret-encryption.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
/** 32 bytes base64 — the repo decrypts secrets on read, so this must be valid. */
const SECRET_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleWebhooksRepo | null = null;
let dbReachable = false;
const seededAccounts: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  sql = postgres(DB_URL, { max: 2 });
  try {
    await sql`SELECT events FROM webhook_endpoints LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleWebhooksRepo({ db: drizzle(sql) } as unknown as never, {
    secretEncryptionKeyBase64: SECRET_KEY_B64,
  });
});

afterAll(async () => {
  if (sql && seededAccounts.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seededAccounts)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${id}, ${`fanout-${id}@test.local`}, 'active')`;
  seededAccounts.push(id);
  return id;
}

/** whsec_ plaintext must be 32 lowercase base32 chars — hex uuids are rejected. */
function base32(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join('');
}

/** Endpoints cascade from accounts, so cleanup is by account. */
async function seedEndpoint(args: {
  accountId: string;
  events: readonly string[];
  active?: boolean;
}): Promise<string> {
  const id = randomUUID();
  // The repo decrypts on read and fails closed on anything that is not a v2
  // envelope, so the fixture stores real ciphertext under the same key.
  const secret = encryptWebhookSecret(`whsec_${base32(32)}`, SECRET_KEY_B64, {
    accountId: args.accountId,
    endpointId: id,
  });
  await sql!`
    INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events, active)
    VALUES (${id}, ${args.accountId}, ${`https://hooks.test.local/${id}`},
            ${secret}, 'whsec_test', ${sql!.array([...args.events])}::webhook_event_type[],
            ${args.active ?? true})`;
  return id;
}

const idsFor = async (accountId: string, eventType: string): Promise<string[]> =>
  (await repo!.listEndpointsSubscribedTo(accountId, eventType as never)).map((e) => e.id);

describe('webhook fan-out selection', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an endpoint subscribed to the event is selected', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const id = await seedEndpoint({ accountId, events: ['session.completed'] });
    expect(
      await idsFor(accountId, 'session.completed'),
      'a subscribed, active endpoint was not selected — the customer receives nothing',
    ).toContain(id);
  });

  it('CRITICAL another account’s endpoint is never selected', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    // Identical in every respect except who owns it.
    const theirEndpoint = await seedEndpoint({
      accountId: theirs,
      events: ['session.completed'],
    });
    expect(
      await idsFor(mine, 'session.completed'),
      'one account’s event selected another account’s endpoint — their data would be POSTed to a ' +
        'server with no relationship to them',
    ).not.toContain(theirEndpoint);
  });

  it('CRITICAL an endpoint not subscribed to this event is not selected', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const other = await seedEndpoint({ accountId, events: ['crypto.order.paid'] });
    expect(
      await idsFor(accountId, 'session.completed'),
      'an endpoint received an event type it never subscribed to',
    ).not.toContain(other);
  });

  it('CRITICAL a disabled endpoint is not selected', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const disabled = await seedEndpoint({
      accountId,
      events: ['session.completed'],
      active: false,
    });
    expect(
      await idsFor(accountId, 'session.completed'),
      'a disabled endpoint was still selected — disabling would be decorative and deliveries would ' +
        'keep being enqueued against a URL already known to be dead',
    ).not.toContain(disabled);
  });

  it('CRITICAL an endpoint subscribed to several events matches each of them', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const id = await seedEndpoint({
      accountId,
      events: ['session.completed', 'session.failed'],
    });
    expect(await idsFor(accountId, 'session.completed')).toContain(id);
    expect(
      await idsFor(accountId, 'session.failed'),
      'array containment matched only the first subscribed event',
    ).toContain(id);
    expect(
      await idsFor(accountId, 'api_key.revoked'),
      'containment matched an event outside the subscription list',
    ).not.toContain(id);
  });
});

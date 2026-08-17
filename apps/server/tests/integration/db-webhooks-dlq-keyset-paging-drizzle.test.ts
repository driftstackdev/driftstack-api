// Paging the dead-letter queue without losing rows.
//
// v8 coverage: `deliveryKeysetCondition` executes zero statements, and its own
// docblock records why that matters — it IS the fix for #125:
//
//   Composite (created_at DESC, id DESC) keyset predicate for the delivery
//   listings (#125). … for a full cursor it uses `created_at < T OR (created_at
//   = T AND id < lastId)` so no row sharing the boundary millisecond is skipped.
//
// A created_at-only cursor drops every row that shares a timestamp with the last
// row of the previous page. Deliveries are enqueued in bursts — one event
// fanning out, or a downstream outage failing a batch at once — so ties on
// created_at are the normal case here, not a corner. The rows that vanish are
// FAILED deliveries an operator is paging through specifically to decide what to
// replay, and nothing about the listing looks wrong: each page is well-formed,
// the cursor advances, the run ends cleanly. The only symptom is a delivery that
// silently never appears on any page.
//
// So the arm that matters seeds a batch sharing ONE created_at and pages through
// with a limit smaller than the batch, asserting every id is seen exactly once.
// Under a created_at-only cursor that assertion fails; under the composite one it
// holds. The legacy `id: null` cursor path is asserted too — it is deliberately
// kept so cursors already in flight across a deploy keep working, which means it
// stays reachable and can rot unnoticed.
//
// Against a real Postgres: `ORDER BY created_at DESC, id DESC` with a matching
// `OR (created_at = T AND id < lastId)` predicate is a claim about how Postgres
// orders and compares uuids and timestamptz together. A double would compare
// JavaScript strings and agree with whatever I assumed.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { encryptWebhookSecret } from '../../src/lib/webhook-secret-encryption.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
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
    await sql`SELECT status FROM webhook_deliveries LIMIT 0`;
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

function base32(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
}

async function seedEndpoint(): Promise<string> {
  const accountId = randomUUID();
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`dlq-${accountId}@test.local`}, 'active')`;
  seededAccounts.push(accountId);
  const secret = encryptWebhookSecret(`whsec_${base32(32)}`, SECRET_KEY_B64, {
    accountId,
    endpointId: id,
  });
  await sql!`
    INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events, active)
    VALUES (${id}, ${accountId}, ${`https://hooks.test.local/${id}`}, ${secret}, 'whsec_dlq',
            ARRAY['session.completed']::webhook_event_type[], true)`;
  return id;
}

/** Deliveries cascade from the endpoint, which cascades from the account. */
async function seedDelivery(args: {
  endpointId: string;
  status: 'dlq' | 'pending' | 'delivered';
  createdAt: string;
}): Promise<string> {
  const id = randomUUID();
  await sql!`
    INSERT INTO webhook_deliveries
      (id, webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at, created_at)
    VALUES (${id}, ${args.endpointId}, ${randomUUID()}, 'session.completed',
            ${JSON.stringify({ body: {}, emittedAtSec: 0 })}::jsonb, ${args.status}, 6, now(),
            ${args.createdAt}::timestamptz)`;
  return id;
}

/** Walks every page the way an operator's tooling would. */
async function pageThrough(limit: number, endpointId: string): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 25; guard++) {
    const page = await repo!.listDlqDeliveries({
      limit,
      endpointId,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.items.map((i) => i.id));
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

describe('DLQ keyset pagination', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL paging a batch that shares one timestamp loses nothing', async () => {
    if (!dbReachable || !repo) return;
    const endpointId = await seedEndpoint();
    // The #125 shape: one fan-out burst, every row on the same millisecond, so
    // every page boundary lands on a tie.
    const sameInstant = new Date(Date.now() - 60_000).toISOString();
    const ids = new Set<string>();
    for (let i = 0; i < 7; i++) {
      ids.add(await seedDelivery({ endpointId, status: 'dlq', createdAt: sameInstant }));
    }
    const seen = await pageThrough(2, endpointId);
    expect(
      new Set(seen).size,
      'a delivery was returned on more than one page — an operator replaying the DLQ would send it twice',
    ).toBe(seen.length);
    expect(
      new Set(seen),
      'paging dropped failed deliveries that shared the boundary millisecond. Every page looks ' +
        'well-formed and the run ends cleanly; the only symptom is a delivery that never appears ' +
        'on any page, so an operator deciding what to replay never sees it',
    ).toEqual(ids);
  });

  it('CRITICAL paging distinct timestamps also returns each row once', async () => {
    if (!dbReachable || !repo) return;
    const endpointId = await seedEndpoint();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(
        await seedDelivery({
          endpointId,
          status: 'dlq',
          createdAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
        }),
      );
    }
    const seen = await pageThrough(2, endpointId);
    expect(new Set(seen)).toEqual(ids);
    expect(seen.length, 'a row was repeated across pages').toBe(ids.size);
  });

  it('CRITICAL a legacy created_at-only cursor still advances', async () => {
    if (!dbReachable || !repo) return;
    const endpointId = await seedEndpoint();
    const older = new Date(Date.now() - 120_000);
    const newest = new Date(Date.now() - 60_000);
    const oldId = await seedDelivery({
      endpointId,
      status: 'dlq',
      createdAt: older.toISOString(),
    });
    await seedDelivery({ endpointId, status: 'dlq', createdAt: newest.toISOString() });
    // The pre-#125 cursor format: a bare created_at ISO string with no `_id`
    // suffix. Kept working so cursors already in flight across a deploy do not
    // break — decodeDeliveryCursor yields { createdAt, id: null } for it.
    const legacy = newest.toISOString();
    const page = await repo.listDlqDeliveries({ limit: 10, endpointId, cursor: legacy });
    expect(
      page.items.map((i) => i.id),
      'a legacy created_at-only cursor stopped returning the rows after it — cursors held by ' +
        'clients across the deploy that introduced the composite format would dead-end',
    ).toEqual([oldId]);
  });

  it('CRITICAL only dead-lettered deliveries are listed', async () => {
    if (!dbReachable || !repo) return;
    const endpointId = await seedEndpoint();
    const at = new Date(Date.now() - 60_000).toISOString();
    const dlq = await seedDelivery({ endpointId, status: 'dlq', createdAt: at });
    const pending = await seedDelivery({ endpointId, status: 'pending', createdAt: at });
    const delivered = await seedDelivery({ endpointId, status: 'delivered', createdAt: at });
    const seen = await pageThrough(10, endpointId);
    expect(seen, 'a dead-lettered delivery was missing from its own queue').toContain(dlq);
    expect(
      seen,
      'a delivery still awaiting its next attempt was listed as dead-lettered',
    ).not.toContain(pending);
    expect(seen, 'a delivered webhook was listed as dead-lettered').not.toContain(delivered);
  });

  it('CRITICAL the drill-down filter does not leak another endpoint’s failures', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedEndpoint();
    const theirs = await seedEndpoint();
    const at = new Date(Date.now() - 60_000).toISOString();
    const mineId = await seedDelivery({ endpointId: mine, status: 'dlq', createdAt: at });
    const theirsId = await seedDelivery({ endpointId: theirs, status: 'dlq', createdAt: at });
    const seen = await pageThrough(10, mine);
    expect(seen).toContain(mineId);
    expect(
      seen,
      'the per-endpoint drill-down returned a different endpoint’s failed deliveries',
    ).not.toContain(theirsId);
  });

  it('CRITICAL the DLQ count moves with the queue', async () => {
    if (!dbReachable || !repo) return;
    const endpointId = await seedEndpoint();
    const before = await repo.countDlqDeliveries();
    const at = new Date(Date.now() - 60_000).toISOString();
    await seedDelivery({ endpointId, status: 'dlq', createdAt: at });
    await seedDelivery({ endpointId, status: 'delivered', createdAt: at });
    expect(
      await repo.countDlqDeliveries(),
      'the DLQ depth an operator reads did not move by exactly the one dead-lettered row added',
    ).toBe(before + 1);
  });
});

// Warning a customer before their old webhook secret stops working.
//
// `webhooks-repo.ts` has the worst branch coverage of any substantial live file
// in the server (44.9%), and `findEndpointsNeedingGraceExpiringNotice` is where a
// large share of those branches live: five conditions decide who gets warned, and
// the notice is the only thing standing between a rotation and a customer's
// integration failing without explanation.
//
// The pair of timestamp comparisons is a WINDOW, and each edge fails in an
// opposite and equally bad direction:
//
//   gt(graceWindowEndsAt, now)       excludes windows that have ALREADY closed.
//                                    Drop it and the sweep mails "your secret is
//                                    about to expire" about secrets that expired
//                                    days ago — a warning arriving after the
//                                    outage it was meant to prevent, which reads
//                                    to the customer as the platform being
//                                    confused rather than as a deadline.
//   lte(graceWindowEndsAt, horizon)  excludes windows too far out to be
//                                    actionable. Drop it and every endpoint mid
//                                    rotation is notified on the first sweep,
//                                    days early — and because the notice
//                                    de-dupes on graceExpiringNotifiedAt, that
//                                    single premature mail is the ONLY one the
//                                    customer ever gets. The real deadline then
//                                    passes unwarned.
//
// The dedupe column is the other half of the rotation re-arm already covered in
// `db-webhooks-secret-rotation-grace-drizzle`: `forceRotateSecret` nulls
// `graceExpiringNotifiedAt` so a NEW cycle can notify again, and this query skips
// rows where it is already set so one cycle notifies once. Those two only make
// sense together, and neither was exercised.
//
// The last arm covers a failure mode the source calls out in a comment: the
// encryption key is resolved OUTSIDE the per-row try, because a missing key is a
// deployment fault affecting every row. Swallowing it would turn a hard failure
// into a silently empty sweep — a sweep that reports "nobody needs warning" when
// in truth it could not read anything at all.

import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { encryptWebhookSecret } from '../../src/lib/webhook-secret-encryption.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const SECRET_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const HOUR = 60 * 60 * 1000;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleWebhooksRepo | null = null;
/** Same database, no encryption key — for the fail-loud arm. */
let keylessRepo: DrizzleWebhooksRepo | null = null;
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
    await sql`SELECT grace_expiring_notified_at FROM webhook_endpoints LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  const db = drizzle(sql);
  repo = new DrizzleWebhooksRepo({ db } as unknown as never, {
    secretEncryptionKeyBase64: SECRET_KEY_B64,
  });
  keylessRepo = new DrizzleWebhooksRepo({ db } as unknown as never, {});
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
  return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join('');
}

/**
 * An endpoint mid-rotation. `graceEndsInMs` positions its grace window relative
 * to now, which is what every arm here varies.
 */
async function seedRotating(args: {
  graceEndsInMs: number | null;
  notified?: boolean;
  disabled?: boolean;
}): Promise<string> {
  const accountId = randomUUID();
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`grace-${accountId}@test.local`}, 'active')`;
  seededAccounts.push(accountId);
  const secret = encryptWebhookSecret(`whsec_${base32(32)}`, SECRET_KEY_B64, {
    accountId,
    endpointId: id,
  });
  const graceEndsAt =
    args.graceEndsInMs === null ? null : new Date(Date.now() + args.graceEndsInMs).toISOString();
  await sql!`
    INSERT INTO webhook_endpoints
      (id, account_id, url, secret, secret_prefix, events, active,
       grace_window_ends_at, grace_expiring_notified_at, disabled_at)
    VALUES (${id}, ${accountId}, ${`https://hooks.test.local/${id}`}, ${secret}, 'whsec_g',
            ARRAY['session.completed']::webhook_event_type[], true,
            ${graceEndsAt}::timestamptz,
            ${args.notified === true ? sql!`now()` : null},
            ${args.disabled === true ? sql!`now()` : null})`;
  return id;
}

/** A 48h notice horizon — the window every arm is positioned against. */
const dueForNotice = async (): Promise<string[]> =>
  (
    await repo!.findEndpointsNeedingGraceExpiringNotice({
      now: new Date(),
      windowHours: 48,
      limit: 100,
    })
  ).map((e) => e.id);

describe('webhook grace-expiring notice', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an endpoint whose grace window closes inside the horizon is warned', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedRotating({ graceEndsInMs: 12 * HOUR });
    expect(
      await dueForNotice(),
      'nobody was warned about a secret expiring in 12 hours — the customer’s integration would ' +
        'simply start failing signature verification with no notice at all',
    ).toContain(id);
  });

  it('CRITICAL a grace window that already closed is NOT warned about', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedRotating({ graceEndsInMs: -6 * HOUR });
    expect(
      await dueForNotice(),
      'the sweep would mail "your secret is about to expire" about a secret that expired hours ' +
        'ago — a warning arriving after the outage it exists to prevent',
    ).not.toContain(id);
  });

  it('CRITICAL a grace window beyond the horizon is not warned about yet', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedRotating({ graceEndsInMs: 20 * 24 * HOUR });
    expect(
      await dueForNotice(),
      'an endpoint days outside the notice horizon was warned early. The notice de-dupes, so that ' +
        'premature mail is the only one the customer ever gets and the real deadline passes unwarned',
    ).not.toContain(id);
  });

  it('CRITICAL an endpoint already notified this cycle is not warned twice', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedRotating({ graceEndsInMs: 12 * HOUR, notified: true });
    expect(
      await dueForNotice(),
      'the same rotation cycle would notify on every sweep — the customer gets the same warning ' +
        'repeatedly until the deadline',
    ).not.toContain(id);
  });

  it('CRITICAL an endpoint not mid-rotation is never in the sweep', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedRotating({ graceEndsInMs: null });
    expect(
      await dueForNotice(),
      'an endpoint with no grace window at all was selected for a rotation notice',
    ).not.toContain(id);
  });

  it('CRITICAL a disabled endpoint is not warned, and cannot be marked notified', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedRotating({ graceEndsInMs: 12 * HOUR, disabled: true });
    expect(await dueForNotice(), 'a disabled endpoint was queued for a notice').not.toContain(id);
    expect(
      await repo.markGraceExpiringNotified({ endpointId: id, now: new Date() }),
      'a disabled endpoint reported a successful notice-mark',
    ).toBeNull();
  });

  it('CRITICAL marking an endpoint notified removes it from the next sweep', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedRotating({ graceEndsInMs: 12 * HOUR });
    expect(await dueForNotice(), 'precondition: the endpoint starts due').toContain(id);
    const marked = await repo.markGraceExpiringNotified({ endpointId: id, now: new Date() });
    expect(marked?.id, 'the mark did not return the row it updated').toBe(id);
    expect(
      await dueForNotice(),
      'the endpoint stayed due after being marked — every sweep would re-notify it',
    ).not.toContain(id);
  });

  it('CRITICAL a missing encryption key fails loudly rather than sweeping up nothing', async () => {
    if (!dbReachable || !keylessRepo) return;
    await seedRotating({ graceEndsInMs: 12 * HOUR });
    await expect(
      keylessRepo.findEndpointsNeedingGraceExpiringNotice({
        now: new Date(),
        windowHours: 48,
        limit: 100,
      }),
      'a deployment missing its webhook encryption key returned an EMPTY sweep instead of throwing. ' +
        'That reports "nobody needs warning" when in truth nothing could be read at all, and every ' +
        'customer mid-rotation silently loses their notice',
    ).rejects.toThrow(/encryption key/i);
  });
});

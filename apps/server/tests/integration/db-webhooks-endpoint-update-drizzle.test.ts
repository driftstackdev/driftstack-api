// Editing a webhook endpoint without silently changing something else.
//
// `webhooks-repo.ts` is still the worst-covered live file in the server by
// branches (48%), and `updateEndpoint` is one of the remaining clusters. Its two
// mentions in the test tree are a `vi.spyOn(...).mockResolvedValue` and the
// in-memory double, so the real UPDATE has never run.
//
// It is a partial patch, and the field it can quietly destroy is `events`:
//
//   independence   a customer renaming their endpoint sends only the description.
//                  The subscription list must survive that. If `events` were
//                  overwritten the endpoint stops matching any event, deliveries
//                  stop, and NOTHING errors — the customer sees a successful save
//                  and then silence.
//
//                  Precise about WHAT holds this, because mutation testing
//                  corrected an earlier claim here. Deleting the `!== undefined`
//                  guards does NOT reproduce the wipe: drizzle's `.set()` skips
//                  keys whose value is undefined, so the guards and the ORM agree
//                  and removing them changes nothing observable. What DOES
//                  reproduce it is a defaulting coalesce — `input.events ?? []` —
//                  which is the shape this actually shows up as, and which reds
//                  this arm. So the arm is a behavioural pin on the outcome, not
//                  proof that those four `if`s are load-bearing.
//   null clears    `description: null` is a real value meaning "remove it", and
//                  is distinct from omitting the key. Collapse the two — to a
//                  truthiness check, which drizzle does NOT paper over — and a
//                  description can never be cleared once set.
//
// Two scoping guards sit on the same statement and both fail silently rather
// than loudly, which is why each gets an arm:
//
//   accountId      the tenant boundary on an EDIT. Without it one customer can
//                  repoint another customer's endpoint URL at a host they
//                  control — every future payload for that account delivered to
//                  them, signed with a secret the victim still trusts.
//   disabledAt     disabled rows are tombstones. Editing one would revive an
//                  endpoint that was disabled after repeated delivery failures,
//                  bypassing the decision that disabled it.
//
// Against a real Postgres: the `events` column is a `webhook_event_type[]`, and
// whether a partial UPDATE leaves an array column alone or nulls it is the
// database's behaviour, not the ORM's.

import { randomBytes, randomUUID } from 'node:crypto';
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

function base32(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join('');
}

async function seedEndpoint(
  opts: { disabled?: boolean } = {},
): Promise<{ accountId: string; id: string }> {
  const accountId = randomUUID();
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`whupd-${accountId}@test.local`}, 'active')`;
  seededAccounts.push(accountId);
  const secret = encryptWebhookSecret(`whsec_${base32(32)}`, SECRET_KEY_B64, {
    accountId,
    endpointId: id,
  });
  await sql!`
    INSERT INTO webhook_endpoints
      (id, account_id, url, secret, secret_prefix, events, description, active, disabled_at)
    VALUES (${id}, ${accountId}, 'https://hooks.test.local/original', ${secret}, 'whsec_u',
            ARRAY['session.completed','session.failed']::webhook_event_type[],
            'original description', true,
            ${opts.disabled === true ? sql!`now()` : null})`;
  return { accountId, id };
}

interface RawEndpoint {
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
}

async function raw(id: string): Promise<RawEndpoint> {
  const [row] = await sql!<RawEndpoint[]>`
    SELECT url, events, description, active FROM webhook_endpoints WHERE id = ${id}`;
  return row!;
}

describe('webhook endpoint update', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL updating one field leaves the subscription list intact', async () => {
    if (!dbReachable || !repo) return;
    const { accountId, id } = await seedEndpoint();
    const updated = await repo.updateEndpoint({ id, accountId, description: 'renamed' });
    expect(updated?.description).toBe('renamed');
    const after = await raw(id);
    expect(
      after.events,
      'renaming an endpoint wiped its event subscriptions — it would stop matching any event, ' +
        'deliveries would stop, and nothing errors: the customer sees a successful save and silence',
    ).toEqual(['session.completed', 'session.failed']);
    expect(after.url, 'renaming an endpoint changed its URL').toBe(
      'https://hooks.test.local/original',
    );
    expect(after.active).toBe(true);
  });

  it('CRITICAL each field can be updated on its own', async () => {
    if (!dbReachable || !repo) return;
    const { accountId, id } = await seedEndpoint();
    await repo.updateEndpoint({ id, accountId, url: 'https://hooks.test.local/moved' });
    expect((await raw(id)).url).toBe('https://hooks.test.local/moved');
    await repo.updateEndpoint({ id, accountId, events: ['crypto.order.paid'] });
    expect((await raw(id)).events).toEqual(['crypto.order.paid']);
    await repo.updateEndpoint({ id, accountId, active: false });
    const after = await raw(id);
    expect(after.active).toBe(false);
    // …and the earlier edits survived the later ones.
    expect(after.url).toBe('https://hooks.test.local/moved');
    expect(after.events).toEqual(['crypto.order.paid']);
  });

  it('CRITICAL an explicit null clears the description, unlike an omitted key', async () => {
    if (!dbReachable || !repo) return;
    const { accountId, id } = await seedEndpoint();
    await repo.updateEndpoint({ id, accountId, description: null });
    expect(
      (await raw(id)).description,
      'an explicit null was treated as "not provided", so a description can never be cleared',
    ).toBeNull();
  });

  it('CRITICAL another account cannot edit this endpoint', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedEndpoint();
    const theirs = await seedEndpoint();
    const result = await repo.updateEndpoint({
      id: mine.id,
      accountId: theirs.accountId,
      url: 'https://attacker.test.local/collect',
    });
    expect(result, 'the cross-account edit reported success').toBeNull();
    expect(
      (await raw(mine.id)).url,
      'one customer repointed another customer’s endpoint. Every future payload for that account ' +
        'goes to a host they control, signed with a secret the victim still trusts',
    ).toBe('https://hooks.test.local/original');
  });

  it('CRITICAL a disabled endpoint is a tombstone and cannot be edited', async () => {
    if (!dbReachable || !repo) return;
    const { accountId, id } = await seedEndpoint({ disabled: true });
    expect(
      await repo.updateEndpoint({ id, accountId, active: true }),
      'a disabled endpoint was edited back into service, bypassing whatever disabled it after ' +
        'repeated delivery failures',
    ).toBeNull();
    expect((await raw(id)).active).toBe(true);
  });

  it('CRITICAL updating an endpoint that does not exist reports null', async () => {
    if (!dbReachable || !repo) return;
    const { accountId } = await seedEndpoint();
    expect(
      await repo.updateEndpoint({ id: randomUUID(), accountId, url: 'https://x.test' }),
    ).toBeNull();
  });
});

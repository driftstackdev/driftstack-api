// The API-key listing a customer sees on their dashboard.
//
// v8 coverage: four methods on `db/api-keys-repo.ts` execute zero statements.
// Three of them turn out to be unreachable — `findApiKey` has no invocation
// anywhere in src or tests, `findApiKeyUnscoped` is used only as a test
// assertion helper, and `setExpiresAt` was superseded by the V-296 atomic
// rotation (a content-parity arm asserts the old non-atomic call site stays
// gone). `listApiKeys` is the one that is live, on two service call sites, and
// it is the query behind a customer's key list.
//
// Its single filter is the tenant boundary. An API key row carries `key_prefix`
// — the first 16 characters of the key, shown in the dashboard so a customer can
// tell their keys apart — along with scopes and provenance. Losing the accountId
// filter therefore does not just leak a count; it shows one customer the
// identifying prefixes and permission scopes of every key on the platform.
//
// Ordering is asserted too, and deliberately as a property rather than a
// snapshot: newest-first is what makes "the key I just created" appear at the
// top of the list. A listing that silently reversed would be reported as a
// missing key long before anyone suspected sort order.
//
// Revoked keys are asserted to REMAIN listed. That is not an oversight in the
// query: a customer needs to see that a key was revoked, and the service layer
// is what decides how to present it. A filter added here would make revoked keys
// vanish from the dashboard entirely, which reads as data loss.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleApiKeysRepo } from '../../src/db/api-keys-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleApiKeysRepo | null = null;
let dbReachable = false;
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
  sql = postgres(DB_URL, { max: 2 });
  try {
    await sql`SELECT key_prefix FROM api_keys LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleApiKeysRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seeded.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${id}, ${`apikeys-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

/** Keys cascade from the account, so cleanup is by account. */
async function seedKey(args: {
  accountId: string;
  name: string;
  createdAgoMs?: number;
  revoked?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date(Date.now() - (args.createdAgoMs ?? 0)).toISOString();
  await sql!`
    INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes, created_at, revoked_at)
    VALUES (${id}, ${args.accountId}, ${args.name}, ${`ds_live_${id.slice(0, 8)}`},
            ${`hash-${id}`}, ARRAY['read']::api_key_scope[], ${createdAt}::timestamptz,
            ${args.revoked === true ? sql!`now()` : null})`;
  return id;
}

describe('API key listing scope', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an account sees its own keys', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await seedKey({ accountId, name: 'ci' });
    await seedKey({ accountId, name: 'laptop' });
    const names = (await repo.listApiKeys(accountId)).map((k) => k.name).sort();
    expect(names, 'a customer’s own keys were missing from their listing').toEqual([
      'ci',
      'laptop',
    ]);
  });

  it('CRITICAL an account never sees another account’s keys', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    await seedKey({ accountId: mine, name: 'mine' });
    await seedKey({ accountId: theirs, name: 'theirs' });
    const rows = await repo.listApiKeys(mine);
    expect(
      rows.map((k) => k.name),
      'one customer’s listing returned another customer’s keys — the row carries key_prefix and ' +
        'scopes, so this exposes the identifying prefix and permissions of every key on the platform',
    ).toEqual(['mine']);
    expect(rows.every((k) => k.accountId === mine)).toBe(true);
  });

  it('CRITICAL the newest key is listed first', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await seedKey({ accountId, name: 'oldest', createdAgoMs: 3 * 60_000 });
    await seedKey({ accountId, name: 'middle', createdAgoMs: 2 * 60_000 });
    await seedKey({ accountId, name: 'newest', createdAgoMs: 60_000 });
    expect(
      (await repo.listApiKeys(accountId)).map((k) => k.name),
      'the listing is not newest-first, so a key a customer just created does not appear at the ' +
        'top — which gets reported as a missing key rather than a sort-order bug',
    ).toEqual(['newest', 'middle', 'oldest']);
  });

  it('CRITICAL a revoked key stays in the listing', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await seedKey({ accountId, name: 'revoked-one', revoked: true });
    const rows = await repo.listApiKeys(accountId);
    expect(
      rows.map((k) => k.name),
      'a revoked key vanished from the listing. The customer needs to SEE that it was revoked; ' +
        'the service layer decides how to present it, and filtering here reads as data loss',
    ).toEqual(['revoked-one']);
    expect(rows[0]?.revokedAt, 'the revocation was not surfaced on the row').toBeInstanceOf(Date);
  });

  it('CRITICAL an account with no keys lists nothing rather than failing', async () => {
    if (!dbReachable || !repo) return;
    expect(await repo.listApiKeys(await seedAccount())).toEqual([]);
  });
});

// Storing, clearing and touching a customer's own Anthropic key.
//
// v8 coverage: `db/byok-anthropic-repo.ts` has `findByAccount`, `upsert`,
// `clear` and `touchLastUsed` at zero executed statements. The envelope
// migration and the purge-candidate query each have their own drizzle test; the
// CRUD underneath them does not. What these four columns hold is a customer's
// real Anthropic API key, encrypted at rest — the most sensitive thing an
// account can hand us.
//
// `clear` is the one that has to be exactly right. It is the "remove my key"
// path, so a column it forgets is customer credential material still sitting on
// our servers after they asked us to delete it. It nulls FOUR columns, and only
// one of them (the ciphertext) is what `getMetadata` reads to decide `hasKey` —
// which means a `clear` that dropped the other three would still LOOK correct
// from the dashboard while leaving the key's history behind. Asserted column by
// column rather than through the metadata view for that reason.
//
// Two behaviours are documented in the source and pinned here because both are
// the kind of thing a later edit "tidies up":
//
//   upsert resets the reminder   `byok_anthropic_api_key_last_reminder_sent_at`
//                                is set to null on every key set, so the next
//                                90-day rotation cycle can fire again. Without
//                                it a customer who rotates their key is never
//                                reminded to rotate the new one — the dedupe
//                                marker from the previous cycle suppresses it
//                                permanently.
//   touchLastUsed skips updatedAt  the bump is "an application-side observation,
//                                not a customer mutation". If it moved
//                                `updated_at`, every agent turn that used the
//                                key would look like the customer had just
//                                edited their account.
//
// Against a real Postgres: the ciphertext is a bytea round-trip and the rest are
// timestamptz null-vs-set distinctions, neither of which an in-memory double
// exercises.

import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleBYOKAnthropicRepo } from '../../src/db/byok-anthropic-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleBYOKAnthropicRepo | null = null;
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
    await sql`SELECT byok_anthropic_api_key_ciphertext FROM accounts LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleBYOKAnthropicRepo({ db: drizzle(sql) } as unknown as never);
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
    VALUES (${id}, ${`byok-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

interface RawCols {
  byok_anthropic_api_key_ciphertext: Uint8Array | null;
  byok_anthropic_api_key_set_at: Date | null;
  byok_anthropic_api_key_last_used_at: Date | null;
  byok_anthropic_api_key_last_reminder_sent_at: Date | null;
}

/** Read the columns directly — `clear` must be checked field by field. */
async function raw(accountId: string): Promise<RawCols> {
  const [row] = await sql!<RawCols[]>`
    SELECT byok_anthropic_api_key_ciphertext,
           byok_anthropic_api_key_set_at,
           byok_anthropic_api_key_last_used_at,
           byok_anthropic_api_key_last_reminder_sent_at
      FROM accounts WHERE id = ${accountId}`;
  return row!;
}

const setKey = (accountId: string, ciphertext = randomBytes(48)) =>
  repo!.upsert({ accountId, ciphertext, setAt: new Date(), now: new Date() });

describe('BYOK Anthropic key storage', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a stored key round-trips byte for byte', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const ciphertext = randomBytes(48);
    await setKey(accountId, ciphertext);
    const row = await repo.findByAccount(accountId);
    expect(
      row?.ciphertext && Buffer.from(row.ciphertext).equals(ciphertext),
      'the stored ciphertext did not come back byte-identical — the key would fail to decrypt',
    ).toBe(true);
    expect(row?.setAt, 'the set timestamp was not recorded').toBeInstanceOf(Date);
  });

  it('CRITICAL an account with no key reads as empty, not missing', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const row = await repo.findByAccount(accountId);
    expect(row?.accountId, 'an existing account with no key read as no account at all').toBe(
      accountId,
    );
    expect(row?.ciphertext).toBeNull();
    expect(row?.setAt).toBeNull();
  });

  it('CRITICAL an unknown account reads as null', async () => {
    if (!dbReachable || !repo) return;
    expect(await repo.findByAccount(randomUUID())).toBeNull();
  });

  it('CRITICAL clearing removes the ciphertext and every trace beside it', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await setKey(accountId);
    await repo.touchLastUsed({ accountId, now: new Date() });
    await sql!`UPDATE accounts SET byok_anthropic_api_key_last_reminder_sent_at = now()
                WHERE id = ${accountId}`;
    await repo.clear({ accountId, now: new Date() });
    const after = await raw(accountId);
    expect(
      after.byok_anthropic_api_key_ciphertext,
      'the customer asked us to delete their Anthropic key and the ciphertext is still stored',
    ).toBeNull();
    expect(
      after.byok_anthropic_api_key_set_at,
      'clearing left the set timestamp behind — the dashboard reads hasKey off the ciphertext, so ' +
        'this residue is invisible there while the key’s history survives deletion',
    ).toBeNull();
    expect(after.byok_anthropic_api_key_last_used_at).toBeNull();
    expect(after.byok_anthropic_api_key_last_reminder_sent_at).toBeNull();
  });

  it('CRITICAL setting a key re-arms the rotation reminder', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await setKey(accountId);
    // A dedupe marker left over from the previous 90-day cycle.
    await sql!`UPDATE accounts SET byok_anthropic_api_key_last_reminder_sent_at = now()
                WHERE id = ${accountId}`;
    await setKey(accountId);
    expect(
      (await raw(accountId)).byok_anthropic_api_key_last_reminder_sent_at,
      'a stale reminder marker survived the key being rotated — the dedupe would suppress every ' +
        'future rotation reminder for this account permanently',
    ).toBeNull();
  });

  it('CRITICAL using the key does not look like the customer edited their account', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await setKey(accountId);
    // Pin updated_at to a known instant and compare in SQL, so the assertion
    // does not depend on how the driver represents a timestamptz.
    const marker = '2020-01-01T00:00:00.000Z';
    await sql!`UPDATE accounts SET updated_at = ${marker}::timestamptz WHERE id = ${accountId}`;
    await repo.touchLastUsed({ accountId, now: new Date(Date.now() + 60_000) });
    const [after] = await sql!<{ same: boolean }[]>`
      SELECT updated_at = ${marker}::timestamptz AS same
        FROM accounts WHERE id = ${accountId}`;
    expect(
      after?.same,
      'recording that the key was used moved updated_at — every agent turn would then look like a ' +
        'customer modification of the account',
    ).toBe(true);
    expect(
      (await repo.findByAccount(accountId))?.lastUsedAt,
      'the use was not recorded at all',
    ).toBeInstanceOf(Date);
  });

  it('CRITICAL one account’s key operations never reach another account', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const theirCiphertext = randomBytes(48);
    await setKey(mine);
    await setKey(theirs, theirCiphertext);
    await repo.clear({ accountId: mine, now: new Date() });
    const row = await repo.findByAccount(theirs);
    expect(
      row?.ciphertext && Buffer.from(row.ciphertext).equals(theirCiphertext),
      'clearing one account’s Anthropic key destroyed a different account’s key',
    ).toBe(true);
  });
});

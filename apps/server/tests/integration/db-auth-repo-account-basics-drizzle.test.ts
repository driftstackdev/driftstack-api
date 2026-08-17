// Patching account basics: what a partial patch must leave alone, and what a
// duplicate slug must be turned into.
//
// v8 coverage: `db/auth-repo.ts` sits at 38% of lines with `updateAccountBasics`,
// `getOrganization`, `setOrganization` and `getAccount` at zero executed
// statements. All four are heavily referenced across the suite — but through
// `_helpers/in-memory-auth-repo.ts`. The double proves the callers; the SQL had
// never run.
//
// Three properties, each failing in a way nothing else would catch:
//
//   patch independence  every field is guarded by `!== undefined`, so an absent
//                       key is left alone and an explicit null CLEARS. Collapse
//                       that distinction — the single most common way to write
//                       this wrong — and saving one field on a settings form
//                       silently wipes the others. Both directions get an arm,
//                       because a version that never clears passes an
//                       independence test on its own.
//
//   SLUG_TAKEN          a duplicate slug raises a Postgres unique violation that
//                       is translated into SLUG_TAKEN so the route layer answers
//                       409 instead of 500. The method's own comment flags this
//                       as version-fragile: the driver exposes the error at the
//                       top level on drizzle 0.38 and under err.cause on 0.45,
//                       and `isUniqueViolation` reads a field off whichever
//                       shape it finds. A dependency bump that moves it again
//                       turns every taken-slug collision into a 500 with no
//                       failing test — the translation is only ever exercised by
//                       a real Postgres raising a real 23505.
//
//   organization jsonb  getOrganization normalizes `folders ?? []` / `tags ?? []`
//                       so a row storing a partial object cannot hand callers an
//                       undefined to iterate. That normalization only means
//                       anything against a real jsonb round-trip.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountAuthRepo } from '../../src/db/auth-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAccountAuthRepo | null = null;
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
    await sql`SELECT slug, organization FROM accounts LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleAccountAuthRepo({ db: drizzle(sql) } as unknown as never);
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
    VALUES (${id}, ${`basics-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

describe('account basics patch', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a patch writes the fields it names and returns the new row', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedAccount();
    const row = await repo.updateAccountBasics(id, { name: 'Ada', timezone: 'Europe/Amsterdam' });
    expect(row?.name, 'the patch did not write the field it was given').toBe('Ada');
    expect(row?.timezone).toBe('Europe/Amsterdam');
    expect((await repo.getAccount(id))?.name, 'the returned row disagreed with storage').toBe(
      'Ada',
    );
  });

  it('CRITICAL a patch leaves fields it does not mention alone', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedAccount();
    await repo.updateAccountBasics(id, { name: 'Ada', timezone: 'Europe/Amsterdam' });
    // A second patch naming only the timezone.
    await repo.updateAccountBasics(id, { timezone: 'UTC' });
    const after = await repo.getAccount(id);
    expect(
      after?.name,
      'patching one field wiped another — saving a single field on a settings form would silently ' +
        'clear everything the form did not send',
    ).toBe('Ada');
    expect(after?.timezone).toBe('UTC');
  });

  it('CRITICAL an explicit null clears the field, unlike an absent one', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedAccount();
    await repo.updateAccountBasics(id, { name: 'Ada' });
    await repo.updateAccountBasics(id, { name: null });
    expect(
      (await repo.getAccount(id))?.name,
      'an explicit null was treated as "not provided", so a field can never be cleared once set',
    ).toBeNull();
  });

  it('CRITICAL updating an account that does not exist reports null', async () => {
    if (!dbReachable || !repo) return;
    expect(await repo.updateAccountBasics(randomUUID(), { name: 'ghost' })).toBeNull();
    expect(await repo.getAccount(randomUUID())).toBeNull();
  });

  it('CRITICAL a slug already taken raises SLUG_TAKEN, not a raw driver error', async () => {
    if (!dbReachable || !repo) return;
    const first = await seedAccount();
    const second = await seedAccount();
    const slug = `taken-${randomUUID().slice(0, 8)}`;
    await repo.updateAccountBasics(first, { slug });
    // The route layer keys on this exact message to answer 409. If the driver
    // ever moves where it exposes the constraint name, the translation stops
    // firing and every collision becomes a 500 instead.
    await expect(
      repo.updateAccountBasics(second, { slug }),
      'a duplicate slug surfaced as something other than SLUG_TAKEN — the route layer answers 409 ' +
        'on that exact message, so anything else is a 500 on a routine validation failure',
    ).rejects.toThrow('SLUG_TAKEN');
  });

  it('CRITICAL an account can still take a slug nobody holds', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedAccount();
    const row = await repo.updateAccountBasics(id, { slug: `free-${randomUUID().slice(0, 8)}` });
    expect(
      row,
      'a free slug was rejected — the collision arm above would pass trivially if no slug could ' +
        'ever be set',
    ).not.toBeNull();
  });

  it('CRITICAL organization round-trips, and an untouched account reads as empty', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedAccount();
    expect(
      await repo.getOrganization(id),
      'an account that never set an organization did not read as empty lists — callers iterate ' +
        'these directly',
    ).toEqual({ folders: [], tags: [] });
    await repo.setOrganization(id, {
      folders: [{ name: 'inbox' }, { name: 'archive', icon: 'box' }],
      tags: ['vip'],
    });
    expect(
      await repo.getOrganization(id),
      'the organization did not survive the jsonb round-trip',
    ).toEqual({ folders: [{ name: 'inbox' }, { name: 'archive', icon: 'box' }], tags: ['vip'] });
  });

  it('CRITICAL one account’s organization is not another’s', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    await repo.setOrganization(mine, { folders: [{ name: 'mine' }], tags: [] });
    expect(
      (await repo.getOrganization(theirs))?.folders,
      'setting one account’s organization changed another account’s',
    ).toEqual([]);
  });
});

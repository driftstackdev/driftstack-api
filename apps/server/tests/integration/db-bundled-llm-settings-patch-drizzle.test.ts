// Bundled-LLM consent and the monthly spend cap are edited independently.
//
// Found by v8 coverage: `findSettings` and `updateSettings` in
// `db/bundled-llm-repo.ts` are entirely unexercised — 0 of their statements
// run in the whole suite. `sumMonthlySpendCents` beside them IS covered, which
// is the easy half to remember: it reads the money already spent. These two
// decide whether the money may be spent at all, and by how much.
//
// The property worth the most here is that `updateSettings` is a PATCH. It
// builds a `set` object from only the fields supplied, so:
//
//   consent alone   must leave the customer's cap where they set it. A PATCH
//                   that wrote both columns would reset the cap to the column
//                   default (2000 = $20) every time consent was toggled —
//                   silently RAISING a customer's ceiling if theirs was lower,
//                   or lowering it if theirs was higher, on an unrelated edit.
//   cap alone       must leave consent alone. The same bug in the other
//                   direction grants or revokes permission to spend on an edit
//                   that was only ever about the ceiling.
//   neither         must not write at all, and still echo current state.
//
// And `findSettings` returns null for an account row that is not there. That is
// a fail-safe the caller depends on — `bundled-llm.ts` reads null as
// consent=false — so an implementation returning a default-shaped object rather
// than null would hand out bundled-LLM access nobody consented to.
//
// Against a real Postgres: the columns carry NOT NULL defaults (consent false,
// cap 2000), and half of what is under test is which columns an UPDATE touches.
// A double would assert my re-reading of the set-object, not the statement.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleBundledLlmRepo } from '../../src/db/bundled-llm-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleBundledLlmRepo | null = null;
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
    await sql`SELECT bundled_llm_consent FROM accounts LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleBundledLlmRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seeded.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

/** An account with a deliberately non-default cap, so a reset to 2000 is visible. */
async function seedAccount(consent: boolean, capCents: number): Promise<string> {
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status, bundled_llm_consent, bundled_llm_monthly_cap_usd_cents)
    VALUES (${id}, ${`bundled-${id}@test.local`}, 'active', ${consent}, ${capCents})`;
  seeded.push(id);
  return id;
}

describe('bundled-LLM settings are patched, not replaced', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an unknown account reads as null, so consent defaults to off', async () => {
    if (!dbReachable || !repo) return;
    expect(
      await repo.findSettings(randomUUID()),
      'a missing account returned a settings object. The caller reads null as consent=false, so ' +
        'anything object-shaped here grants bundled-LLM access nobody consented to',
    ).toBeNull();
  });

  it('CRITICAL stored consent and cap are read back as stored', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount(true, 7_500);
    expect(await repo.findSettings(accountId)).toEqual({
      consent: true,
      monthlyCapUsdCents: 7_500,
    });
  });

  it('CRITICAL setting consent alone leaves the customer’s cap untouched', async () => {
    if (!dbReachable || !repo) return;
    // 7500 is deliberately not the column default (2000): a PATCH that wrote
    // both columns would show up here as the cap snapping back to 2000.
    const accountId = await seedAccount(false, 7_500);
    const after = await repo.updateSettings({ accountId, consent: true });
    expect(
      after,
      'toggling consent moved the spend cap — an edit about permission silently changed the ' +
        'customer’s ceiling',
    ).toEqual({ consent: true, monthlyCapUsdCents: 7_500 });
  });

  it('CRITICAL setting the cap alone leaves consent untouched', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount(true, 7_500);
    const after = await repo.updateSettings({ accountId, monthlyCapUsdCents: 1_200 });
    expect(
      after,
      'changing the spend cap moved consent — an edit about the ceiling silently granted or ' +
        'revoked permission to spend',
    ).toEqual({ consent: true, monthlyCapUsdCents: 1_200 });
  });

  it('CRITICAL supplying neither field writes nothing and echoes current state', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount(true, 3_300);
    expect(await repo.updateSettings({ accountId })).toEqual({
      consent: true,
      monthlyCapUsdCents: 3_300,
    });
  });

  it('CRITICAL updating an account that does not exist creates nothing', async () => {
    if (!dbReachable || !repo) return;
    const ghost = randomUUID();
    expect(await repo.updateSettings({ accountId: ghost, consent: true })).toBeNull();
    const [row] = await sql!`SELECT 1 FROM accounts WHERE id = ${ghost}`;
    expect(row, 'an update against a missing account inserted a row').toBeUndefined();
  });
});

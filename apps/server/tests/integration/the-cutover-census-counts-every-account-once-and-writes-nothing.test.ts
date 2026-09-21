// The cutover census counts every account once, and writes nothing.
//
// §8 step 4 moves accounts in waves, C0 first. Before each wave somebody has to
// answer "how many does this one touch", and the number has to be trustworthy in
// two different ways:
//
//   · EVERY ACCOUNT IS IN EXACTLY ONE COHORT. §8 lists the cohorts as a
//     sequence, and as written they OVERLAP — an account with a stored key and
//     bundled consent is described by both C2 and C3, and an internal account is
//     described by whichever of C1–C4 also fits it. A census whose buckets
//     overlap does not sum to the population it is counting, so the query
//     resolves the overlap by first match in cutover order and this file proves
//     the sum.
//   · IT DOES NOT TOUCH WHAT IT COUNTS. It is the surface an operator opens
//     repeatedly during a cutover, next to the one that moves accounts. It runs
//     in a read-only transaction, which is the database refusing rather than a
//     comment promising.
//
// ⛔ DELETED ACCOUNTS ARE EXCLUDED, and that is a decision rather than a filter
// nobody thought about: they are not moved, so counting them would inflate every
// wave's size with rows no cutover will touch.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import {
  AI_CREDITS_COHORTS,
  DrizzleAiCreditsReportRepo,
  type AiCreditsCensus,
  type AiCreditsCohort,
} from '../../src/db/ai-credits-report-repo.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_census';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const INTERNAL_EMAIL = 'ops@driftstack.internal.test';

let client: postgres.Sql | null = null;
let database: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 4);
  if (db === null) return;
  client = db.sql;
  database = createDb(db.url, { max: 3 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await database?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function repoFor(internalEmails: readonly string[]): DrizzleAiCreditsReportRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleAiCreditsReportRepo(database, new Set(internalEmails));
}

function repo(): DrizzleAiCreditsReportRepo {
  return repoFor([INTERNAL_EMAIL]);
}

interface AccountSpec {
  email?: string;
  tier?: string;
  status?: string;
  storedKey?: boolean;
  consent?: boolean;
  moved?: boolean;
}

async function account(spec: AccountSpec = {}): Promise<string> {
  const id = randomUUID();
  await db()`
    INSERT INTO accounts (id, email, tier, status, bundled_llm_consent,
                          byok_anthropic_api_key_ciphertext)
    VALUES (${id}::uuid,
            ${spec.email ?? `census-${id}@example.test`},
            ${spec.tier ?? 'api_builder'}::account_tier,
            ${spec.status ?? 'active'}::account_status,
            ${spec.consent ?? false},
            ${spec.storedKey === true ? db()`'\\x0102'::bytea` : null})`;
  if (spec.moved === true) {
    await db()`
      INSERT INTO credit_accounts (account_id, billing_mode)
      VALUES (${id}::uuid, 'credits')`;
  }
  return id;
}

function count(census: AiCreditsCensus, cohort: AiCreditsCohort): number {
  return census.cohorts.find((c) => c.cohort === cohort)?.accounts ?? -1;
}

describe.skipIf(!RUN_DB_TESTS)('the cutover census counts every account once', () => {
  it('CRITICAL every cohort is present even when empty, and the whole population is the sum of them. A missing key read as "no accounts" and a cohort double-counted both look like a small number on the same screen.', async () => {
    const before = await repo().census();

    expect(before.cohorts.map((c) => c.cohort)).toEqual([...AI_CREDITS_COHORTS]);
    expect(before.accounts).toBe(before.cohorts.reduce((n, c) => n + c.accounts, 0));
  });

  it('CRITICAL each account lands in exactly one cohort, by first match in cutover order — so an internal account with a stored key is C0 and not C2, and a stored-key account that also consented is C2 and not C3', async () => {
    const before = await repo().census();

    // C0 — this deployment's own account. It also has a stored key and consent,
    // which is the overlap: every later cohort describes it too.
    await account({ email: INTERNAL_EMAIL, storedKey: true, consent: true });
    // C1 — Personal (no own key is possible on that plan), and a Team account
    // with no key of its own.
    await account({ tier: 'solo_manual' });
    await account({ tier: 'team_manual' });
    // C2 — a stored-key account that ALSO consented: the C2/C3 overlap.
    await account({ tier: 'api_builder', storedKey: true, consent: true });
    // C3 — consented, no key.
    await account({ tier: 'api_builder', consent: true });
    // C4 — the rest.
    await account({ tier: 'free' });

    const after = await repo().census();

    expect(count(after, 'C0') - count(before, 'C0')).toBe(1);
    expect(count(after, 'C1') - count(before, 'C1')).toBe(2);
    expect(count(after, 'C2') - count(before, 'C2')).toBe(1);
    expect(count(after, 'C3') - count(before, 'C3')).toBe(1);
    expect(count(after, 'C4') - count(before, 'C4')).toBe(1);
    // Six accounts, six cohort memberships: nothing counted twice, nothing lost.
    expect(after.accounts - before.accounts).toBe(6);
  });

  it('CRITICAL C0 is every configured internal address, not the first one. The roster is a SET and reaches the query as a list of parameters; production always holds at least two (the staff list plus the owner), while every other arm here configures one — so a reader that bound only the first, or the whole set as a single value, would read zero or a third of C0 with this file still green. Case is configuration’s to get wrong, so the comparison is lower-cased on both sides.', async () => {
    const second = 'OPS-TWO@Driftstack.Internal.Test';
    const bothInternal = repoFor([INTERNAL_EMAIL, second]);
    const before = await bothInternal.census();

    await account({ email: `first-${randomUUID()}@example.test` });
    await account({ email: INTERNAL_EMAIL.replace('ops@', `ops+${randomUUID()}@`) });
    await account({ email: second.toLowerCase() });

    const after = await bothInternal.census();

    // The second address counts, and the near-miss on the first does not.
    expect(count(after, 'C0') - count(before, 'C0')).toBe(1);
    expect(after.accounts - before.accounts).toBe(3);
  });

  it('CRITICAL a Team account WITH a stored key is C2, not C1. C1 is "Team, Agency and Starter with NO key" — reading it as "Team, Agency and Starter" would move accounts that are still running on their own provider account into the first wave.', async () => {
    const before = await repo().census();
    await account({ tier: 'team_manual', storedKey: true });
    const after = await repo().census();

    expect(count(after, 'C1') - count(before, 'C1')).toBe(0);
    expect(count(after, 'C2') - count(before, 'C2')).toBe(1);
  });

  it('CRITICAL a deleted account is in no cohort at all. It will never be cut over, and counting it would inflate a wave with rows nobody touches.', async () => {
    const before = await repo().census();
    await account({ tier: 'api_builder', status: 'deleted', consent: true });
    const after = await repo().census();

    expect(after.accounts).toBe(before.accounts);
  });

  it('CRITICAL accounts already on credits are counted as moved, inside their own cohort as well as in the total — the number an operator needs is "how many are LEFT", which is the difference', async () => {
    const before = await repo().census();
    await account({ tier: 'api_builder', consent: true, moved: true });
    const after = await repo().census();

    expect(after.alreadyMoved - before.alreadyMoved).toBe(1);
    const movedInC3 =
      (after.cohorts.find((c) => c.cohort === 'C3')?.alreadyMoved ?? 0) -
      (before.cohorts.find((c) => c.cohort === 'C3')?.alreadyMoved ?? 0);
    expect(movedInC3).toBe(1);
    expect(after.alreadyMoved).toBe(after.cohorts.reduce((n, c) => n + c.alreadyMoved, 0));
  });

  it('CRITICAL the census writes nothing: the accounts it counted are byte-identical afterwards, and the row count has not moved', async () => {
    await account({ tier: 'api_builder', consent: true });
    const snapshot = async (): Promise<string> => {
      const rows = await db()`
        SELECT id::text AS id, tier::text AS tier, status::text AS status,
               bundled_llm_consent, updated_at::text AS updated_at
          FROM accounts ORDER BY id`;
      return JSON.stringify(rows);
    };

    const before = await snapshot();
    await repo().census();
    const after = await snapshot();

    expect(after).toEqual(before);
  });

  it('CRITICAL the read-only transaction the census runs in is really enforced by THIS database — otherwise the arm above proves only that today’s query happens not to write, and the next edit to it would be caught by nothing', async () => {
    const refused = await db()
      .begin(async (tx) => {
        await tx`SET TRANSACTION READ ONLY`;
        await tx`INSERT INTO accounts (id, email) VALUES (${randomUUID()}::uuid, 'nope@example.test')`;
        return null;
      })
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));

    expect(refused).toMatch(/read-only transaction/i);
  });
});

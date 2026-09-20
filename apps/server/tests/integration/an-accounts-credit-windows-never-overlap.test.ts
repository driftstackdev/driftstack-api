// An account's credit windows never overlap — and an insert that WOULD overlap
// is skipped, not failed.
//
// A window is the stretch of time one month of included credits belongs to. Two
// windows over the same time would be the same month granted twice, so the
// database refuses it outright: an exclusion constraint over the account and the
// half-open range [window_start, window_end). Proved here with raw SQL, against
// the database alone, because it is the last thing standing when two payment
// sources, two webhook deliveries or two processes all decide to grant at once.
//
// The second half is the one that is easy to get wrong. A writer says "insert
// unless it is already covered" with ON CONFLICT DO NOTHING — and that clause
// arbitrates an exclusion constraint ONLY WHEN IT NAMES NO CONFLICT TARGET. Give
// it the obvious target (the unique index) and an overlapping insert is not
// skipped: it raises 23P01 and aborts the writer's whole transaction, and every
// later statement in it fails. The writer here is a webhook, a sweep, or a task
// about to run. Both forms are run, side by side, so the difference is measured
// rather than remembered.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gate, openLedgerDatabase, waitUntilBlocked } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  insertWindow,
  newAccountOn,
  windowsOf,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';
import { refusal } from './_helpers/database-refusal.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_windows_overlap';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url);
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
});

function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

/** The overlapping insert, with whatever ON CONFLICT clause the arm is about. */
function overlappingInsert(accountId: string, onConflict: string): string {
  return `INSERT INTO credit_windows
            (account_id, source, source_ref, natural_start, natural_end, window_start, window_end, tier, level_micro)
          VALUES ('${accountId}', 'crypto_entitlement', 'ord_overlap', now() - interval '5 days',
                  now() + interval '26 days', now() - interval '5 days', now() + interval '26 days',
                  'api_starter', 3000000000)
          ${onConflict}
          RETURNING id`;
}

describe.skipIf(!RUN_DB_TESTS)('an account’s credit windows never overlap', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('the exclusion constraint is installed as written: gist, over the account and the half-open window range, on the btree_gist extension', async () => {
    const [row] = await db()<Array<{ def: string; ext: number }>>`
      SELECT pg_get_constraintdef(c.oid) AS def,
             (SELECT count(*)::int FROM pg_extension WHERE extname = 'btree_gist') AS ext
        FROM pg_constraint c
       WHERE c.conname = 'credit_windows_no_overlap' AND c.contype = 'x'`;
    expect(row?.ext, 'btree_gist is installed').toBe(1);
    expect(row?.def).toMatch(
      /^EXCLUDE USING gist \(account_id WITH =, tstzrange\(window_start, window_end, '\[\)'::text\) WITH &&\)$/,
    );
  });

  it('CRITICAL a second window over part of the same time is refused by the exclusion constraint, whatever source it names', async () => {
    const accountId = await newAccountOn(db());
    await insertWindow(db(), accountId, { source: 'stripe_invoice' });
    for (const [what, start, end] of [
      // Every start is in the past: a window may not be created ahead of its
      // start, and that CHECK would answer before the overlap was looked at.
      ['overlapping the end', "now() - interval '1 day'", "now() + interval '40 days'"],
      ['overlapping the start', "now() - interval '30 days'", "now() - interval '5 days'"],
      ['inside it', "now() - interval '2 days'", "now() - interval '1 day'"],
      ['around it', "now() - interval '60 days'", "now() + interval '60 days'"],
      ['the very same range', "now() - interval '10 days'", "now() + interval '20 days'"],
    ] as const) {
      const r = await refusal(
        () =>
          insertWindow(db(), accountId, {
            source: 'crypto_entitlement',
            start,
            end,
            // A natural month that started long ago, so "not ahead of its start"
            // and "inside its month" both hold and only the overlap is at issue.
            naturalStart: "now() - interval '90 days'",
            naturalEnd: "now() + interval '90 days'",
          }),
        what,
      );
      expect(r.code, what).toBe('23P01');
      expect(r.constraint, what).toBe('credit_windows_no_overlap');
    }
    expect(await windowsOf(db(), accountId)).toHaveLength(1);
  });

  it('two windows may TOUCH — one ends at the instant the next starts — because the range is half-open', async () => {
    const accountId = await newAccountOn(db());
    // Both in the past: a window may not be created ahead of its start.
    await insertWindow(db(), accountId, {
      start: "date_trunc('second', now()) - interval '62 days'",
      end: "date_trunc('second', now()) - interval '31 days'",
    });
    await insertWindow(db(), accountId, {
      start: "date_trunc('second', now()) - interval '31 days'",
      end: "date_trunc('second', now()) - interval '1 day'",
    });
    const rows = await windowsOf(db(), accountId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.window_end.getTime()).toBe(rows[1]?.window_start.getTime());
  });

  it('one microsecond of overlap is an overlap: the constraint compares to the microsecond, which is why no boundary may pass through a millisecond clock', async () => {
    const accountId = await newAccountOn(db());
    await insertWindow(db(), accountId, {
      start: "date_trunc('second', now()) - interval '62 days'",
      end: "date_trunc('second', now()) - interval '31 days'",
    });
    const r = await refusal(() =>
      insertWindow(db(), accountId, {
        start: "date_trunc('second', now()) - interval '31 days' - interval '1 microsecond'",
        end: "date_trunc('second', now()) - interval '1 day'",
      }),
    );
    expect(r.code).toBe('23P01');
  });

  it('the constraint is per account: another account may hold a window over the same time', async () => {
    const a = await newAccountOn(db());
    const b = await newAccountOn(db());
    await insertWindow(db(), a);
    await insertWindow(db(), b);
    expect(await windowsOf(db(), b)).toHaveLength(1);
  });

  it('the same payment cannot have two windows for the same month: a unique index, separate from the overlap rule', async () => {
    const accountId = await newAccountOn(db());
    const natural = {
      naturalStart: "date_trunc('second', now()) - interval '70 days'",
      naturalEnd: "date_trunc('second', now()) - interval '1 day'",
    };
    await insertWindow(db(), accountId, {
      sourceRef: 'in_same',
      ...natural,
      start: "date_trunc('second', now()) - interval '70 days'",
      end: "date_trunc('second', now()) - interval '40 days'",
    });
    // Not overlapping, so only the unique index can refuse it.
    const r = await refusal(() =>
      insertWindow(db(), accountId, {
        sourceRef: 'in_same',
        ...natural,
        start: "date_trunc('second', now()) - interval '30 days'",
        end: "date_trunc('second', now()) - interval '1 day'",
      }),
    );
    expect(r.code).toBe('23505');
    expect(r.constraint).toBe('credit_windows_source_month_unique');
  });

  it('CRITICAL an overlapping insert with ON CONFLICT DO NOTHING and NO conflict target inserts nothing, raises nothing, and a LATER statement in the same transaction still commits', async () => {
    const accountId = await newAccountOn(db());
    await insertWindow(db(), accountId);
    const marker = await newAccountOn(db());

    await db().begin(async (tx) => {
      const rows = await tx.unsafe(overlappingInsert(accountId, 'ON CONFLICT DO NOTHING'));
      expect(rows, 'the overlapping window was written').toHaveLength(0);
      // The later statement: it must run, and it must survive the COMMIT.
      await tx`UPDATE accounts SET email = ${`later-${marker}@example.test`} WHERE id = ${marker}::uuid`;
    });

    const [row] = await db()<Array<{ email: string }>>`
      SELECT email FROM accounts WHERE id = ${marker}::uuid`;
    expect(row?.email, 'the later statement did not commit').toBe(`later-${marker}@example.test`);
    expect(await windowsOf(db(), accountId)).toHaveLength(1);
  });

  it('CRITICAL the contrast that makes the arm above mean something: the SAME insert with a conflict target naming the unique index is NOT skipped — it raises 23P01, the transaction is aborted, and the later statement never commits', async () => {
    const accountId = await newAccountOn(db());
    await insertWindow(db(), accountId);
    const marker = await newAccountOn(db());

    let first: { code?: string } | null = null;
    let later: { code?: string } | null = null;
    const r = await refusal(() =>
      db().begin(async (tx) => {
        try {
          await tx.unsafe(
            overlappingInsert(
              accountId,
              'ON CONFLICT ("account_id", "source", "source_ref", "natural_start") DO NOTHING',
            ),
          );
        } catch (err) {
          first = err as { code?: string };
        }
        // The writer carries on, as a caller that swallowed the error would.
        try {
          await tx`UPDATE accounts SET email = ${`later-${marker}@example.test`} WHERE id = ${marker}::uuid`;
        } catch (err) {
          later = err as { code?: string };
        }
      }),
    );
    expect((first as { code?: string } | null)?.code, 'the targeted form was skipped').toBe(
      '23P01',
    );
    // 25P02: current transaction is aborted, commands ignored until end of transaction block.
    expect((later as { code?: string } | null)?.code, 'the later statement ran').toBe('25P02');
    expect(r.code, 'the transaction committed').toBe('23P01');
    const [row] = await db()<Array<{ email: string }>>`
      SELECT email FROM accounts WHERE id = ${marker}::uuid`;
    expect(row?.email, 'a statement in an aborted transaction committed').not.toBe(
      `later-${marker}@example.test`,
    );
  });

  it('CRITICAL the REPOSITORY’s own window write is the skipping kind. Handed a window that overlaps one already there — and contains now(), so nothing else would stop it — it answers "covered", raises nothing, and a later statement in the same transaction still commits. This is the write every refresh makes', async () => {
    const accountId = await newAccountOn(db());
    await insertWindow(db(), accountId, { source: 'crypto_entitlement' });
    const marker = await newAccountOn(db());
    const [t] = await db()<Array<{ from: string; to: string }>>`
      SELECT to_char((now() - interval '5 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS from,
             to_char((now() + interval '26 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS to`;
    if (t === undefined) throw new Error('no clock row');

    const outcome = await h().ledger.transaction(async (tx) => {
      await h().ledger.lockAccount(tx, accountId);
      const written = await h().windows.writeWindow(tx, accountId, {
        source: 'stripe_invoice',
        sourceRef: 'in_overlapping',
        tier: 'api_starter',
        levelMicro: 3_000 * MICRO,
        naturalStart: t.from,
        naturalEnd: t.to,
        windowStart: t.from,
        windowEnd: t.to,
      });
      // The later statement, through the same transaction handle.
      await h().ledger.ensureAccount(marker, tx);
      return written.outcome;
    });

    expect(outcome).toBe('covered');
    const [row] = await db()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM credit_accounts WHERE account_id = ${marker}::uuid`;
    expect(row?.n, 'the later statement did not commit').toBe(1);
    expect((await windowsOf(db(), accountId)).map((w) => w.source)).toEqual(['crypto_entitlement']);
  });

  it('CRITICAL RACE, the database alone: two connections insert overlapping windows for one account at once. The second is observed WAITING on the first, and when the first commits the second inserts nothing and fails nothing', async () => {
    const accountId = await newAccountOn(db());
    const inserted = gate();
    const release = gate();

    const first = db().begin(async (tx) => {
      const rows = await tx.unsafe(
        overlappingInsert(accountId, 'ON CONFLICT DO NOTHING').replace('ord_overlap', 'ord_first'),
      );
      expect(rows).toHaveLength(1);
      inserted.open();
      await release.opened;
    });
    await inserted.opened;

    const second = db().reserve();
    const conn = await second;
    try {
      const [pid] = await conn<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      // `.execute()`: a postgres-js query is lazy, and would otherwise not be
      // sent until it is awaited, after the first transaction has committed.
      const racing = conn
        .unsafe(
          overlappingInsert(accountId, 'ON CONFLICT DO NOTHING').replace(
            'ord_overlap',
            'ord_second',
          ),
        )
        .execute();
      try {
        await waitUntilBlocked(db(), pid?.pid ?? -1);
      } finally {
        release.open();
      }
      await first;
      expect(await racing, 'the second connection also wrote a window').toHaveLength(0);
    } finally {
      conn.release();
    }
    const rows = await windowsOf(db(), accountId);
    expect(rows.map((w) => w.source_ref)).toEqual(['ord_first']);
  });
});

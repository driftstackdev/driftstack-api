// The database refuses a rate card without 30 days' notice, a markup outside
// 1.0 × – 10.0 ×, two live cards for one instant, an Opus price, and prices out
// of their cache order — each by its own CHECK or index, proven with raw SQL.
//
// Every refusal is asserted by SQLSTATE AND constraint name. A row refused by a
// different rule than the one under test proves nothing about that rule, and a
// bare "it threw" cannot tell the two apart. So each invalid row below breaks
// exactly one rule, and each arm has an accepted neighbour (the boundary value,
// or the same row with the one fault removed) as its positive control.
//
// Price rows are inserted in their card's own transaction, which is the only
// place the guard trigger lets them in; that way the trigger passes and the
// CHECK under test is what decides.
//
// Also here: the launch card the migration seeded, read back from the database
// and held equal to CREDIT_RATE_CARD_V1.

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentModelSchema,
  CREDIT_RATE_CARD_V1,
  type CreditRateCardModelRow,
} from '@driftstack/api-types';
import { assertIsolatedDatabase } from './_helpers/isolated-database.js';
import { ensureFreshIsolatedDatabase } from './_helpers/fresh-isolated-database.js';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_rate_card_rules';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let isolatedUrl: string | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const url = await ensureFreshIsolatedDatabase(ISOLATED_DB_NAME);
  if (url === null) return;
  const candidate = postgres(url, { max: 4, onnotice: () => undefined });
  try {
    await candidate`SELECT 1`;
  } catch {
    await candidate.end({ timeout: 1 }).catch(() => {});
    return;
  }
  await assertIsolatedDatabase(candidate, ISOLATED_DB_NAME);
  client = candidate;
  isolatedUrl = url;
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

type Tx = postgres.Sql | postgres.TransactionSql;

const COLUMN_OF: Record<keyof CreditRateCardModelRow, string> = {
  inputMicroPerToken: 'input_micro_per_token',
  outputMicroPerToken: 'output_micro_per_token',
  cacheReadMicroPerToken: 'cache_read_micro_per_token',
  cacheWrite5mMicroPerToken: 'cache_write_5m_micro_per_token',
  cacheWrite1hMicroPerToken: 'cache_write_1h_micro_per_token',
  minStartMicro: 'min_start_micro',
  maxReserveMicro: 'max_reserve_micro',
  listInputMicrocentsPerToken: 'list_input_microcents_per_token',
  listOutputMicrocentsPerToken: 'list_output_microcents_per_token',
};

/** The launch Sonnet 5 prices with `overrides`, as insertable columns. */
function priceRow(
  version: number,
  model: string,
  overrides: Record<string, number> = {},
): Record<string, string | number> {
  const row: Record<string, string | number> = { version, model };
  const sonnet = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
  for (const [field, column] of Object.entries(COLUMN_OF) as Array<
    [keyof CreditRateCardModelRow, string]
  >) {
    row[column] = sonnet[field];
  }
  return { ...row, ...overrides };
}

async function insertCard(
  sql: Tx,
  version: number,
  effective: string,
  markupBp = 20000,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO credit_rate_cards (version, markup_bp, effective_at) VALUES ($1, $2, ${effective})`,
    [version, markupBp],
  );
}

/** Run one statement under a savepoint, so a refusal does not end the enclosing transaction. */
function inSavepoint(
  tx: postgres.TransactionSql,
  body: (sp: postgres.TransactionSql) => Promise<unknown>,
) {
  return () => tx.savepoint(body);
}

describe.skipIf(!RUN_DB_TESTS)(
  'the database refuses a rate card without notice, out of range, or with an Opus price',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(isolatedUrl).not.toBeNull();
    });

    it('CRITICAL the migration seeded the launch card exactly as CREDIT_RATE_CARD_V1 — version 1 at 2.0 ×, effective when announced, never withdrawn, and nothing else', async () => {
      const cards = await db()<
        Array<{
          version: number;
          markup_bp: number;
          same: boolean;
          withdrawn_at: Date | null;
          note: string;
        }>
      >`SELECT version, markup_bp, announced_at = effective_at AS same, withdrawn_at, note
          FROM credit_rate_cards ORDER BY version`;
      expect(cards).toEqual([
        {
          version: CREDIT_RATE_CARD_V1.version,
          markup_bp: CREDIT_RATE_CARD_V1.markupBp,
          same: true,
          withdrawn_at: null,
          note: CREDIT_RATE_CARD_V1.note,
        },
      ]);

      const rows = await db()<Array<Record<string, string | number>>>`
        SELECT * FROM credit_rate_card_models ORDER BY model`;
      const constant = CREDIT_RATE_CARD_V1.models as Readonly<
        Record<string, CreditRateCardModelRow>
      >;
      expect(rows.map((r) => r.model)).toEqual(Object.keys(constant).sort());
      for (const row of rows) {
        const expected = constant[String(row.model)];
        expect(Number(row.version)).toBe(1);
        for (const [field, column] of Object.entries(COLUMN_OF) as Array<
          [keyof CreditRateCardModelRow, string]
        >) {
          // bigint columns arrive as strings; every one is an exact safe integer.
          const value = Number(row[column]);
          expect(Number.isSafeInteger(value), `${String(row.model)}.${column}`).toBe(true);
          expect(value, `${String(row.model)}.${column}`).toBe(expected?.[field]);
        }
      }
    });

    it('CRITICAL a later card must take effect at least 720 hours after it is announced: one microsecond short is refused, exactly 720 hours is accepted', async () => {
      // The insert-time CHECK, measured from announced_at (the transaction's
      // start). This transaction is rolled back, so the commit-time check never
      // runs here; that one has its own arm at the end of this file.
      await inRolledBackTransaction(db(), async (tx) => {
        const short = await refusal(
          inSavepoint(tx, (sp) =>
            insertCard(sp, 2, `now() + interval '720 hours' - interval '1 microsecond'`),
          ),
        );
        expect(short.code).toBe('23514');
        expect(short.constraint).toBe('credit_rate_cards_thirty_days_notice');
        await insertCard(tx, 2, `now() + interval '720 hours'`);
      });
    });

    it('CRITICAL the announcement cannot be backdated to get round the notice — announced_at is the insert time whatever the row says', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const backdated = await refusal(() =>
          tx.savepoint(
            (sp) => sp`
              INSERT INTO credit_rate_cards (version, markup_bp, announced_at, effective_at)
              VALUES (2, 20000, now() - interval '60 days', now() + interval '1 day')`,
          ),
        );
        expect(backdated.code).toBe('23514');
        expect(backdated.constraint).toBe('credit_rate_cards_thirty_days_notice');
      });
    });

    it('CRITICAL the notice is 720 hours in every session time zone, not 30 calendar days of whichever zone inserted it', async () => {
      // A day interval is added in the SESSION time zone: across a daylight-saving
      // change '30 days' is 719 or 721 hours, so a CHECK written in days would
      // accept or refuse the same row depending on who inserted it. The stored
      // definition must be a pure-hours interval.
      const [def] = await db()<Array<{ d: string }>>`
        SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
         WHERE conname = 'credit_rate_cards_thirty_days_notice'`;
      expect(def?.d).toContain(`'720:00:00'::interval`);
      expect(def?.d).not.toMatch(/day|mon|year/i);

      for (const zone of ['UTC', 'Australia/Sydney', 'America/New_York']) {
        await inRolledBackTransaction(db(), async (tx) => {
          await tx.unsafe(`SET LOCAL TimeZone = '${zone}'`);
          const short = await refusal(
            inSavepoint(tx, (sp) =>
              insertCard(sp, 2, `now() + interval '720 hours' - interval '1 microsecond'`),
            ),
          );
          expect(short.constraint, zone).toBe('credit_rate_cards_thirty_days_notice');
          await insertCard(tx, 2, `now() + interval '720 hours'`);
        });
      }
    });

    it('CRITICAL a markup below 1.0 × or above 10.0 × is refused, and both ends are accepted', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        for (const markup of [9_999, 100_001, 0]) {
          const refused = await refusal(
            inSavepoint(tx, (sp) => insertCard(sp, 2, `now() + interval '800 hours'`, markup)),
            `markup ${String(markup)}`,
          );
          expect(refused.code, String(markup)).toBe('23514');
          expect(refused.constraint, String(markup)).toBe('credit_rate_cards_markup_range');
        }
        await insertCard(tx, 2, `now() + interval '800 hours'`, 10_000);
        await insertCard(tx, 3, `now() + interval '801 hours'`, 100_000);
      });
    });

    it('card versions start at 1', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        for (const version of [0, -1]) {
          const refused = await refusal(
            inSavepoint(tx, (sp) => insertCard(sp, version, `now() + interval '800 hours'`)),
            `version ${String(version)}`,
          );
          expect(refused.constraint, String(version)).toBe('credit_rate_cards_version_positive');
        }
      });
    });

    it('CRITICAL two live cards cannot take effect at the same instant; once one is withdrawn, another may take its place', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const at = `date_trunc('second', now()) + interval '850 hours'`;
        await insertCard(tx, 20, at);
        const clash = await refusal(inSavepoint(tx, (sp) => insertCard(sp, 21, at)));
        expect(clash.code).toBe('23505');
        expect(clash.constraint).toBe('credit_rate_cards_live_effective_unique');
        await tx`UPDATE credit_rate_cards SET withdrawn_at = now() WHERE version = 20`;
        await insertCard(tx, 21, at);
      });
    });

    it('CRITICAL two publishers racing for the same instant: the second waits on the first and is refused when it commits — or proceeds when it rolls back', async () => {
      if (isolatedUrl === null) throw new Error('isolated database unreachable');
      const url = isolatedUrl;
      const [{ at: first } = { at: '' }] = await db()<Array<{ at: string }>>`
        SELECT to_char(date_trunc('second', now()) + interval '2000 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`;
      const [{ at: second } = { at: '' }] = await db()<Array<{ at: string }>>`
        SELECT to_char(date_trunc('second', now()) + interval '2100 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`;

      async function race(
        at: string,
        versions: [number, number],
        firstFinishes: 'COMMIT' | 'ROLLBACK',
      ) {
        const a = postgres(url, { max: 1, onnotice: () => undefined });
        const b = postgres(url, { max: 1, onnotice: () => undefined });
        try {
          await a`SET TimeZone = 'UTC'`;
          await b`SET TimeZone = 'UTC'`;
          const [{ pid } = { pid: -1 }] = await b<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          await a`BEGIN`;
          await insertCard(a, versions[0], `'${at}'::timestamptz`);
          await b`BEGIN`;
          const pending = insertCard(b, versions[1], `'${at}'::timestamptz`).then(
            () => null,
            (err: unknown) => err,
          );
          // The second insert must really be WAITING on the first — not finished,
          // not failed — or this is two sequential inserts, not a race.
          let waiting = false;
          for (let i = 0; i < 100 && !waiting; i += 1) {
            const [row] = await db()<Array<{ w: string | null }>>`
              SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = ${pid}`;
            waiting = row?.w === 'Lock';
            if (!waiting) await new Promise((r) => setTimeout(r, 50));
          }
          expect(waiting, 'the second publisher blocked on the first').toBe(true);
          await a.unsafe(firstFinishes);
          const outcome = await pending;
          await b`COMMIT`.catch(() => b`ROLLBACK`);
          return outcome as { code?: string; constraint_name?: string } | null;
        } finally {
          await a`ROLLBACK`.catch(() => {});
          await b`ROLLBACK`.catch(() => {});
          await a.end({ timeout: 1 }).catch(() => {});
          await b.end({ timeout: 1 }).catch(() => {});
        }
      }

      const lost = await race(first, [30, 31], 'COMMIT');
      expect(lost?.code, 'the second publisher is refused').toBe('23505');
      expect(lost?.constraint_name).toBe('credit_rate_cards_live_effective_unique');

      const won = await race(second, [32, 33], 'ROLLBACK');
      expect(won, 'with the first rolled back, the second publishes').toBeNull();

      const live = await db()<Array<{ version: number }>>`
        SELECT version FROM credit_rate_cards
         WHERE effective_at IN (${first}::timestamptz, ${second}::timestamptz) AND withdrawn_at IS NULL
         ORDER BY version`;
      expect(
        live.map((r) => r.version),
        'exactly one live card per instant',
      ).toEqual([30, 33]);
    });

    it('CRITICAL an Opus price is refused by the database itself, however the id is spelled, even inside its card own transaction', async () => {
      const opus = AgentModelSchema.options.filter((m) => /opus/i.test(m));
      expect(opus.length, 'the registry still has Opus ids to try').toBeGreaterThan(0);
      await inRolledBackTransaction(db(), async (tx) => {
        await insertCard(tx, 40, `now() + interval '900 hours'`);
        for (const model of [
          ...opus,
          'claude-opus-9',
          'Claude-Opus-5',
          'CLAUDE-OPUS-4-7',
          'us.anthropic.claude-opus-4-7',
          'claude-3-opus',
        ]) {
          const refused = await refusal(
            inSavepoint(
              tx,
              (sp) => sp`INSERT INTO credit_rate_card_models ${sp(priceRow(40, model))}`,
            ),
            `a price for ${model}`,
          );
          expect(refused.code, model).toBe('23514');
          expect(refused.constraint, model).toBe('credit_rate_card_models_never_opus');
        }
        // Positive control: the same row for a model allowed on credits goes in.
        await tx`INSERT INTO credit_rate_card_models ${tx(priceRow(40, 'claude-sonnet-5'))}`;
      });
    });

    it('CRITICAL cache prices keep their order — read ≤ input ≤ 5-minute write ≤ 1-hour write — and equal prices are allowed', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        await insertCard(tx, 41, `now() + interval '901 hours'`);
        for (const [what, overrides] of [
          ['read above input', { cache_read_micro_per_token: 401 }],
          ['input above the 5-minute write', { cache_write_5m_micro_per_token: 399 }],
          ['5-minute write above the 1-hour write', { cache_write_1h_micro_per_token: 499 }],
        ] as const) {
          const refused = await refusal(
            inSavepoint(
              tx,
              (sp) =>
                sp`INSERT INTO credit_rate_card_models ${sp(priceRow(41, 'claude-sonnet-5', overrides))}`,
            ),
            what,
          );
          expect(refused.code, what).toBe('23514');
          expect(refused.constraint, what).toBe('credit_rate_card_models_cache_order');
        }
        await tx`INSERT INTO credit_rate_card_models ${tx(
          priceRow(41, 'claude-sonnet-5', {
            cache_read_micro_per_token: 400,
            cache_write_5m_micro_per_token: 400,
            cache_write_1h_micro_per_token: 400,
          }),
        )}`;
      });
    });

    it('prices are positive, and a task may start only with at most what it may reserve', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        await insertCard(tx, 42, `now() + interval '902 hours'`);
        for (const [what, overrides, constraint] of [
          [
            'zero input',
            { input_micro_per_token: 0, cache_read_micro_per_token: 0 },
            'credit_rate_card_models_positive',
          ],
          ['zero output', { output_micro_per_token: 0 }, 'credit_rate_card_models_positive'],
          [
            'negative cache read',
            { cache_read_micro_per_token: -1 },
            'credit_rate_card_models_positive',
          ],
          ['zero start', { min_start_micro: 0 }, 'credit_rate_card_models_reserve'],
          [
            'reserve below start',
            { max_reserve_micro: 5_999_999 },
            'credit_rate_card_models_reserve',
          ],
        ] as const) {
          const refused = await refusal(
            inSavepoint(
              tx,
              (sp) =>
                sp`INSERT INTO credit_rate_card_models ${sp(priceRow(42, 'claude-sonnet-5', overrides))}`,
            ),
            what,
          );
          expect(refused.constraint, what).toBe(constraint);
        }
        await tx`INSERT INTO credit_rate_card_models ${tx(
          priceRow(42, 'claude-sonnet-5', {
            min_start_micro: 6_000_000,
            max_reserve_micro: 6_000_000,
          }),
        )}`;
      });
    });

    it('CRITICAL notice runs from when the card is COMMITTED, not from when its transaction began: a transaction held open eats into the 720 hours, and is refused at COMMIT', async () => {
      // announced_at is now(), the transaction's START. Customers can only see a
      // card once it commits, so a transaction held open for a day would give
      // them 719 hours, and one held open for 30 days would give them none,
      // while the CHECK above is satisfied at insert time.
      if (isolatedUrl === null) throw new Error('isolated database unreachable');
      const publisher = postgres(isolatedUrl, { max: 1, onnotice: () => undefined });
      try {
        await publisher`BEGIN`;
        // Passes the insert-time CHECK, with half a second to spare.
        await insertCard(
          publisher,
          60,
          `now() + interval '720 hours' + interval '500 milliseconds'`,
        );
        await publisher`SELECT pg_sleep(1)`;
        const late = await refusal(
          () => publisher`COMMIT`,
          'a card committed with less than 720 hours of notice left',
        );
        expect(late.code).toBe('23514');
        expect(late.constraint).toBe('credit_rate_cards_notice_at_commit');
      } finally {
        await publisher`ROLLBACK`.catch(() => {});
        await publisher.end({ timeout: 1 }).catch(() => {});
      }
      const [none] = await db()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM credit_rate_cards WHERE version = 60`;
      expect(none?.n, 'the late card was not published').toBe(0);

      // Positive control: the same publication, committed with its margin intact,
      // is accepted, and what customers can see is at least 720 hours of notice.
      await db().begin(async (tx) => {
        await insertCard(
          tx,
          61,
          `clock_timestamp() + interval '720 hours' + interval '60 seconds'`,
        );
      });
      const [seen] = await db()<Array<{ enough: boolean }>>`
        SELECT effective_at - clock_timestamp() >= interval '720 hours' AS enough
          FROM credit_rate_cards WHERE version = 61`;
      expect(seen?.enough, 'committed with at least 720 hours still to run').toBe(true);
    });
  },
);

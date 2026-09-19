// A published credit rate card can only be withdrawn before it takes effect;
// nothing else about it, or about its prices, can ever change.
//
// What a customer pays per token lives in `credit_rate_cards` and
// `credit_rate_card_models` (migration 0127). A task pins the card in force
// when it starts, so a card that could be edited afterwards would reprice work
// already done, and a price added to a card later would give it a rate nobody
// was given notice of. Both rules are held by the DATABASE, by trigger, so no
// code path — a repo, an admin tool, a hand-typed psql session — can bypass
// them. This file proves each one with raw SQL against a database built fresh
// from the migrations, with no application code in between.
//
// The database is rebuilt for every run (`ensureFreshIsolatedDatabase`): rows
// here cannot be deleted, by design, so a kept database would carry the last
// run's cards into this one.

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREDIT_RATE_CARD_V1, type CreditRateCardModelRow } from '@driftstack/api-types';
import { assertIsolatedDatabase } from './_helpers/isolated-database.js';
import { ensureFreshIsolatedDatabase } from './_helpers/fresh-isolated-database.js';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_rate_card_immutable';
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
  // Rows committed here are permanent; prove which database they land in.
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

/** The launch Sonnet 5 row as insertable columns, for a card `version` and a `model` id. */
function priceRow(version: number, model: string): Record<string, string | number> {
  const row: Record<string, string | number> = { version, model };
  const sonnet = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
  for (const [field, column] of Object.entries(COLUMN_OF) as Array<
    [keyof CreditRateCardModelRow, string]
  >) {
    row[column] = sonnet[field];
  }
  return row;
}

/** Insert a card taking effect `hours` from now. Returns nothing; read it back by version. */
async function insertCard(
  sql: postgres.Sql | postgres.TransactionSql,
  version: number,
  hours: number,
) {
  await sql`
    INSERT INTO credit_rate_cards (version, markup_bp, effective_at, note)
    VALUES (${version}, 20000, now() + make_interval(hours => ${hours}), 'test card')`;
}

interface CardSnapshot {
  version: number;
  markup_bp: number;
  announced_at: Date;
  effective_at: Date;
  withdrawn_at: Date | null;
  created_by_key_id: string | null;
  note: string;
}

async function card(version: number): Promise<CardSnapshot | undefined> {
  const [row] = await db()<CardSnapshot[]>`
    SELECT version, markup_bp, announced_at, effective_at, withdrawn_at, created_by_key_id, note
      FROM credit_rate_cards WHERE version = ${version}`;
  return row;
}

async function launchPrices(): Promise<Array<Record<string, string>>> {
  return db()<Array<Record<string, string>>>`
    SELECT * FROM credit_rate_card_models WHERE version = 1 ORDER BY model`;
}

/**
 * Commit a card that takes effect `ms` from now.
 *
 * The guards exist to make exactly this impossible (a card needs 720 hours of
 * notice), and no test can wait 720 hours. So the setup switches the table's
 * own triggers off inside its transaction and back on before it commits.
 * ALTER TABLE is transactional and holds an exclusive lock until then, so no
 * other session ever sees the guards off. The final check makes sure the
 * setup did not leave a guard disabled for the arms that follow.
 */
async function commitCardTakingEffectIn(version: number, ms: number): Promise<void> {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE credit_rate_cards DISABLE TRIGGER USER`;
    await tx`
      INSERT INTO credit_rate_cards (version, markup_bp, announced_at, effective_at, note)
      VALUES (${version}, 30000, now() - interval '800 hours',
              clock_timestamp() + make_interval(secs => ${ms / 1000}), 'takes effect imminently')`;
    await tx`ALTER TABLE credit_rate_cards ENABLE TRIGGER USER`;
  });
  const [off] = await db()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_trigger
     WHERE tgrelid = 'credit_rate_cards'::regclass AND NOT tgisinternal AND tgenabled <> 'O'`;
  expect(off?.n, 'every guard on credit_rate_cards is back on').toBe(0);
}

/** The card a reservation would pin right now: the query the reader runs. */
async function versionInForceNow(): Promise<number | null> {
  const [row] = await db()<Array<{ version: number }>>`
    SELECT version FROM credit_rate_cards
     WHERE effective_at <= now() AND withdrawn_at IS NULL
     ORDER BY effective_at DESC LIMIT 1`;
  return row?.version ?? null;
}

/** Poll until `version` is the card in force, as a reader sees it. */
async function waitUntilInForce(version: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if ((await versionInForceNow()) === version) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`card ${String(version)} never came into force`);
}

describe.skipIf(!RUN_DB_TESTS)(
  'a published credit rate card can only be withdrawn before it takes effect',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(isolatedUrl).not.toBeNull();
    });

    it('CRITICAL every UPDATE of the launch card is refused, whichever column it touches — including a withdrawal, because it is already in force', async () => {
      const before = await card(1);
      expect(before, 'the migration seeded card 1').toBeDefined();
      const edits: Array<[string, string]> = [
        ['note', `'edited'`],
        ['markup_bp', '30000'],
        ['effective_at', `now() + interval '1 day'`],
        ['announced_at', `now() - interval '1 day'`],
        ['created_by_key_id', 'gen_random_uuid()'],
        ['version', '99'],
        ['withdrawn_at', 'now()'],
      ];
      for (const [column, value] of edits) {
        const refused = await refusal(
          () => db().unsafe(`UPDATE credit_rate_cards SET ${column} = ${value} WHERE version = 1`),
          `an update of ${column}`,
        );
        expect(refused.code, column).toBe('55000');
        expect(refused.message, column).toMatch(/credit_rate_cards rows are immutable: UPDATE/);
      }
      expect(await card(1), 'card 1 is exactly as it was').toEqual(before);
    });

    it('CRITICAL a published card cannot be deleted', async () => {
      const refused = await refusal(() => db()`DELETE FROM credit_rate_cards WHERE version = 1`);
      expect(refused.code).toBe('55000');
      expect(refused.message).toMatch(/immutable: DELETE/);
      expect(await card(1)).toBeDefined();
    });

    it('CRITICAL a price row is never updated or deleted, whichever column', async () => {
      const before = await launchPrices();
      expect(before.length, 'the migration seeded the launch prices').toBeGreaterThanOrEqual(3);
      for (const column of ['model', 'version', ...Object.values(COLUMN_OF)]) {
        const value = column === 'model' ? `'claude-haiku-9'` : '1';
        const refused = await refusal(
          () =>
            db().unsafe(
              `UPDATE credit_rate_card_models SET ${column} = ${value} WHERE version = 1 AND model = 'claude-sonnet-5'`,
            ),
          `an update of ${column}`,
        );
        expect(refused.code, column).toBe('55000');
        expect(refused.message, column).toMatch(
          /credit_rate_card_models rows are immutable: UPDATE/,
        );
      }
      const deleted = await refusal(
        () => db()`DELETE FROM credit_rate_card_models WHERE version = 1`,
      );
      expect(deleted.code).toBe('55000');
      expect(deleted.message).toMatch(/immutable: DELETE/);
      expect(await launchPrices(), 'the launch prices are exactly as they were').toEqual(before);
    });

    it('CRITICAL a card that has not taken effect can be withdrawn once, in a later transaction, and the withdrawal is stamped now() whatever the caller wrote', async () => {
      await db().begin(async (tx) => {
        await insertCard(tx, 10, 800);
        await tx`INSERT INTO credit_rate_card_models ${tx(priceRow(10, 'claude-sonnet-5'))}`;
      });
      const [stamped] = await db().begin(
        async (tx) => tx<Array<{ stamped_now: boolean; withdrawn_at: Date }>>`
          UPDATE credit_rate_cards SET withdrawn_at = '2001-01-01T00:00:00Z'
           WHERE version = 10
          RETURNING withdrawn_at = now() AS stamped_now, withdrawn_at`,
      );
      expect(stamped?.stamped_now, 'withdrawn_at is the transaction time, not 2001').toBe(true);

      for (const [what, statement] of [
        [
          'a second withdrawal',
          `UPDATE credit_rate_cards SET withdrawn_at = now() WHERE version = 10`,
        ],
        ['un-withdrawing', `UPDATE credit_rate_cards SET withdrawn_at = NULL WHERE version = 10`],
        ['deleting it', `DELETE FROM credit_rate_cards WHERE version = 10`],
      ] as const) {
        const refused = await refusal(() => db().unsafe(statement), what);
        expect(refused.code, what).toBe('55000');
      }
      expect((await card(10))?.withdrawn_at, 'still withdrawn, at the first stamp').toEqual(
        stamped?.withdrawn_at,
      );
    });

    it('CRITICAL a withdrawal that also changes anything else is refused — the author included — and the card stays live until a clean withdrawal', async () => {
      await db()`
        INSERT INTO credit_rate_cards (version, markup_bp, effective_at, note, created_by_key_id)
        VALUES (11, 20000, now() + interval '900 hours', 'test card', gen_random_uuid())`;
      const before = await card(11);
      for (const [column, value] of [
        ['note', `'rewritten'`],
        ['markup_bp', '30000'],
        ['effective_at', `effective_at + interval '1 hour'`],
        ['announced_at', `announced_at - interval '1 hour'`],
        ['created_by_key_id', 'gen_random_uuid()'],
      ] as const) {
        const refused = await refusal(
          () =>
            db().unsafe(
              `UPDATE credit_rate_cards SET withdrawn_at = now(), ${column} = ${value} WHERE version = 11`,
            ),
          `a withdrawal that also changes ${column}`,
        );
        expect(refused.code, column).toBe('55000');
      }
      expect(await card(11), 'nothing changed').toEqual(before);

      // Positive control: the same card CAN be withdrawn, so the refusals above
      // were about the extra column, not about withdrawing.
      await db()`UPDATE credit_rate_cards SET withdrawn_at = now() WHERE version = 11`;
      expect((await card(11))?.withdrawn_at).not.toBeNull();
    });

    it('a card is never born withdrawn, and its announcement is stamped now() whatever the insert says', async () => {
      const [row] = await inRolledBackTransaction(
        db(),
        async (tx) => tx<Array<{ announced_now: boolean; withdrawn_at: Date | null }>>`
          INSERT INTO credit_rate_cards (version, markup_bp, announced_at, effective_at, withdrawn_at)
          VALUES (12, 20000, '2001-01-01T00:00:00Z', now() + interval '1000 hours', '2001-01-02T00:00:00Z')
          RETURNING announced_at = now() AS announced_now, withdrawn_at`,
      );
      expect(row?.announced_now, 'announced_at is the insert transaction time').toBe(true);
      expect(row?.withdrawn_at, 'withdrawn_at is cleared on insert').toBeNull();
    });

    it('CRITICAL prices are written only with their card: no later transaction can add one to the launch card, or to a card committed a moment ago', async () => {
      const onLaunch = await refusal(
        () => db()`INSERT INTO credit_rate_card_models ${db()(priceRow(1, 'claude-haiku-9'))}`,
      );
      expect(onLaunch.code).toBe('55000');
      expect(onLaunch.message).toMatch(/written once, with their card/);

      await insertCard(db(), 13, 1100);
      const onFresh = await refusal(
        () => db()`INSERT INTO credit_rate_card_models ${db()(priceRow(13, 'claude-sonnet-5'))}`,
      );
      expect(onFresh.code).toBe('55000');
      expect(onFresh.message).toMatch(/written once, with their card/);
      const counts = await db()<Array<{ version: number; n: number }>>`
        SELECT c.version, count(m.model)::int AS n
          FROM credit_rate_cards c LEFT JOIN credit_rate_card_models m ON m.version = c.version
         WHERE c.version IN (1, 13) GROUP BY c.version ORDER BY c.version`;
      expect(counts, 'the launch card kept its seeded prices and card 13 has none').toEqual([
        { version: 1, n: Object.keys(CREDIT_RATE_CARD_V1.models).length },
        { version: 13, n: 0 },
      ]);
    });

    it('the same price row, written in its card own transaction, is accepted — the refusal above is about WHEN, not WHAT', async () => {
      const n = await inRolledBackTransaction(db(), async (tx) => {
        await insertCard(tx, 14, 1200);
        await tx`INSERT INTO credit_rate_card_models ${tx(priceRow(14, 'claude-sonnet-5'))}`;
        await tx`INSERT INTO credit_rate_card_models ${tx(priceRow(14, 'claude-haiku-9'))}`;
        const [row] = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM credit_rate_card_models WHERE version = 14`;
        return row?.n;
      });
      expect(n).toBe(2);
    });

    it('CRITICAL while one transaction is still creating a card, another cannot write its prices — without waiting on it — and still cannot once it commits', async () => {
      if (isolatedUrl === null) throw new Error('isolated database unreachable');
      const creator = postgres(isolatedUrl, { max: 1, onnotice: () => undefined });
      const intruder = postgres(isolatedUrl, { max: 1, onnotice: () => undefined });
      try {
        await creator`BEGIN`;
        await insertCard(creator, 15, 1300);

        const started = Date.now();
        const during = await refusal(
          () =>
            intruder`INSERT INTO credit_rate_card_models ${intruder(priceRow(15, 'claude-sonnet-5'))}`,
        );
        expect(during.code, 'refused while the card is uncommitted').toBe('55000');
        expect(
          Date.now() - started,
          'refused at once, not after waiting on the creator',
        ).toBeLessThan(2_000);

        await creator`INSERT INTO credit_rate_card_models ${creator(priceRow(15, 'claude-sonnet-5'))}`;
        await creator`COMMIT`;

        const after = await refusal(
          () =>
            intruder`INSERT INTO credit_rate_card_models ${intruder(priceRow(15, 'claude-haiku-9'))}`,
        );
        expect(after.code, 'refused after the card committed').toBe('55000');

        const models = await db()<Array<{ model: string }>>`
          SELECT model FROM credit_rate_card_models WHERE version = 15 ORDER BY model`;
        expect(
          models.map((m) => m.model),
          'only the creator wrote a price',
        ).toEqual(['claude-sonnet-5']);
      } finally {
        await creator`ROLLBACK`.catch(() => {});
        await creator.end({ timeout: 1 }).catch(() => {});
        await intruder.end({ timeout: 1 }).catch(() => {});
      }
    });

    // "Before it takes effect" is judged on the clock, not on the transaction's
    // start time (now()). A withdrawal whose transaction began before the card's
    // date would otherwise be accepted however late it ran, stamped with that
    // earlier start: the card would have been the card in force for readers, so
    // a task could have been priced on it, and the record would then say it
    // never was.

    it('CRITICAL a withdrawal whose transaction began before the card took effect, but which runs after, is refused — the card was already in force', async () => {
      if (isolatedUrl === null) throw new Error('isolated database unreachable');
      const withdrawer = postgres(isolatedUrl, { max: 1, onnotice: () => undefined });
      try {
        // Begin FIRST: the withdrawing transaction's now() is then before the
        // card's date by construction, not by how quickly the next lines run.
        // A bare BEGIN holds no lock, so the setup's ALTER TABLE cannot wait on it.
        await withdrawer`BEGIN`;
        await commitCardTakingEffectIn(50, 1_500);
        const [start] = await withdrawer<Array<{ before: boolean }>>`
          SELECT now() < effective_at AS before FROM credit_rate_cards WHERE version = 50`;
        expect(start?.before, 'the withdrawing transaction began before the card took effect').toBe(
          true,
        );

        await waitUntilInForce(50);
        // Refused by the statement itself, on the clock — not left to COMMIT.
        const refused = await refusal(
          () => withdrawer`UPDATE credit_rate_cards SET withdrawn_at = now() WHERE version = 50`,
          'a withdrawal made after the card took effect',
        );
        expect(refused.code).toBe('55000');
        expect(refused.message).toMatch(/credit_rate_cards rows are immutable: UPDATE/);
      } finally {
        await withdrawer`ROLLBACK`.catch(() => {});
        await withdrawer.end({ timeout: 1 }).catch(() => {});
      }
      expect(
        (await card(50))?.withdrawn_at,
        'card 50 stays live: it was in force, and the record keeps saying so',
      ).toBeNull();
      expect(await versionInForceNow()).toBe(50);
    });

    it('CRITICAL a withdrawal made before the card takes effect but COMMITTED after is refused at COMMIT — until then every reader still saw the card in force', async () => {
      if (isolatedUrl === null) throw new Error('isolated database unreachable');
      const withdrawer = postgres(isolatedUrl, { max: 1, onnotice: () => undefined });
      try {
        await commitCardTakingEffectIn(51, 3_000);
        await withdrawer`BEGIN`;
        // Accepted: at this statement the card has not taken effect.
        await withdrawer`UPDATE credit_rate_cards SET withdrawn_at = now() WHERE version = 51`;
        // The withdrawal is not committed, so readers keep pricing on card 51.
        await waitUntilInForce(51);
        const refused = await refusal(
          () => withdrawer`COMMIT`,
          'a withdrawal committed after the card took effect',
        );
        expect(refused.code).toBe('55000');
        expect(refused.constraint).toBe('credit_rate_cards_withdrawal_at_commit');
      } finally {
        await withdrawer`ROLLBACK`.catch(() => {});
        await withdrawer.end({ timeout: 1 }).catch(() => {});
      }
      expect((await card(51))?.withdrawn_at, 'card 51 stays live').toBeNull();
      expect(await versionInForceNow()).toBe(51);
    });
  },
);

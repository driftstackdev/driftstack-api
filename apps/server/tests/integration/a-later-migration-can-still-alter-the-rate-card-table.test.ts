// A later migration can still alter the rate-card table: on a database built
// from zero, and in the same deploy batch as the migration that created it.
//
// The migrator applies every pending migration in ONE transaction. For a deploy
// that is its batch; for a fresh database (CI, every isolated test database, a
// new checkout) it is the whole chain from the first migration. The rate-card
// migration installs a DEFERRED constraint trigger on `credit_rate_cards` and
// inserts the launch card. Had that insert queued a deferred event, Postgres
// would refuse ALTER TABLE and CREATE INDEX on the table for the rest of the
// transaction ("cannot ALTER TABLE … because it has pending trigger events").
// The first migration ever to add a column to the rate card would then fail on
// every fresh database and in the deploy that shipped it, and the only repair
// would be an edit to a migration production had already applied.
//
// So this runs the REAL migrator over a copy of the real migrations folder, with
// one synthetic migration appended that alters and indexes the table, against a
// database created empty for the run. A second arm shows the synthetic statement
// is sensitive to exactly this: with a later card's notice check pending, the
// same ALTER TABLE is refused.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedDatabase } from './_helpers/isolated-database.js';
import { recreateEmptyIsolatedDatabase } from './_helpers/fresh-isolated-database.js';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';

const ISOLATED_DB_NAME = 'driftstack_iso_rate_card_next_migration';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const PROBE_TAG = '9999_probe_a_later_migration_alters_the_rate_card';
const PROBE_COLUMN = 'probe_later_column';
const PROBE_INDEX = 'credit_rate_cards_probe_later_idx';

let folder: string | null = null;
let expectedRows = -1;
let client: postgres.Sql | null = null;
/** undefined: the migrator never ran; null: it succeeded; otherwise what it threw. */
let migrateOutcome: unknown = undefined;

/**
 * The database's own words for a failed migration. Drizzle wraps the Postgres
 * error in one that quotes the whole failed query; the SQLSTATE and the reason
 * are on its `cause`.
 */
function describeFailure(err: unknown): string {
  const e = err as { message?: unknown; cause?: { code?: unknown; message?: unknown } };
  const cause = e.cause;
  if (cause !== undefined && typeof cause.message === 'string') {
    return `${String(cause.code)}: ${cause.message}`;
  }
  return String(e.message ?? err);
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  folder = mkdtempSync(join(tmpdir(), 'rate-card-next-migration-'));
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
  const last = journal.entries[journal.entries.length - 1];
  if (last === undefined) throw new Error('the migration journal has no entries');
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: PROBE_TAG });
  expectedRows = journal.entries.length;
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(
    join(folder, `${PROBE_TAG}.sql`),
    `ALTER TABLE "credit_rate_cards" ADD COLUMN "${PROBE_COLUMN}" text;\n` +
      `CREATE INDEX "${PROBE_INDEX}" ON "credit_rate_cards" ("announced_at");\n`,
  );

  const url = await recreateEmptyIsolatedDatabase(ISOLATED_DB_NAME);
  if (url === null) return;
  const candidate = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await candidate`SELECT 1`;
  } catch {
    await candidate.end({ timeout: 1 }).catch(() => {});
    return;
  }
  await assertIsolatedDatabase(candidate, ISOLATED_DB_NAME);
  client = candidate;
  try {
    await migrate(drizzle(candidate), { migrationsFolder: folder });
    migrateOutcome = null;
  } catch (err) {
    migrateOutcome = err;
  }
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  if (folder !== null) rmSync(folder, { recursive: true, force: true });
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

describe.skipIf(!RUN_DB_TESTS)('a later migration can still alter the rate-card table', () => {
  it('the isolated database was created empty and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL from zero, the whole chain plus a later migration that adds a column to credit_rate_cards and indexes it applies — in ONE transaction, as the migrator runs a batch', async () => {
    const outcome =
      migrateOutcome === undefined
        ? 'the migrator never ran'
        : migrateOutcome === null
          ? null
          : describeFailure(migrateOutcome);
    expect(outcome, 'the migrator refused the batch').toBeNull();

    const [journal] = await db()<Array<{ rows: number; transactions: number; newest: string }>>`
      SELECT count(*)::int AS rows, count(DISTINCT xmin::text)::int AS transactions,
             max(created_at)::text AS newest
        FROM drizzle.__drizzle_migrations`;
    expect(journal?.rows, 'every migration, and the probe, was recorded').toBe(expectedRows);
    // Every row written by one transaction shares its xmin. One value means the
    // probe ran in the same transaction as the rate-card migration's seed, which
    // is the case this file exists for.
    expect(journal?.transactions, 'the migrator applied the batch in one transaction').toBe(1);

    const [column] = await db()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'credit_rate_cards' AND column_name = ${PROBE_COLUMN}`;
    expect(column?.n, 'the later migration added its column').toBe(1);
    const [index] = await db()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_indexes
       WHERE tablename = 'credit_rate_cards' AND indexname = ${PROBE_INDEX}`;
    expect(index?.n, 'the later migration created its index').toBe(1);
    const [launch] = await db()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM credit_rate_cards WHERE version = 1 AND withdrawn_at IS NULL`;
    expect(launch?.n, 'the launch card was seeded in that same batch').toBe(1);
  });

  it('CRITICAL the probe can see the hazard: with a later card notice check pending, the same ALTER TABLE is refused — so the arm above passes because nothing was pending, not because the statement cannot fail', async () => {
    await inRolledBackTransaction(db(), async (tx) => {
      await tx`
        INSERT INTO credit_rate_cards (version, markup_bp, effective_at, note)
        VALUES (2, 20000, now() + interval '800 hours', 'test card')`;
      const refused = await refusal(
        () => tx.savepoint((sp) => sp`ALTER TABLE credit_rate_cards ADD COLUMN probe_pending text`),
        'an ALTER TABLE while a card notice check is pending',
      );
      expect(refused.code, 'object_in_use').toBe('55006');
      expect(refused.message).toMatch(/pending trigger events/);
    });
  });
});

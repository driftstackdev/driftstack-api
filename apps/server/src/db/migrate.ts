// Apply pending Drizzle migrations to the configured Postgres.
// Run with `npm run db:migrate` (i.e. `tsx src/db/migrate.ts`).

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../lib/config.js';

// V-667.C-followup — migrations live in the source tree, but the
// compiled migrate.js ends up at dist/db/migrate.js. Resolving
// `here/migrations` works in dev (here = src/db) but points at a
// non-existent dist/db/migrations directory in prod. Fall back to
// the src tree (two directories up from dist/db) when the compiled
// neighbour is absent. Avoids needing to copy migrations into dist
// or maintain a separate prod migration runner.
function resolveMigrationsFolder(here: string): string {
  const compiledNeighbour = resolve(here, 'migrations');
  if (existsSync(resolve(compiledNeighbour, 'meta/_journal.json'))) {
    return compiledNeighbour;
  }
  return resolve(here, '..', '..', 'src', 'db', 'migrations');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolveMigrationsFolder(here);

  // Count journal entries up front — this is the expected post-state
  // for __drizzle_migrations after migrate() returns. Drift between
  // these counts is the "silent-skip" class of bug (drizzle-orm's
  // migrator has historically reported "migrations applied" without
  // actually inserting all rows in some transaction-rollback states;
  // see 2026-05-15-deploy-pipeline-mismatch.md). The post-condition
  // check below makes that failure mode loudly observable.
  const journalPath = resolve(migrationsFolder, 'meta/_journal.json');
  const journalRaw = readFileSync(journalPath, 'utf8');
  const journal = JSON.parse(journalRaw) as { entries: unknown[] };
  const expectedCount = journal.entries.length;

  // Every other line this script writes is one-line JSON, deliberately, so a
  // deploy's log collector can parse the migration step. postgres-js's DEFAULT
  // notice handler writes a raw, ANSI-coloured object dump to the same stream —
  // `relation "__drizzle_migrations" already exists, skipping` arrives as a
  // multi-line blob with `file`, `line` and `routine` fields — which breaks that
  // contract precisely where it matters, in the output of a deploy step.
  //
  // Re-emitted as structured JSON rather than swallowed. `client.ts` swallows
  // notices because Pino carries real operational signal there; here there is no
  // Pino and the notices are worth keeping — "already exists, skipping" is how an
  // operator sees that a re-run was the no-op it should have been.
  const client = postgres(config.databaseUrl, {
    max: 1,
    onnotice: (notice) => {
      // `detail` is a real Postgres field, and it is where the substance goes
      // when a statement cascades: the message summarises ("drop cascades to 69
      // other objects") and the 69 lines arrive in `detail`. Carrying only the
      // message would log a migration's blast radius as a number — and naming
      // the message "detail" would leave nowhere to put the real one.
      console.warn(
        JSON.stringify({
          msg: 'postgres notice during migration',
          severity: notice.severity,
          code: notice.code,
          notice: notice.message,
          ...(typeof notice.detail === 'string' && notice.detail !== ''
            ? { detail: notice.detail }
            : {}),
        }),
      );
    },
  });
  const db = drizzle(client);

  console.warn(JSON.stringify({ msg: 'applying migrations', migrationsFolder, expectedCount }));
  await migrate(db, { migrationsFolder });

  // Post-condition: row count in drizzle.__drizzle_migrations must
  // match the journal. Exit non-zero on mismatch so deploy-bridge's
  // auto-revert fires (the new code IS deployed, but the schema is
  // out of step; reverting to the prior SHA is safer than booting on
  // a half-applied state).
  const result = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
  );
  const rows = result as unknown as Array<{ count: string }>;
  const actualCount = Number(rows[0]?.count ?? '0');
  if (actualCount !== expectedCount) {
    console.error(
      JSON.stringify({
        msg: 'migration post-condition FAIL',
        expectedCount,
        actualCount,
        gap: expectedCount - actualCount,
        hint: 'drizzle.__drizzle_migrations row count does not match _journal.json entry count. Likely silent-skip from drizzle-orm migrator. Run the pending migrations manually via psql -f and INSERT the corresponding hashes into drizzle.__drizzle_migrations.',
      }),
    );
    await client.end({ timeout: 5 });
    process.exit(2);
  }
  console.warn(JSON.stringify({ msg: 'migrations applied', appliedCount: actualCount }));

  await client.end({ timeout: 5 });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

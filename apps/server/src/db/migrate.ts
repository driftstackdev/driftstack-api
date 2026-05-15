// Apply pending Drizzle migrations to the configured Postgres.
// Run with `npm run db:migrate` (i.e. `tsx src/db/migrate.ts`).

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { existsSync } from 'node:fs';
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

  const client = postgres(config.databaseUrl, { max: 1 });
  const db = drizzle(client);

  console.warn(JSON.stringify({ msg: 'applying migrations', migrationsFolder }));
  await migrate(db, { migrationsFolder });
  console.warn(JSON.stringify({ msg: 'migrations applied' }));

  await client.end({ timeout: 5 });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

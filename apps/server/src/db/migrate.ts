// Apply pending Drizzle migrations to the configured Postgres.
// Run with `npm run db:migrate` (i.e. `tsx src/db/migrate.ts`).

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../lib/config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, 'migrations');

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

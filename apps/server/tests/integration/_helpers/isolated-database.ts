// A dedicated Postgres database for a test file that runs a GLOBAL sweep.
//
// Nine repo methods migrate an encryption envelope by scanning their whole
// table — `encryptLegacySecrets`, `migrateTranscriptEnvelopes`,
// `migrateWrappedDekEnvelopes` and siblings. They take no account scope, so on
// a shared database their behaviour depends on rows belonging to whichever
// other test file happens to be running.
//
// That is not hypothetical. It produced two separate intermittent CI failures
// with different mechanisms: a row whose secret was not convertible made the
// sweep THROW, and later a syntactically-v2 fixture made the key PROBE throw.
// A third instance appeared when a purge test seeded an agent session by raw
// SQL and the transcript migration rejected the plaintext.
//
// Fixture discipline cannot close this. A row is always in exactly one of two
// sets — the sweep selects NOT-v2, the probe selects v2 — so no value is
// invisible to both. Each fixture fix stops one mechanism and leaves the other
// reachable.
//
// Giving each sweeping file its own database removes the shared state instead
// of negotiating with it, and the property then holds BY CONSTRUCTION: no other
// file's rows exist in what the sweep sees.
//
// Cheap enough to be uninteresting: measured at ~0.2s to create and migrate a
// fresh database locally (110 migrations), and migrations are idempotent, so a
// warm run pays only a `pg_database` lookup.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';

const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/db/migrations',
);

function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Create (if absent) and migrate a database dedicated to one test file, and
 * return its connection URL.
 *
 * Returns `null` when Postgres is unreachable or the database cannot be
 * created, so a checkout without Postgres SKIPS the file rather than failing
 * it — callers keep their own `dbReachable` probe as the single source of that
 * decision.
 *
 * @param name database name; use one distinct name per test file, or two files
 *             sweeping the same table will collide with each other and the
 *             whole point is lost.
 */
export async function ensureIsolatedDatabase(name: string): Promise<string | null> {
  const base = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const dbUrl = withDatabase(base, name);
  const admin = postgres(withDatabase(base, 'postgres'), {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 1,
  });
  try {
    const [existing] = await admin<Array<{ n: number }>>`
      SELECT 1 AS n FROM pg_database WHERE datname = ${name}`;
    if (existing === undefined) {
      // Not parameterisable — an identifier, not a value. `name` is a literal
      // supplied by a test file, never user input, and is quoted here so a
      // mistyped one fails loudly rather than doing something surprising.
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    }
    await admin.end({ timeout: 1 });
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    return null;
  }
  const migrator = postgres(dbUrl, { max: 1 });
  try {
    await migrate(drizzle(migrator), { migrationsFolder: MIGRATIONS_FOLDER });
    return dbUrl;
  } catch {
    return null;
  } finally {
    await migrator.end({ timeout: 5 }).catch(() => {});
  }
}

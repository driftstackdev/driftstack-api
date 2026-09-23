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

/**
 * The database a test file's isolated name resolves to in THIS run.
 *
 * Two runs of the same test file at once — a gate in a clean clone and a
 * builder in the working tree — would otherwise share one database, and a file
 * that rebuilds its database on every run drops it out from under the other
 * (2026-09-23: a gate failed with `database "driftstack_iso_twin_property"
 * does not exist` while an auditor ran the same file). A run that may overlap
 * sets `DRIFTSTACK_ISO_DB_SUFFIX` (lowercase letters, digits, underscore; up to
 * 8), and every isolated database it touches gets that suffix. Unset — every
 * other run, and CI — the name is used as written.
 */
export function isolatedDatabaseName(name: string): string {
  const suffix = (process.env.DRIFTSTACK_ISO_DB_SUFFIX ?? '').trim();
  if (suffix === '') return name;
  if (!/^[a-z0-9_]{1,8}$/.test(suffix)) {
    throw new Error(
      `DRIFTSTACK_ISO_DB_SUFFIX must be 1-8 lowercase letters, digits or underscores; got ${JSON.stringify(suffix)}`,
    );
  }
  const resolved = `${name}_${suffix}`;
  // Postgres truncates identifiers at 63 bytes; two names that truncate to the
  // same prefix would silently share a database.
  if (resolved.length > 63) throw new Error(`isolated database name too long: ${resolved}`);
  return resolved;
}

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
export async function ensureIsolatedDatabase(requested: string): Promise<string | null> {
  const name = isolatedDatabaseName(requested);
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

/**
 * Refuse to proceed unless `client` is connected to the isolated database.
 *
 * For files that TRUNCATE. On their own database that is free; pointed anywhere
 * else it destroys whatever every other suite was relying on, and it does so
 * silently — the run stays green because the rows it deleted belonged to
 * somebody else.
 *
 * That is not hypothetical. Proving the public-feed isolation, a mutation that
 * pointed the client back at `DATABASE_URL` truncated the SHARED `incidents`
 * table, deleted the probe row the experiment was measuring, and SURVIVED —
 * because it had destroyed the evidence that would have failed it.
 *
 * `ensureIsolatedDatabase` returns a URL; nothing makes a caller connect with
 * it. This closes that gap at the only place it matters, and it is deliberately
 * a throw rather than an expect so it reads the same from a beforeAll as from a
 * helper.
 */
export async function assertIsolatedDatabase(
  client: ReturnType<typeof postgres>,
  name: string,
): Promise<void> {
  const rows = (await client`SELECT current_database() AS name`) as unknown as Array<{
    name: string;
  }>;
  const actual = rows[0]?.name;
  const expected = isolatedDatabaseName(name);
  if (actual !== expected) {
    throw new Error(
      `refusing to run: expected the isolated database "${expected}" but this client is on ` +
        `"${actual ?? '<unknown>'}". A TRUNCATE here would delete other suites' rows.`,
    );
  }
}

// An isolated test database REBUILT from the migrations on every run.
//
// `ensureIsolatedDatabase` keeps its database between runs, which is right for
// tables a test can reset. Some tables cannot be reset by design: the credit
// rate card refuses every UPDATE and DELETE by trigger, so a test that commits a
// card leaves it there for good, and a test that asserts "the card in force" or
// "only the launch card exists" would be reading the previous run's rows.
//
// Dropping the database first gives each run the state the migration chain
// alone produces — which is also the thing those tests mean to prove: that the
// migration, applied to a fresh database, installs the guarantees.
//
// ⛔ DROP DATABASE IS REFUSED FOR ANY NAME OUTSIDE `driftstack_iso_*`. The name
// is a literal in the calling test file; the check is what stops a typo or a
// refactor from pointing a DROP at the shared database.

import postgres from 'postgres';
import { ensureIsolatedDatabase } from './isolated-database.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const ISOLATED_NAME = /^driftstack_iso_[a-z0-9_]{1,40}$/;

function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Drop `name` if it exists and create it EMPTY, with no migrations applied.
 * Returns its URL, or `null` when Postgres is unreachable (the caller's
 * reachability arm turns that into a failure in CI).
 *
 * For a test that runs the migrator itself and needs to see how it fails;
 * `ensureIsolatedDatabase` reports a failed migration only as `null`.
 */
export async function recreateEmptyIsolatedDatabase(name: string): Promise<string | null> {
  if (!ISOLATED_NAME.test(name)) {
    throw new Error(`refusing to drop "${name}": only driftstack_iso_* databases are rebuilt`);
  }
  const base = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  if (new URL(base).pathname === `/${name}`) {
    throw new Error(`refusing to drop "${name}": it is the database DATABASE_URL points at`);
  }
  const admin = postgres(withDatabase(base, 'postgres'), {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 1,
    onnotice: () => undefined,
  });
  try {
    // An identifier, not a value: quoted, and already held to the pattern above.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch {
    return null;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
  return withDatabase(base, name);
}

/**
 * Drop `name` if it exists, then create and migrate it afresh. Returns its URL,
 * or `null` when Postgres is unreachable (the caller's reachability arm turns
 * that into a failure in CI).
 */
export async function ensureFreshIsolatedDatabase(name: string): Promise<string | null> {
  if ((await recreateEmptyIsolatedDatabase(name)) === null) return null;
  return ensureIsolatedDatabase(name);
}

// The shared test database must be at the latest migration.
//
// 232 integration files exist; 15 create and migrate their own database via
// `ensureIsolatedDatabase`. The other 47 that open a connection do so against
// the SHARED `driftstack` database and assume it is current. Nothing checked
// that assumption.
//
// When it is false the suite does not say so. It produces ordinary assertion
// failures deep inside unrelated tests — "returns one winner and four
// authoritative losers for five concurrent first revokes" and thirteen more,
// all reading exactly like real defects in revocation and rotation semantics.
// That is not hypothetical: a migration adding `created_by_account` to
// `api_keys` landed while this developer's database sat one migration behind,
// and diagnosing the fourteen failures took a full control run against a clean
// checkout to rule out the code.
//
// The cost of the confusion is the point. A stale database is a thirty-second
// fix; mistaking it for a concurrency bug in API-key revocation is an
// afternoon. So this fails FIRST and says which of the two it is.
//
// It cannot live in a shared helper without editing 47 files, which would
// collide with whatever else is in flight. As its own file it runs alongside
// them and gives the reader one legible failure to look at instead of fourteen
// misleading ones.

import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', '..', 'src', 'db', 'migrations');
const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

interface Journal {
  entries: Array<{ tag: string }>;
}

/** Migrations this checkout expects, from drizzle's own journal. */
function expectedMigrations(): string[] {
  const journal = JSON.parse(
    readFileSync(resolve(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  return journal.entries.map((e) => e.tag);
}

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
let applied = -1;

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    client = postgres(DB_URL, { max: 1 });
    const rows = await client<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`;
    applied = Number(rows[0]?.n ?? '-1');
  } catch {
    dbReachable = false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
});

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
});

// Gated exactly like the other db-* files, so a checkout without Postgres skips
// rather than fails.
describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'the shared test database is at the latest migration',
  () => {
    it('CRITICAL the database was reachable, so a pass means checked rather than skipped. Every assertion here is about the database being CURRENT; if the probe silently failed, "current" would be indistinguishable from "never looked".', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
      expect(
        applied,
        'applied-migration count read from drizzle.__drizzle_migrations',
      ).toBeGreaterThan(0);
    });

    it('CRITICAL this checkout declares migrations to apply, so the comparison below is not against an empty expectation.', () => {
      expect(expectedMigrations().length, 'migrations in the drizzle journal').toBeGreaterThan(100);
    });

    it('CRITICAL the shared database has every migration this checkout declares. Falling behind does NOT announce itself: 47 integration files run against this database and a missing column surfaces as ordinary assertion failures inside unrelated tests, which read exactly like real defects. Fourteen of them once cost a full control run to rule out the code.', () => {
      const expected = expectedMigrations();
      expect(
        applied,
        `the shared database at ${DB_URL} has ${applied} of ${expected.length} migrations. ` +
          `The newest this checkout declares is "${expected[expected.length - 1]}". ` +
          `Run \`npm run db:migrate\` — until then, failures in other db-* integration ` +
          `files are this, not the code under test.`,
      ).toBeGreaterThanOrEqual(expected.length);
    });
  },
);

// The Drizzle schema and the migrated database describe the same tables and
// columns — derived from both sides, against a real Postgres.
//
// `schema.ts` is what every repo in the server queries through, and the 112
// migration files are what actually shapes the database. Nothing compared them.
// The per-migration tests in this directory each verify one migration's data
// behaviour — an envelope re-encryption, a transcript backfill — and none asks
// whether the end state matches what the ORM believes.
//
// Both failure directions are ordinary mistakes with unequal consequences. A
// column added to `schema.ts` without a migration is the dangerous one: every
// SELECT that repo builds names a column the database does not have, and it
// fails at runtime, in production, on the first request that touches it —
// nothing in a unit test with an in-memory repo would notice. A column added by
// migration and never declared is milder but still real: the ORM cannot read it,
// so a NOT NULL addition breaks inserts and a backfill silently goes unused.
//
// Neither side is restated here. Tables and columns come from Drizzle's own
// `getTableConfig` rather than from parsing `schema.ts` — an early attempt at
// the regex version recovered 27 of 539 columns and would have reported almost
// everything verified while reading almost nothing. The database side comes from
// `information_schema`. The only name mentioned by hand is the migration
// bookkeeping table, which belongs to the migrator and not to the application.

import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Drizzle's own bookkeeping; not an application table. */
const MIGRATOR_TABLES = new Set(['__drizzle_migrations']);

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM information_schema.columns LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) await client.end({ timeout: 1 }).catch(() => {});
});

/** Every application table Drizzle declares, with its column names. */
function drizzleTables(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    try {
      const cfg = getTableConfig(value as never);
      if (typeof cfg.name === 'string' && cfg.name !== '') {
        out.set(cfg.name, new Set(cfg.columns.map((c) => c.name)));
      }
    } catch {
      // Not a table export — enums, helpers, types.
      //
      // This also swallows a table whose own declaration is broken, and that
      // changes what a failure looks like rather than whether one happens.
      // Deleting `profiles.name` makes an index that references it throw here,
      // so the table drops out entirely and the report reads "table profiles is
      // migrated but not declared" instead of naming the column. Both are true
      // from this file's position — it genuinely could not read the declaration
      // — and the run still fails, which is the part that matters. Worth
      // knowing before hunting a missing table that is not missing.
    }
  }
  return out;
}

/** Every table the migrated database has, with its column names. */
async function databaseTables(sql: ReturnType<typeof postgres>): Promise<Map<string, Set<string>>> {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'`;
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    if (MIGRATOR_TABLES.has(row.table_name)) continue;
    const cols = out.get(row.table_name) ?? new Set<string>();
    cols.add(row.column_name);
    out.set(row.table_name, cols);
  }
  return out;
}

function guardUnreachable(): boolean {
  if (dbReachable && client) return false;
  if (process.env.CI) {
    throw new Error(
      'real-PG schema comparison: database unreachable/unmigrated in CI — vacuous pass is forbidden',
    );
  }
  return true;
}

describe('the drizzle schema matches the migrated database', () => {
  it('CRITICAL both sides were read and are non-trivial. Every comparison below reports a difference, and two empty maps have no differences — a schema import that yielded nothing would report the database verified having compared nothing at all.', async () => {
    if (guardUnreachable()) return;
    const declared = drizzleTables();
    const actual = await databaseTables(client!);

    // MEASURED: 52 tables and 539 columns on both sides.
    expect(declared.size, 'tables declared in schema.ts').toBeGreaterThanOrEqual(45);
    expect(actual.size, 'tables in the migrated database').toBeGreaterThanOrEqual(45);
    const declaredColumns = [...declared.values()].reduce((n, c) => n + c.size, 0);
    expect(declaredColumns, 'columns recovered from Drizzle metadata').toBeGreaterThanOrEqual(500);
  });

  it('CRITICAL every table and column Drizzle declares exists in the database. This is the direction that fails in production rather than in a test: a repo builds a SELECT naming a column the database does not have, and an in-memory fixture will never notice.', async () => {
    if (guardUnreachable()) return;
    const declared = drizzleTables();
    const actual = await databaseTables(client!);

    const missing: string[] = [];
    for (const [table, columns] of declared) {
      const inDb = actual.get(table);
      if (inDb === undefined) {
        missing.push(`table ${table} is declared but not migrated`);
        continue;
      }
      for (const column of columns) {
        if (!inDb.has(column)) missing.push(`${table}.${column} is declared but not migrated`);
      }
    }
    expect(missing.sort(), 'schema declaration(s) with no matching database object:').toEqual([]);
  });

  it('CRITICAL every table and column the migrations create is declared. Milder than the other direction but still real — the ORM cannot read an undeclared column, so a NOT NULL addition breaks inserts and a backfill quietly goes unused.', async () => {
    if (guardUnreachable()) return;
    const declared = drizzleTables();
    const actual = await databaseTables(client!);

    const undeclared: string[] = [];
    for (const [table, columns] of actual) {
      const inSchema = declared.get(table);
      if (inSchema === undefined) {
        undeclared.push(`table ${table} is migrated but not declared`);
        continue;
      }
      for (const column of columns) {
        if (!inSchema.has(column))
          undeclared.push(`${table}.${column} is migrated but not declared`);
      }
    }
    expect(undeclared.sort(), 'database object(s) the schema does not declare:').toEqual([]);
  });
});

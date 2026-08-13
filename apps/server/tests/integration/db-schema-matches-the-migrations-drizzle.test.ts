// The Drizzle schema and the migrated database describe the same tables,
// columns, types, nullability and foreign keys — derived from both sides,
// against a real Postgres.
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
// Names alone are not enough, which is why type and nullability are compared
// too. A column declared `text` that Postgres holds as an enum accepts writes
// the database rejects; one drizzle marks `.notNull()` that is actually
// nullable makes the generated TypeScript actively wrong — the compiler
// promises a string and the row hands back null, so the failure lands wherever
// that value is next used rather than where the mismatch is.
//
// The type comparison needs a normaliser and getting it wrong is easy in a
// direction that looks like success in reverse. `information_schema` reports a
// scalar twice: `data_type` gives `timestamp with time zone`, `udt_name` gives
// `timestamptz`. Enums and arrays invert that — `data_type` is the placeholder
// `USER-DEFINED` or `ARRAY` and the real name is only in `udt_name`. A first
// version used `udt_name` throughout and reported 200 of 539 columns as
// mismatched, every one of them spelling differences. So: `data_type` for
// scalars, `udt_name` for enums and arrays, and drizzle's `numeric(38, 18)`
// loses its precision because `data_type` does not carry it.
//
// Foreign keys are compared with their ON DELETE action, because the action is
// the part that carries data-integrity meaning. A cascade the schema does not
// know about is not a harmless omission: migrations regenerated from the schema
// would drop it, and the rows it was protecting become orphans quietly.
//
// This arm found one. `incident_update_notifications.subscriber_id` had the
// cascade in migration 0040 and no `.references()` in the schema at all, while
// the comment directly above the table said "cascade-delete from either side so
// purged subscribers / deleted incidents don't leave orphan rows" and described
// a forward declaration that was not in the code. Behaviour was correct — the
// database had the constraint — but only the hand-written migration was holding
// the invariant the schema claimed to express.
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

interface DbColumn {
  dataType: string;
  udt: string;
  nullable: boolean;
}

/** Every column the migrated database has, keyed `table.column`. */
async function databaseColumns(sql: ReturnType<typeof postgres>): Promise<Map<string, DbColumn>> {
  const rows = await sql<
    {
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }[]
  >`
    SELECT table_name, column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'`;
  const out = new Map<string, DbColumn>();
  for (const row of rows) {
    if (MIGRATOR_TABLES.has(row.table_name)) continue;
    out.set(`${row.table_name}.${row.column_name}`, {
      dataType: row.data_type,
      udt: row.udt_name,
      nullable: row.is_nullable === 'YES',
    });
  }
  return out;
}

/** Drizzle's SQL type, reduced to what `information_schema` can be compared to. */
function normaliseDeclared(sqlType: string): string {
  const base = sqlType.replace(/\(.*\)/, '').trim();
  // `text[]` is `_text` in Postgres' own naming.
  return base.endsWith('[]') ? `_${base.slice(0, -2)}` : base;
}

/** The database's type for a column, in the same vocabulary. */
function normaliseActual(col: DbColumn): string {
  return col.dataType === 'USER-DEFINED' || col.dataType === 'ARRAY' ? col.udt : col.dataType;
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

  it('CRITICAL every foreign key exists on both sides with the same ON DELETE action. The action is the part that matters: a cascade the schema does not declare survives only in the hand-written migration, so a schema-generated migration drops it and the rows it protected become orphans without an error anywhere.', async () => {
    if (guardUnreachable()) return;

    // Postgres stores the action as a single character.
    const ACTION: Record<string, string> = {
      a: 'no action',
      r: 'restrict',
      c: 'cascade',
      n: 'set null',
      d: 'set default',
    };

    const rows = await client!<{ tbl: string; cols: string; ftbl: string; del: string }[]>`
      SELECT c.conrelid::regclass::text AS tbl,
             (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
                FROM unnest(c.conkey) k
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols,
             c.confrelid::regclass::text AS ftbl,
             c.confdeltype AS del
      FROM pg_constraint c
      WHERE c.contype = 'f'`;
    const actual = new Map<string, string>();
    for (const row of rows)
      actual.set(`${row.tbl}.${row.cols}->${row.ftbl}`, ACTION[row.del] ?? row.del);

    const declared = new Map<string, string>();
    for (const value of Object.values(schema)) {
      try {
        const cfg = getTableConfig(value as never);
        if (typeof cfg.name !== 'string' || cfg.name === '') continue;
        for (const fk of cfg.foreignKeys) {
          const ref = fk.reference();
          const cols = ref.columns
            .map((c) => c.name)
            .sort()
            .join(',');
          const target = getTableConfig(ref.foreignTable as never).name;
          declared.set(`${cfg.name}.${cols}->${target}`, fk.onDelete ?? 'no action');
        }
      } catch {
        // Not a table export.
      }
    }

    // MEASURED: 66 foreign keys on both sides. Floored because two empty maps
    // agree perfectly and would report every relationship verified.
    expect(declared.size, 'foreign keys declared in the schema').toBeGreaterThanOrEqual(60);
    expect(actual.size, 'foreign keys in the migrated database').toBeGreaterThanOrEqual(60);

    const problems: string[] = [];
    for (const [key, action] of declared) {
      const dbAction = actual.get(key);
      if (dbAction === undefined)
        problems.push(`${key} is declared but has no database constraint`);
      else if (dbAction !== action) {
        problems.push(`${key}: declared ON DELETE ${action}, database has ${dbAction}`);
      }
    }
    for (const key of actual.keys()) {
      if (!declared.has(key)) problems.push(`${key} exists in the database but not in the schema`);
    }
    expect(problems.sort(), 'foreign key(s) that differ between schema and database:').toEqual([]);
  });

  it('CRITICAL the type normaliser distinguishes types rather than collapsing them. Run on pairs whose answer is not in doubt, because a normaliser that returned the same token for everything would report all 539 columns in agreement and read exactly as a clean schema.', () => {
    expect(normaliseDeclared('numeric(38, 18)'), 'precision is dropped, the type is not').toBe(
      'numeric',
    );
    expect(normaliseDeclared('text[]'), 'an array declares as Postgres names it').toBe('_text');
    expect(
      normaliseActual({
        dataType: 'timestamp with time zone',
        udt: 'timestamptz',
        nullable: false,
      }),
      'a scalar is compared on data_type, not the internal alias',
    ).toBe('timestamp with time zone');
    expect(
      normaliseActual({ dataType: 'USER-DEFINED', udt: 'account_tier', nullable: false }),
      'an enum is compared on udt_name, where its real name lives',
    ).toBe('account_tier');
    // And two genuinely different types must not normalise together.
    expect(normaliseDeclared('integer')).not.toBe(normaliseDeclared('bigint'));
  });

  it('CRITICAL every column has the type the database gave it. A declaration that disagrees is accepted by the compiler and rejected by Postgres — the write fails at the boundary, with a message about the column rather than about the schema that described it wrongly.', async () => {
    if (guardUnreachable()) return;
    const declared = drizzleTables();
    const actual = await databaseColumns(client!);

    const wrong: string[] = [];
    let compared = 0;
    for (const value of Object.values(schema)) {
      try {
        const cfg = getTableConfig(value as never);
        if (typeof cfg.name !== 'string' || cfg.name === '') continue;
        for (const col of cfg.columns) {
          const inDb = actual.get(`${cfg.name}.${col.name}`);
          if (inDb === undefined) continue; // reported by the name comparison above
          compared += 1;
          const a = normaliseDeclared(col.getSQLType());
          const b = normaliseActual(inDb);
          if (a !== b) {
            wrong.push(`${cfg.name}.${col.name}: declared ${col.getSQLType()}, database has ${b}`);
          }
        }
      } catch {
        // Not a table export.
      }
    }
    // MEASURED: 539 columns compared. Floored so a comparison that stopped
    // finding columns cannot report agreement over an empty set.
    expect(compared, 'columns whose type was compared').toBeGreaterThanOrEqual(500);
    expect(declared.size, 'tables the comparison walked').toBeGreaterThanOrEqual(45);
    expect(wrong.sort(), 'column(s) whose declared type is not the database type:').toEqual([]);
  });

  it('CRITICAL every column agrees on nullability. This is the one that makes the generated types lie: drizzle derives its TypeScript from notNull, so a column the database allows to be null arrives as a string the compiler swore could not be absent.', async () => {
    if (guardUnreachable()) return;
    const actual = await databaseColumns(client!);

    const wrong: string[] = [];
    let compared = 0;
    for (const value of Object.values(schema)) {
      try {
        const cfg = getTableConfig(value as never);
        if (typeof cfg.name !== 'string' || cfg.name === '') continue;
        for (const col of cfg.columns) {
          const inDb = actual.get(`${cfg.name}.${col.name}`);
          if (inDb === undefined) continue;
          compared += 1;
          if (col.notNull === inDb.nullable) {
            wrong.push(
              `${cfg.name}.${col.name}: declared ${col.notNull ? 'NOT NULL' : 'nullable'}, database is ${inDb.nullable ? 'nullable' : 'NOT NULL'}`,
            );
          }
        }
      } catch {
        // Not a table export.
      }
    }
    expect(compared, 'columns whose nullability was compared').toBeGreaterThanOrEqual(500);
    expect(wrong.sort(), 'column(s) whose declared nullability is not the database rule:').toEqual(
      [],
    );
  });
});

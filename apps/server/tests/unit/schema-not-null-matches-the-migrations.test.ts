// A column schema.ts marks `.notNull()` must actually be NOT NULL in the DB.
//
// The fourth and last correspondence, after columns, enum values and unique
// indexes. Its failure mode is a null reaching code whose types say it cannot:
// the row inserts fine, the query returns fine, and something downstream reads
// a field TypeScript promised was present. Nothing in the suite catches it,
// because the test database is built from schema.ts — where the column IS
// non-null — rather than from the migrations.
//
// ORDER MATTERS HERE and it is the reason this guard is written the way it is.
// The obvious implementation — "does any migration mention NOT NULL for this
// column" — is WRONG, and wrong in the dangerous direction. Migrations 0025,
// 0027 and 0059 each `ALTER COLUMN ... DROP NOT NULL`, and 0065 drops columns
// outright. A mention-based check would report those as constrained and pass
// while the database accepts nulls: a false GREEN, which is worse than no
// guard. So the migrations are replayed in order and the last write wins.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
const MIGRATIONS = resolve(REPO_ROOT, 'apps/server/src/db/migrations');

const NOT_A_COLUMN = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE']);

/** Columns schema.ts declares non-null. `.primaryKey()` implies it. */
function declaredNotNull(schemaTs: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of schemaTs.matchAll(/pgTable\(\s*'([a-z0-9_]+)'\s*,\s*\{/g)) {
    const open = schemaTs.indexOf('{', (m.index ?? 0) + m[0].length - 1);
    let depth = 0;
    let close = open;
    for (let i = open; i < schemaTs.length; i += 1) {
      if (schemaTs[i] === '{') depth += 1;
      else if (schemaTs[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    const body = schemaTs.slice(open, close);
    // Bound each declaration at ITS OWN terminating comma, tracked at depth
    // zero across (), {} and <>. Two narrower rules were both wrong: stopping
    // at end-of-line missed 98 chained declarations (drizzle writes
    // `timestamp('x', {...})\n  .notNull()`), and running to the next
    // declaration OVER-ran into properties whose form the boundary regex does
    // not match — `customType<{...}>({...})` — importing their `.notNull()`
    // and reporting four nullable columns as constrained.
    const cols = new Set<string>();
    for (const c of body.matchAll(/(\w+)\s*:\s*\w+\(\s*'([a-z0-9_]+)'/g)) {
      let depth = 0;
      let end = body.length;
      for (let i = (c.index ?? 0) + c[0].length; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === '(' || ch === '{' || ch === '[' || ch === '<') depth += 1;
        else if (ch === ')' || ch === '}' || ch === ']' || ch === '>') depth -= 1;
        else if (ch === ',' && depth <= 0) {
          end = i;
          break;
        }
      }
      const seg = body.slice(c.index ?? 0, end);
      if (seg.includes('.notNull()') || seg.includes('.primaryKey()')) cols.add(c[2] ?? '');
    }
    out.set(m[1] ?? '', cols);
  }
  return out;
}

/**
 * Replay the migrations in order; the final nullability per column.
 *
 * `undefined` = the column does not exist at the end (dropped, or never
 * created). `false` = it exists and accepts nulls.
 */
function finalNotNull(
  files: string[],
  tables: Iterable<string>,
): Map<string, Map<string, boolean>> {
  const state = new Map<string, Map<string, boolean>>();
  for (const t of tables) state.set(t, new Map());

  for (const sql of files) {
    for (const m of sql.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?(?:"?[a-z0-9_]+"?\.)?"?([a-z0-9_]+)"?\s*\(([\s\S]*?)\n\);/gi,
    )) {
      const cols = state.get(m[1] ?? '');
      if (!cols) continue;
      // FIRST mention wins within one CREATE TABLE body. A table's CHECK
      // constraints reference their own columns — `CHECK ("status" IN (...))`
      // — and those lines match the column-definition shape while carrying no
      // NOT NULL, so a last-wins loop overwrote the real definition and
      // reported three constrained columns as nullable.
      const definedHere = new Set<string>();
      for (const line of (m[2] ?? '').split('\n')) {
        const c = /^\s*"?([a-z0-9_]+)"?\s+["a-zA-Z]/.exec(line);
        if (c?.[1] === undefined || NOT_A_COLUMN.has(c[1].toUpperCase())) continue;
        if (definedHere.has(c[1])) continue;
        definedHere.add(c[1]);
        cols.set(c[1], /NOT NULL|PRIMARY KEY/i.test(line));
      }
    }
    for (const stmt of sql.split(';')) {
      const t = /ALTER TABLE\s+(?:IF EXISTS\s+)?"?([a-z0-9_]+)"?/i.exec(stmt);
      const cols = t?.[1] !== undefined ? state.get(t[1]) : undefined;
      if (!cols) continue;
      for (const c of stmt.matchAll(
        /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?([a-z0-9_]+)"?([^,]*)/gi,
      )) {
        cols.set(c[1] ?? '', /NOT NULL/i.test(c[2] ?? ''));
      }
      for (const c of stmt.matchAll(/ALTER COLUMN\s+"?([a-z0-9_]+)"?\s+SET NOT NULL/gi)) {
        cols.set(c[1] ?? '', true);
      }
      // The arm that makes this guard sound. Without it, a column whose
      // constraint was deliberately dropped still reads as constrained.
      for (const c of stmt.matchAll(/ALTER COLUMN\s+"?([a-z0-9_]+)"?\s+DROP NOT NULL/gi)) {
        cols.set(c[1] ?? '', false);
      }
      for (const c of stmt.matchAll(/DROP COLUMN\s+(?:IF EXISTS\s+)?"?([a-z0-9_]+)"?/gi)) {
        cols.delete(c[1] ?? '');
      }
    }
  }
  return state;
}

function gaps(schemaTs: string, files: string[]): string[] {
  const declared = declaredNotNull(schemaTs);
  const final = finalNotNull(files, declared.keys());
  const out: string[] = [];
  for (const [table, cols] of declared) {
    const actual = final.get(table) ?? new Map<string, boolean>();
    for (const c of cols) if (actual.get(c) !== true) out.push(`${table}.${c}`);
  }
  return out.sort();
}

const schemaTs = existsSync(SCHEMA) ? readFileSync(SCHEMA, 'utf8') : '';
const migrationFiles = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
  : [];

describe('every column schema.ts marks notNull is NOT NULL in the database', () => {
  it('CRITICAL the replay honours DROP NOT NULL, which is the difference between this guard and a false green. A mention-based check would pass on a column whose constraint was deliberately removed.', () => {
    const declared = declaredNotNull(schemaTs);
    expect(declared.size, 'tables parsed').toBeGreaterThan(40);
    expect(
      [...declared.values()].reduce((n, c) => n + c.size, 0),
      'columns declared notNull',
    ).toBeGreaterThan(200);
    expect(migrationFiles.length, 'migration files replayed').toBeGreaterThan(100);

    // Dropped constraint: schema still says notNull, the database does not.
    expect(
      gaps(`pgTable('t', { c: text('c') .notNull() })`, [
        'CREATE TABLE "t" (\n  "c" text NOT NULL\n);',
        'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;',
      ]),
      'a dropped NOT NULL is a gap, not a pass',
    ).toEqual(['t.c']);

    // Restored later: order decides, last write wins.
    expect(
      gaps(`pgTable('t', { c: text('c') .notNull() })`, [
        'CREATE TABLE "t" (\n  "c" text\n);',
        'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;',
        'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;',
      ]),
      'the last write wins',
    ).toEqual([]);

    // A neighbouring property whose form the boundary regex does not match —
    // customType with generics — must not have its .notNull() imported. This
    // reported platform_secrets.description, which has no .notNull() at all.
    expect(
      gaps(
        `pgTable('t', {\n  d: text('d'),\n  c: customType<{ data: Buffer }>({ dataType: () => 'bytea' })('c').notNull(),\n})`,
        ['CREATE TABLE "t" (\n  "d" text,\n  "c" bytea NOT NULL\n);'],
      ),
      "a neighbour's .notNull() does not leak into the previous property",
    ).toEqual([]);

    // A CHECK constraint references its own column, and that line looks like a
    // definition while carrying no NOT NULL. Last-wins reported three
    // constrained columns as nullable.
    expect(
      gaps(`pgTable('t', { s: text('status') .notNull() })`, [
        'CREATE TABLE "t" (\n  "status" text NOT NULL,\n  CONSTRAINT "t_status" CHECK (\n    "status" IN (\'a\', \'b\')\n  )\n);',
      ]),
      'a CHECK line referencing the column does not un-constrain it',
    ).toEqual([]);

    // Added already-constrained.
    expect(
      gaps(`pgTable('t', { c: text('c') .notNull() })`, [
        'CREATE TABLE "t" (\n  "id" uuid\n);',
        'ALTER TABLE "t" ADD COLUMN "c" text NOT NULL;',
      ]),
      'ADD COLUMN ... NOT NULL satisfies it',
    ).toEqual([]);
  });

  it('CRITICAL no column schema.ts calls notNull is nullable in the database. The row would insert fine and the query return fine, and something downstream would read a null through a type that promised it could not be — on a path every test passes, because the test database is built from schema.ts rather than the migrations.', () => {
    expect(
      gaps(schemaTs, migrationFiles),
      'column(s) declared notNull that the migrations leave nullable:',
    ).toEqual([]);
  });
});

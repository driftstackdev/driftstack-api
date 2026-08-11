// Every column `schema.ts` declares must be created by some migration.
//
// These migrations are HAND-AUTHORED idempotent SQL — `drizzle-kit generate` is
// not used here and is documented as unsafe against this repo's stale snapshot
// meta. So nothing derives the migrations from the schema, and nothing checked
// the two agree. A column added to schema.ts without a matching migration
// type-checks, passes every unit test that mocks the repo, and then 500s in
// production the first time the query runs against a database that has no such
// column.
//
// The existing cross-source invariants each cover ONE feature's table
// (agent-sessions, session-operations, egress capabilities…). This is the
// population-wide version: 52 tables, 535 columns.
//
// It is a NAME-level correspondence, not a type check. Types, nullability and
// defaults are deliberately out of scope — matching those against hand-written
// DDL invites false positives that get the guard deleted. Presence is the
// property whose absence is unambiguously a production fault.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
const MIGRATIONS = resolve(REPO_ROOT, 'apps/server/src/db/migrations');

/** Words that begin a table CONSTRAINT clause rather than a column. */
const NOT_A_COLUMN = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'FOREIGN',
  'CHECK',
  'EXCLUDE',
  'LIKE',
]);

/** `pgTable('name', { col: type('sql_name') … })` → sql table → sql columns. */
function declaredTables(schemaTs: string): Map<string, Set<string>> {
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
    const cols = new Set(
      [...body.matchAll(/\w+\s*:\s*\w+\(\s*'([a-z0-9_]+)'/g)].map((c) => c[1] ?? ''),
    );
    out.set(m[1] ?? '', cols);
  }
  return out;
}

/** Columns any migration creates, per table. */
function migratedColumns(sql: string, known: Iterable<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of known) out.set(t, new Set());

  for (const m of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?"?([a-z0-9_]+)"?\s*\(([\s\S]*?)\n\);/gi,
  )) {
    const bucket = out.get(m[1] ?? '');
    if (!bucket) continue;
    for (const line of (m[2] ?? '').split('\n')) {
      // The type may be QUOTED — enum columns read `"status" "account_status"`.
      // Requiring a bare word after the name missed every enum column and
      // reported 13 tables as broken. That was the parser, not the schema.
      const c = /^\s*"?([a-z0-9_]+)"?\s+["a-zA-Z]/.exec(line);
      if (c?.[1] !== undefined && !NOT_A_COLUMN.has(c[1].toUpperCase())) bucket.add(c[1]);
    }
  }

  // Per STATEMENT, and every ADD COLUMN within it. These migrations write
  // `ALTER TABLE x ADD COLUMN a …, ADD COLUMN b …, ADD COLUMN c …;` and taking
  // only the first match per statement reported 10 live columns as missing.
  for (const stmt of sql.split(';')) {
    const t = /ALTER TABLE\s+(?:IF EXISTS\s+)?"?([a-z0-9_]+)"?/i.exec(stmt);
    const bucket = t?.[1] !== undefined ? out.get(t[1]) : undefined;
    if (!bucket) continue;
    for (const c of stmt.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?([a-z0-9_]+)"?/gi)) {
      if (c[1] !== undefined) bucket.add(c[1]);
    }
  }
  return out;
}

function gaps(schemaTs: string, sql: string): string[] {
  const declared = declaredTables(schemaTs);
  const migrated = migratedColumns(sql, declared.keys());
  const out: string[] = [];
  for (const [table, cols] of declared) {
    const have = migrated.get(table) ?? new Set<string>();
    for (const c of cols) if (!have.has(c)) out.push(`${table}.${c}`);
  }
  return out.sort();
}

const schemaTs = existsSync(SCHEMA) ? readFileSync(SCHEMA, 'utf8') : '';
const migrationSql = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
      .join('\n')
  : '';

describe('every schema column is created by a migration', () => {
  it('CRITICAL both sides parsed to a real population, and the parser handles the two DDL forms that previously fooled it. The assertion below reports an ABSENCE, so a schema that parsed to zero columns would satisfy it having compared nothing.', () => {
    const declared = declaredTables(schemaTs);
    expect(declared.size, 'tables declared in schema.ts').toBeGreaterThan(40);
    expect(
      [...declared.values()].reduce((n, c) => n + c.size, 0),
      'columns declared in schema.ts',
    ).toBeGreaterThan(400);
    expect(migrationSql.length, 'migration SQL read').toBeGreaterThan(10_000);

    // Quoted enum type. Requiring a bare word after the column name reported
    // every `status`/`tier`/`type` column as missing.
    expect(
      gaps(
        `pgTable('t', { s: text('status') })`,
        'CREATE TABLE "t" (\n  "status" "account_status" NOT NULL\n);',
      ),
      'a column whose TYPE is quoted is still a column',
    ).toEqual([]);

    // Multi-column ALTER. Taking one ADD COLUMN per statement reported 10 live
    // columns as missing.
    expect(
      gaps(
        `pgTable('t', { a: text('col_a'), b: text('col_b'), c: text('col_c') })`,
        'CREATE TABLE "t" (\n  "id" uuid\n);\nALTER TABLE "t"\n  ADD COLUMN "col_a" text,\n  ADD COLUMN IF NOT EXISTS "col_b" text,\n  ADD COLUMN "col_c" text;',
      ),
      'every ADD COLUMN in a statement counts, not just the first',
    ).toEqual([]);

    // And a genuinely absent column must still be reported, or the two arms
    // above are satisfied by a function that never reports anything.
    expect(
      gaps(
        `pgTable('t', { a: text('col_a'), z: text('never_migrated') })`,
        'CREATE TABLE "t" (\n  "col_a" text\n);',
      ),
      'a column no migration creates is reported',
    ).toEqual(['t.never_migrated']);
  });

  it('CRITICAL no schema column is missing from every migration. These migrations are hand-authored, so nothing derives them from the schema: a column declared here without matching DDL type-checks, passes every mocked-repo test, and 500s in production on the first real query.', () => {
    expect(
      gaps(schemaTs, migrationSql),
      'schema column(s) that no migration creates — write the migration by hand (idempotent, IF NOT EXISTS) per the 0076 convention:',
    ).toEqual([]);
  });
});

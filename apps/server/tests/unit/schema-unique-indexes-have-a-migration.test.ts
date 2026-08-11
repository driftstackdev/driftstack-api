// Every uniqueIndex() schema.ts declares must be enforced by a migration.
//
// The third dimension after columns and enum values, and the one whose absence
// is silent in a different way: a missing column errors, a missing enum value
// errors on one path, but a missing UNIQUE constraint never errors at all — it
// lets duplicate rows accumulate until something downstream reads two where it
// expected one. There is no request that fails to tell you.
//
// Migrations here are hand-authored, so nothing derives these from the schema.
//
// Names only, and matched loosely on purpose: Postgres enforces uniqueness
// whether the constraint is named, unnamed, an index, or a table constraint.
// What this asserts is that SOMETHING in the migrations enforces each declared
// uniqueness — with the one legitimate mismatch declared below rather than
// silently tolerated by a fuzzy matcher.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
const MIGRATIONS = resolve(REPO_ROOT, 'apps/server/src/db/migrations');

/**
 * Declared uniqueness the migrations enforce under a DIFFERENT name, and how.
 *
 * Exact: an entry that stops describing a real mismatch fails, because an
 * exemption that exempts nothing reads as reviewed.
 */
const ENFORCED_UNNAMED: Record<string, string> = {
  incident_update_notifications_unique_idx:
    'Migration 0040 enforces it as an INLINE UNNAMED constraint inside CREATE TABLE — ' +
    '`UNIQUE ("subscriber_id", "incident_id")` — so Postgres auto-names it and the ' +
    'schema name never appears in the SQL. Verified harmless: the only upsert on this ' +
    'table targets COLUMNS, not a constraint name (incident-update-notifications-repo.ts), ' +
    'and no repo in the tree targets a unique index by name.',
};

function declaredUniqueIndexes(schemaTs: string): string[] {
  return [
    ...new Set([...schemaTs.matchAll(/uniqueIndex\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1] ?? '')),
  ].sort();
}

/** Uniqueness the migrations create, by name. */
function enforcedNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(
    /CREATE UNIQUE INDEX\s+(?:CONCURRENTLY\s+)?(?:IF NOT EXISTS\s+)?"?([a-z0-9_]+)"?/gi,
  )) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  // Both the ALTER form and the INLINE form inside CREATE TABLE. Matching only
  // `ADD CONSTRAINT` missed fleet_nodes_public_key_unique, which migration 0043
  // writes as `CONSTRAINT "..." UNIQUE (...)` in the table body.
  for (const m of sql.matchAll(/(?:ADD\s+)?CONSTRAINT\s+"?([a-z0-9_]+)"?\s+UNIQUE/gi)) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return out;
}

function unenforced(schemaTs: string, sql: string): string[] {
  const enforced = enforcedNames(sql);
  return declaredUniqueIndexes(schemaTs).filter(
    (n) => !enforced.has(n) && ENFORCED_UNNAMED[n] === undefined,
  );
}

const schemaTs = existsSync(SCHEMA) ? readFileSync(SCHEMA, 'utf8') : '';
const migrationSql = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
      .join('\n')
  : '';

describe('every declared unique index is enforced by a migration', () => {
  it('CRITICAL both sides parsed and the inline CONSTRAINT form is recognised. The assertion below reports an ABSENCE, so a schema parsing to zero unique indexes would satisfy it having compared nothing.', () => {
    expect(declaredUniqueIndexes(schemaTs).length, 'uniqueIndex() in schema.ts').toBeGreaterThan(
      20,
    );
    expect(enforcedNames(migrationSql).size, 'named uniqueness in the migrations').toBeGreaterThan(
      20,
    );

    // Inline table constraint. Matching only `ADD CONSTRAINT` missed a real one.
    expect(
      unenforced(
        `uniqueIndex('t_key_unique')`,
        'CREATE TABLE "t" (\n  "k" text,\n  CONSTRAINT "t_key_unique" UNIQUE ("k")\n);',
      ),
      'an inline CONSTRAINT ... UNIQUE enforces it',
    ).toEqual([]);

    // And one nothing enforces must still be reported, or the arm above is
    // satisfied by a function that never reports anything.
    expect(
      unenforced(`uniqueIndex('t_missing_unique')`, 'CREATE TABLE "t" ("k" text);'),
      'unenforced uniqueness is reported',
    ).toEqual(['t_missing_unique']);
  });

  it('CRITICAL every declared uniqueness is enforced. A missing UNIQUE is the quietest of these failures: nothing errors, duplicate rows simply accumulate until something downstream reads two where it expected one.', () => {
    expect(
      unenforced(schemaTs, migrationSql),
      'declared unique index(es) no migration enforces — duplicates would be accepted in production:',
    ).toEqual([]);
  });

  it('CRITICAL every declared name-mismatch exemption still describes a real one. An entry whose index is now enforced under its own name exempts nothing and reads as reviewed.', () => {
    const enforced = enforcedNames(migrationSql);
    const declared = new Set(declaredUniqueIndexes(schemaTs));
    const stale = Object.keys(ENFORCED_UNNAMED).filter((n) => !declared.has(n) || enforced.has(n));
    expect(stale, 'exemption(s) that no longer describe a name mismatch:').toEqual([]);
  });
});

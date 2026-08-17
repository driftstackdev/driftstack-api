// Every value a `pgEnum` declares must exist in the database enum type.
//
// The column guard's sibling, and the sharper of the two. A column the DB lacks
// fails every query touching that table; an enum VALUE the DB lacks fails only
// the request that happens to write it — a tier nobody has selected yet, an
// audit action only one admin path emits, a webhook event type that fires
// quarterly. It ships green and breaks later, on a code path that worked in
// every test because the test database was built from the same schema.ts rather
// than from the migrations.
//
// Migrations here are hand-authored, so nothing derives the DDL from the enum
// declarations. The two agree only because someone kept them agreeing.
//
// Direction is deliberate: schema value -> database value. The reverse is not
// asserted HERE, because a value living in the DB type that schema.ts no longer
// declares is a retired option, and Postgres cannot drop an enum value in place.
//
// ⚠️ CORRECTION 2026-08-17. This paragraph used to cite "account_tier still
// carries 'starter' and 'pro' from 0000" as the example. It does not.
// Migration 0006 DROPs the type and recreates it as
// ('trial_pack', 'solo_manual', … 'enterprise') — dropping and recreating is
// exactly how this codebase retires enum values, and it removed both. After
// 0065 renames 'trial_pack' to 'free', the type holds precisely the eight
// values schema.ts declares, with nothing retired.
//
// The stale example was a symptom, not a typo: the reader below matches only
// CREATE TYPE and ADD VALUE, so it UNIONS every value the migrations ever
// created and never sees a drop-and-recreate. That is why 'starter' looked
// present, and it is why the reverse direction genuinely cannot be asserted
// from this reader — it would treat a value retired at 0006 as still live. The
// arms below are unaffected: a union is a superset, so "schema value exists in
// the DB type" stays sound. It does mean a retired value RE-added to schema.ts
// passes here (measured: adding 'starter' back reds only the sibling guard).
//
// The reverse direction IS covered, by
// schema-enums-match-their-migration-history, which replays CREATE / ADD VALUE /
// RENAME VALUE / DROP TYPE and asserts exact equality both ways. That guard and
// this one overlap on the schema -> database half; this one reads the DDL
// directly and states the customer-facing consequence, and that one replays the
// full history and catches a schema.ts that has fallen BEHIND its migrations.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
const MIGRATIONS = resolve(REPO_ROOT, 'apps/server/src/db/migrations');

/**
 * A type name, optionally schema-qualified and quoted.
 *
 * `CREATE TYPE "public"."account_status" AS ENUM(…)` is the form drizzle's
 * initial migration emits. A matcher without the qualifier reported TEN of the
 * sixteen types as never created — the schema looked catastrophically broken
 * when nothing was wrong.
 */
const TYPE_NAME = String.raw`(?:"?[a-z0-9_]+"?\.)?"?([a-z0-9_]+)"?`;

function declaredEnums(schemaTs: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of schemaTs.matchAll(/pgEnum\(\s*'([a-z0-9_]+)'\s*,\s*\[([^\]]*)\]/g)) {
    out.set(m[1] ?? '', new Set([...(m[2] ?? '').matchAll(/'([^']+)'/g)].map((v) => v[1] ?? '')));
  }
  return out;
}

function migratedEnums(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (name: string, value: string): void => {
    const bucket = out.get(name) ?? new Set<string>();
    bucket.add(value);
    out.set(name, bucket);
  };
  for (const m of sql.matchAll(
    new RegExp(
      String.raw`CREATE TYPE\s+(?:IF NOT EXISTS\s+)?${TYPE_NAME}\s+AS ENUM\s*\(([^)]*)\)`,
      'gi',
    ),
  )) {
    for (const v of (m[2] ?? '').matchAll(/'([^']+)'/g)) add(m[1] ?? '', v[1] ?? '');
  }
  // Values added after the type existed. Every enum that grew — account_tier
  // went from four values to eight — arrives this way, so missing this arm
  // would report the growth as drift.
  for (const m of sql.matchAll(
    new RegExp(
      String.raw`ALTER TYPE\s+${TYPE_NAME}\s+ADD VALUE\s+(?:IF NOT EXISTS\s+)?'([^']+)'`,
      'gi',
    ),
  )) {
    add(m[1] ?? '', m[2] ?? '');
  }
  return out;
}

/** `enum.value` for every declared value the migrations never define. */
function gaps(schemaTs: string, sql: string): string[] {
  const migrated = migratedEnums(sql);
  const out: string[] = [];
  for (const [name, values] of declaredEnums(schemaTs)) {
    const have = migrated.get(name) ?? new Set<string>();
    for (const v of values) if (!have.has(v)) out.push(`${name}.${v}`);
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

describe('every declared enum value exists in the database type', () => {
  it('CRITICAL both sides parsed, and the parser handles the two DDL forms that previously fooled it. The assertion below reports an ABSENCE, so a schema parsing to zero enums would satisfy it having compared nothing.', () => {
    expect(declaredEnums(schemaTs).size, 'pgEnum types in schema.ts').toBeGreaterThan(10);
    expect(migratedEnums(migrationSql).size, 'enum types built by migrations').toBeGreaterThan(10);

    // Schema-qualified CREATE TYPE. Without the qualifier this reported 10 of
    // 16 types as never created.
    expect(
      gaps(
        `pgEnum('account_status', ['active', 'suspended'])`,
        `CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended');`,
      ),
      'a schema-qualified CREATE TYPE still defines the type',
    ).toEqual([]);

    // Values added later. account_tier grew from four to eight this way.
    expect(
      gaps(
        `pgEnum('t', ['a', 'b'])`,
        `CREATE TYPE "t" AS ENUM('a');\nALTER TYPE "t" ADD VALUE IF NOT EXISTS 'b';`,
      ),
      'ALTER TYPE ADD VALUE counts',
    ).toEqual([]);

    // And a value nothing defines must still be reported, or the arms above are
    // satisfied by a function that never reports anything.
    expect(
      gaps(`pgEnum('t', ['a', 'ghost'])`, `CREATE TYPE "t" AS ENUM('a');`),
      'an undefined value is reported',
    ).toEqual(['t.ghost']);
  });

  it('CRITICAL no declared enum value is missing from the database type. Unlike a missing column, this breaks only the request that writes that value — a tier nobody has picked yet, an audit action one admin path emits — so it ships green and fails later in production.', () => {
    expect(
      gaps(schemaTs, migrationSql),
      'enum value(s) no migration defines — add `ALTER TYPE ... ADD VALUE IF NOT EXISTS` by hand, per the 0076 convention:',
    ).toEqual([]);
  });
});

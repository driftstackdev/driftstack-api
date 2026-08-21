// `schema.ts` must describe the database the migrations actually build.
//
// The drizzle schema is what the ORM believes. The migrations are what exists.
// Nothing compared them, and the gap is not symmetric:
//
//   migrations have a value schema.ts lacks → harmless; the ORM never writes it.
//   schema.ts has a value NO migration created → the type checks, the query
//       builder accepts it, and Postgres rejects the INSERT. The schema file
//       describes a database that was never built.
//
// This closes a hole in `no-ts-vocabulary-outgrows-its-database-enum`, which
// checks TS vocabularies against the pgEnums in schema.ts. That check passes
// happily when schema.ts ITSELF is ahead of the migrations — the TS enum is a
// subset of a pgEnum that is a superset of the real type. The two guards
// together give the chain that matters: TS ⊆ schema.ts ⊆ the built database.
//
// The reconstruction replays four statement kinds in file order, and all four
// are load-bearing. A first version applied only CREATE and ADD VALUE and
// reported `account_tier` as declaring a value no migration created: migration
// 0065 RENAMEs 'trial_pack' to 'free' in place, and skipping renames turns a
// correct schema into a false finding. DROP TYPE matters too — account_tier is
// dropped and recreated twice, and a reconstruction that unions everything ever
// written would carry retired values forever.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const ENUM_STATEMENT = new RegExp(
  [
    String.raw`(CREATE TYPE\s+"?(?:public"?\."?)?([a-z0-9_]+)"?\s+AS ENUM\s*\(([^)]*)\))`,
    String.raw`(ALTER TYPE\s+"?(?:public"?\."?)?([a-z0-9_]+)"?\s+ADD VALUE\s+(?:IF NOT EXISTS\s+)?'([^']+)')`,
    String.raw`(ALTER TYPE\s+"?(?:public"?\."?)?([a-z0-9_]+)"?\s+RENAME VALUE\s+'([^']+)'\s+TO\s+'([^']+)')`,
    String.raw`(DROP TYPE\s+"?(?:public"?\."?)?([a-z0-9_]+)"?)`,
  ].join('|'),
  'gi',
);

const literals = (text: string): string[] => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

interface Replay {
  enums: Map<string, Set<string>>;
  applied: { create: number; add: number; rename: number; drop: number };
}

/** Replay every enum statement in migration order. */
function replayMigrations(): Replay {
  const files = execFileSync('git', ['ls-files', 'apps/server/src/db/migrations'], {
    cwd: REPO,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const enums = new Map<string, Set<string>>();
  const applied = { create: 0, add: 0, rename: 0, drop: 0 };
  for (const file of files) {
    const sql = readFileSync(resolve(REPO, file), 'utf-8');
    for (const m of sql.matchAll(ENUM_STATEMENT)) {
      if (m[1]) {
        applied.create++;
        enums.set(m[2]!, new Set(literals(m[3]!)));
      } else if (m[4]) {
        applied.add++;
        const values = enums.get(m[5]!) ?? new Set<string>();
        values.add(m[6]!);
        enums.set(m[5]!, values);
      } else if (m[7]) {
        applied.rename++;
        const values = enums.get(m[8]!) ?? new Set<string>();
        values.delete(m[9]!);
        values.add(m[10]!);
        enums.set(m[8]!, values);
      } else if (m[11]) {
        applied.drop++;
        enums.delete(m[12]!);
      }
    }
  }
  return { enums, applied };
}

function schemaEnums(): Map<string, Set<string>> {
  // V-1258 — via the SHARED scanner. This stripped LINE comments first, which happens to
  // dodge the `/*`-inside-a-line-comment trap that V-1256 found, but it strips `//`
  // ANYWHERE — including inside a string literal, so a URL in a scanned file would be
  // truncated mid-token. `schema.ts` has none today; that is luck, not design, and the
  // luck is one commit deep. `code-only.ts` tracks quotes and regex literals.
  const source = codeOnly(readFileSync(resolve(REPO, 'apps/server/src/db/schema.ts'), 'utf-8'));
  const enums = new Map<string, Set<string>>();
  for (const m of source.matchAll(/pgEnum\('([a-z0-9_]+)',\s*/g)) {
    const from = source.indexOf('[', m.index + m[0].length - 1);
    let depth = 0;
    for (let i = from; i < source.length; i++) {
      if (source[i] === '[') depth++;
      else if (source[i] === ']' && --depth === 0) {
        enums.set(m[1]!, new Set(literals(source.slice(from, i + 1))));
        break;
      }
    }
  }
  return enums;
}

describe('schema enums match their migration history', () => {
  const { enums: built, applied } = replayMigrations();
  const declared = schemaEnums();

  it('CRITICAL the replay applied every statement kind, so a match is a real one', () => {
    expect(
      applied.create,
      'no CREATE TYPE replayed — the migration scan is broken',
    ).toBeGreaterThanOrEqual(15);
    expect(applied.add, 'no ADD VALUE replayed').toBeGreaterThanOrEqual(40);
    expect(
      applied.rename,
      'no RENAME VALUE replayed. Migration 0065 renames trial_pack to free; skipping renames ' +
        'reports account_tier as declaring a value no migration created',
    ).toBeGreaterThanOrEqual(1);
    expect(
      applied.drop,
      'no DROP TYPE replayed — retired values would persist',
    ).toBeGreaterThanOrEqual(1);
    expect(declared.size, 'no pgEnums parsed from schema.ts').toBeGreaterThanOrEqual(15);
    // The rename in particular must have taken effect.
    expect(built.get('account_tier'), 'account_tier missing from the replay').toBeDefined();
    expect(
      built.get('account_tier')!.has('free'),
      'the trial_pack → free rename was not applied',
    ).toBe(true);
    expect(
      built.get('account_tier')!.has('trial_pack'),
      'the retired value survived the rename',
    ).toBe(false);
  });

  it('CRITICAL every pgEnum has migration history behind it', () => {
    const unbuilt = [...declared.keys()].filter((name) => !built.has(name)).sort();
    expect(
      unbuilt,
      'this pgEnum exists in schema.ts and no migration ever created the type — the ORM would ' +
        'reference a type the database does not have',
    ).toEqual([]);
  });

  it('CRITICAL schema.ts declares exactly the values the migrations build', () => {
    const disagreements: string[] = [];
    for (const [name, values] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
      const actual = built.get(name);
      if (!actual) continue; // reported by the arm above
      for (const value of [...values].sort())
        if (!actual.has(value))
          disagreements.push(`${name}: schema.ts declares '${value}', no migration creates it`);
      for (const value of [...actual].sort())
        if (!values.has(value))
          disagreements.push(`${name}: migrations create '${value}', schema.ts omits it`);
    }
    expect(
      disagreements.sort(),
      'schema.ts and the migration history describe different databases. A schema-only value ' +
        'compiles and then fails at the INSERT; a migration-only value is dead vocabulary',
    ).toEqual([]);
  });
});

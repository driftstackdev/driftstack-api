// Migration 0130 only adds, fails fast on a busy table, pins every guard it
// installs, and is mirrored name for name in schema.ts.
//
// It runs while the old process is still serving, and it touches `accounts` (a
// foreign key takes a lock on it) and `credit_lots`. None of what keeps that
// safe shows in a green run against an idle database:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds,
//     whole, which is safe to retry;
//   · nothing existing is dropped, retyped or rewritten;
//   · every trigger function pins `search_path = public, pg_temp`, so a
//     session's temporary table named like a credit table cannot stand in for
//     the real one inside a guard (pg_temp is otherwise searched FIRST);
//   · the no-overlap rule is an exclusion constraint, which Drizzle cannot
//     declare. So it lives in the SQL alone, and schema.ts has to SAY so beside
//     the table — including the one fact a writer must know: insert with
//     ON CONFLICT DO NOTHING and no conflict target, or an overlap aborts the
//     transaction instead of being skipped.
//
// What these rules DO is proved against Postgres, in the integration tests the
// schema comment names; the last arm holds that comment to files that exist.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0130_credit_windows';
const RAW = readFileSync(resolve(DB, 'migrations', `${TAG}.sql`), 'utf8');

/** The migration with `--` comments removed. */
const SQL = RAW.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

/** Top-level statements: split on `;` outside `$$ … $$` function bodies. */
function statements(): string[] {
  const out: string[] = [];
  let current = '';
  let inBody = false;
  for (const part of SQL.split(/(\$\$)/)) {
    if (part === '$$') {
      inBody = !inBody;
      current += part;
    } else if (inBody) {
      current += part;
    } else {
      const pieces = part.split(';');
      pieces.forEach((piece, i) => {
        current += piece;
        if (i < pieces.length - 1) {
          out.push(current.trim());
          current = '';
        }
      });
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out.filter((s) => s !== '');
}

describe('migration 0130 only adds, and every guard it installs is pinned down', () => {
  it('CRITICAL the FIRST statement is the lock timeout, and it is SET LOCAL: scoped to the migrator’s transaction, never the session', () => {
    const all = statements();
    expect(all[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(all.filter((s) => /lock_timeout/.test(s))).toHaveLength(1);
  });

  it('CRITICAL it only ADDS: an extension, three tables, their indexes, three guard functions with their triggers, and one foreign key and one index on `credit_lots`. Nothing that existed is dropped, retyped or rewritten', () => {
    const kinds = statements().map((s) => {
      if (/^SET LOCAL /.test(s)) return 'set';
      if (/^CREATE EXTENSION IF NOT EXISTS btree_gist$/.test(s)) return 'extension';
      const table = /^CREATE TABLE "(\w+)" /.exec(s)?.[1];
      if (table !== undefined) return `table ${table}`;
      const index = /^CREATE (?:UNIQUE )?INDEX "(\w+)"\s+ON "(\w+)"/.exec(s);
      if (index !== null) return `index on ${index[2] ?? '?'}`;
      const fn = /^CREATE FUNCTION "(\w+)"\(\) RETURNS trigger/.exec(s)?.[1];
      if (fn !== undefined) return `function ${fn}`;
      const trigger = /^CREATE TRIGGER "\w+" BEFORE [A-Z ]+\s+ON "(\w+)"/.exec(s)?.[1];
      if (trigger !== undefined) return `trigger on ${trigger}`;
      if (
        /^ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_window_fk"\s+FOREIGN KEY/.test(s)
      ) {
        return 'foreign key on credit_lots';
      }
      return `UNEXPECTED: ${s.slice(0, 60)}`;
    });
    expect(kinds).toEqual([
      'set',
      'extension',
      'table credit_windows',
      'index on credit_windows',
      'index on credit_windows',
      'index on credit_windows',
      'function credit_windows_guard',
      'trigger on credit_windows',
      'table credit_window_level_changes',
      'function credit_window_level_changes_guard',
      'trigger on credit_window_level_changes',
      'table credit_clawbacks',
      'index on credit_clawbacks',
      'index on credit_clawbacks',
      'function credit_clawbacks_guard',
      'trigger on credit_clawbacks',
      'foreign key on credit_lots',
      'index on credit_lots',
    ]);
    expect(SQL).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bRENAME\b/i,
    );
  });

  it('CRITICAL every trigger function pins its search_path to public, then pg_temp', () => {
    const functions = statements().filter((s) => /^CREATE FUNCTION /.test(s));
    expect(functions).toHaveLength(3);
    for (const fn of functions) {
      expect(fn, fn.slice(0, 50)).toMatch(
        /RETURNS trigger LANGUAGE plpgsql\s+SET search_path = public, pg_temp AS \$\$/,
      );
    }
  });

  it('the window guard fires on INSERT as well as UPDATE and DELETE — that is what makes `created_at` the database’s clock — and the no-overlap rule is a gist exclusion over the account and the half-open range', () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER "credit_windows_guard_trigger" BEFORE INSERT OR UPDATE OR DELETE ON "credit_windows"/,
    );
    expect(SQL).toMatch(/NEW\."created_at" := now\(\);\s*NEW\."level_seq" := 0;/);
    expect(SQL.replace(/\s+/g, ' ')).toContain(
      `CONSTRAINT "credit_windows_no_overlap" EXCLUDE USING gist ( "account_id" WITH =, tstzrange("window_start", "window_end", '[)') WITH &&)`,
    );
  });

  it('the journal applies it last, after 0129, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(130);
    expect(journal.entries[at]?.idx).toBe(130);
    expect(journal.entries[at - 1]?.tag).toBe('0129_billing_periods_and_paid_invoices');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('CRITICAL schema.ts mirrors every CHECK and every index the migration creates, by name, and names none it does not create', () => {
    const inSql = {
      checks: [...SQL.matchAll(/CONSTRAINT "(\w+)"\s+CHECK/g)].map((m) => m[1] ?? '').sort(),
      indexes: [...SQL.matchAll(/CREATE (?:UNIQUE )?INDEX "(\w+)"/g)].map((m) => m[1] ?? '').sort(),
    };
    // 6 on windows, 5 on level changes, 8 on clawbacks.
    expect(inSql.checks).toHaveLength(19);
    expect(inSql.indexes).toHaveLength(6);

    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const mine =
      /^(credit_windows_|credit_window_level_changes_|credit_clawbacks_|credit_lots_one_monthly_per_window$)/;
    const named = (kinds: string[]): string[] =>
      [...schema.matchAll(new RegExp(`\\b(?:${kinds.join('|')})\\(\\s*'(\\w+)'`, 'g'))]
        .map((m) => m[1] ?? '')
        .filter((n) => mine.test(n))
        .sort();
    expect(named(['check'])).toEqual(inSql.checks);
    // `unique` as well as `uniqueIndex`: migration 0131 promoted
    // `credit_windows_id_account_unique` from a unique INDEX to the unique
    // CONSTRAINT backed by that same index (which is the form a foreign key is
    // documented to be allowed to target), so schema.ts now declares it as a
    // table-level `unique(...)`. The migration that CREATES it is still 0130 and
    // still creates an index, so the two sides are compared across the two
    // spellings rather than one being re-pinned away.
    expect(named(['index', 'uniqueIndex', 'unique'])).toEqual(inSql.indexes);
    // The lot→window key carries the ACCOUNT, so it is a table-level foreign
    // key over two columns, not a `.references()` on `window_id` alone: a lot
    // names a window of its own account or no window at all.
    expect(schema.replace(/\s+/g, ' ')).toContain(
      "foreignKey({ name: 'credit_lots_window_fk', columns: [t.windowId, t.accountId], " +
        "foreignColumns: [creditWindows.id, creditWindows.accountId], }).onDelete('cascade')",
    );
    expect(SQL.replace(/\s+/g, ' ')).toContain(
      'FOREIGN KEY ("window_id", "account_id") REFERENCES "credit_windows"("id", "account_id")',
    );
  });

  it('CRITICAL what Drizzle cannot declare is written down beside the table: the exclusion constraint, the rule that a writer uses ON CONFLICT DO NOTHING with NO conflict target, and the three triggers — and every test that comment names exists', () => {
    const schema = readFileSync(resolve(DB, 'schema.ts'), 'utf8');
    const at = schema.indexOf('credit_windows / credit_window_level_changes / credit_clawbacks');
    expect(at).toBeGreaterThan(0);
    const note = schema.slice(at, schema.indexOf('export const creditWindows = pgTable(', at));
    for (const said of [
      'credit_windows_no_overlap',
      'EXCLUDE USING gist',
      'NO conflict target',
      '23P01',
      'credit_windows_guard_trigger',
      'credit_window_level_changes_guard_trigger',
      'credit_clawbacks_guard_trigger',
      'search_path = public, pg_temp',
    ]) {
      expect(note, said).toContain(said);
    }
    const namedTests = [...note.matchAll(/`([a-z0-9-]{20,})`/g)].map((m) => m[1] ?? '');
    expect(namedTests.length, 'integration tests the comment names').toBeGreaterThanOrEqual(4);
    for (const name of namedTests) {
      expect(
        existsSync(resolve(HERE, '..', 'integration', `${name}.test.ts`)),
        `schema.ts names ${name}, and no such integration test exists`,
      ).toBe(true);
    }
  });
});

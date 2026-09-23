// Migration 0137 adds ONE nullable column to `credit_lots`, one CHECK on it,
// and makes it one of the lot's immutable terms — and nothing else — fails fast
// on a busy table, and is mirrored in schema.ts.
//
// The column is what lets a reversal measure what a lot keeps against the
// share of its payment still paid WHEN IT WAS GRANTED (S17 re-audit #5): a
// month granted after a half refund must keep half its grant at a
// three-quarter refund, not a quarter. Properties that keep the migration safe
// to run while the old process serves, and that no green run against an idle
// database would show:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds
//     (safe to retry) instead of queueing every writer behind the lock;
//   · the column is nullable with no default: Postgres changes the catalog and
//     rewrites no row, and existing rows keep NULL ("the whole payment");
//   · the lot guard it replaces is 0128's, byte for byte, but for the one
//     column added to the tuple of terms that never change: a relaxed or
//     reworded guard would pass every arm that only inserts.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0137_credit_lot_still_paid';
const MIGRATION = resolve(DB, 'migrations', `${TAG}.sql`);
const LEDGER_MIGRATION = resolve(DB, 'migrations', '0128_credit_ledger.sql');

/** SQL with `--` comments removed (the prose mentions DROP, UPDATE and the guard). */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** Statements split on `;`, except inside a `$$ … $$` function body. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inBody = false;
  for (let i = 0; i < sql.length; i += 1) {
    if (sql.startsWith('$$', i)) {
      inBody = !inBody;
      current += '$$';
      i += 1;
      continue;
    }
    const ch = sql[i] ?? '';
    if (ch === ';' && !inBody) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
}

/** The `credit_lots_guard` definition in one migration, whitespace-normalised. */
function guardIn(path: string): string {
  const found = statements(code(path)).find((s) => /FUNCTION "credit_lots_guard"\(\)/.test(s));
  if (found === undefined) throw new Error(`credit_lots_guard not found in ${path}`);
  return found;
}

describe('migration 0137 adds one column and makes it a term of the lot', () => {
  it('CRITICAL it is exactly four statements: the lock timeout FIRST, the column, its CHECK, the guard', () => {
    const all = statements(code(MIGRATION));
    expect(all).toHaveLength(4);
    expect(all[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(all[1]).toBe(
      'ALTER TABLE "credit_lots" ADD COLUMN IF NOT EXISTS "still_paid_minor" bigint',
    );
    expect(all[2]).toBe(
      'ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_still_paid_nonnegative" ' +
        'CHECK ("still_paid_minor" IS NULL OR "still_paid_minor" >= 0)',
    );
    expect(all[3]).toMatch(/^CREATE OR REPLACE FUNCTION "credit_lots_guard"\(\)/);
  });

  it('CRITICAL the column is nullable with no default: a catalog change, not a table rewrite', () => {
    const added = statements(code(MIGRATION)).filter((s) => /ADD COLUMN/.test(s));
    expect(added).toHaveLength(1);
    for (const s of added) expect(s).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it('CRITICAL the guard is 0128’s own, changed ONLY by the new column joining the immutable terms', () => {
    const before = guardIn(LEDGER_MIGRATION).replace(
      /^CREATE FUNCTION/,
      'CREATE OR REPLACE FUNCTION',
    );
    const after = guardIn(MIGRATION);
    const widened = before
      .replace(
        'NEW."expires_at", NEW."created_at")',
        'NEW."expires_at", NEW."created_at", NEW."still_paid_minor")',
      )
      .replace(
        'OLD."expires_at", OLD."created_at")',
        'OLD."expires_at", OLD."created_at", OLD."still_paid_minor")',
      );
    expect(widened, 'the expected edit did not apply to 0128’s guard').not.toBe(before);
    expect(after).toBe(widened);
    // The search path stays pinned, as every credit guard's is.
    expect(after).toContain('SET search_path = public, pg_temp');
  });

  it('the journal applies it after 0136, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(137);
    expect(journal.entries[at]?.idx).toBe(137);
    expect(journal.entries[at - 1]?.tag).toBe('0136_credit_window_level_change_source');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('schema.ts mirrors it: the lot table declares `still_paid_minor` as a nullable bigint and names the CHECK', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const table = /pgTable\(\s*'credit_lots',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(table, 'the lot table was not found in schema.ts').not.toBe('');
    expect(table).toMatch(/stillPaidMinor: bigint\('still_paid_minor', \{ mode: 'number' \}\),/);
    expect(table).not.toMatch(/stillPaidMinor: bigint\('still_paid_minor'[^\n]*\.notNull\(\)/);
    expect(table).toContain("'credit_lots_still_paid_nonnegative'");
  });
});

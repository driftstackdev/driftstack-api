// Migration 0139 gives a credit window the level its coverage earns with the
// standing disputes left out, records that level's move with every level
// change beside what the change's payment still paid, widens ONLY what counts
// as a level change (the pair of the level shown and the undisputed level),
// and records on a dispute's own clawback rows the amount it disputed (a
// payment's disputed amount is the SUM of its standing disputes, which can pass
// what the payment row may hold). Properties that keep the migration safe to run
// while the old process serves, and that no green run against an idle database
// would show:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds
//     (safe to retry) instead of queueing every writer behind the lock;
//   · every new column is nullable with no default: Postgres changes the
//     catalog and rewrites no row, and existing rows keep NULL ("the same as
//     the level shown", "the whole payment");
//   · the window guard it replaces is 0130's, byte for byte, but for the one
//     expression that says what a level change is, and the clawbacks guard is
//     0132's but for the one column added to the facts that never change — a
//     relaxed or reworded guard would pass every arm that only inserts;
//   · the one CHECK it replaces keeps its NAME (the refusal tests match it) and
//     still refuses a change that moves nothing.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0139_credit_window_undisputed_level';
const MIGRATION = resolve(DB, 'migrations', `${TAG}.sql`);
const WINDOWS_MIGRATION = resolve(DB, 'migrations', '0130_credit_windows.sql');
const GUARD_GAPS_MIGRATION = resolve(DB, 'migrations', '0132_credit_guard_gaps.sql');

/** SQL with `--` comments removed (the prose mentions DROP and the guard). */
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

/** One guard's definition in one migration, whitespace-normalised. */
function guardIn(path: string, name = 'credit_windows_guard'): string {
  const found = statements(code(path)).find((s) => s.includes(`FUNCTION "${name}"()`));
  if (found === undefined) throw new Error(`${name} not found in ${path}`);
  return found;
}

describe('migration 0139 adds the undisputed level and a dispute’s amount, and widens only what a level change is and what a clawback may never change', () => {
  it('CRITICAL it is exactly these statements, the lock timeout FIRST and the guard last', () => {
    const all = statements(code(MIGRATION));
    expect(all).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "credit_windows" ADD COLUMN IF NOT EXISTS "undisputed_level_micro" bigint',
      'ALTER TABLE "credit_windows" ADD CONSTRAINT "credit_windows_undisputed_level" ' +
        'CHECK ("undisputed_level_micro" IS NULL ' +
        'OR ("undisputed_level_micro" >= 0 AND "undisputed_level_micro" % 1000000 = 0))',
      'ALTER TABLE "credit_window_level_changes" ADD COLUMN IF NOT EXISTS "undisputed_from_micro" bigint',
      'ALTER TABLE "credit_window_level_changes" ADD COLUMN IF NOT EXISTS "undisputed_to_micro" bigint',
      'ALTER TABLE "credit_window_level_changes" ADD COLUMN IF NOT EXISTS "still_paid_minor" bigint',
      'ALTER TABLE "credit_window_level_changes" ADD CONSTRAINT "credit_window_level_changes_undisputed" ' +
        'CHECK (("undisputed_from_micro" IS NULL AND "undisputed_to_micro" IS NULL) ' +
        'OR ("undisputed_from_micro" >= 0 AND "undisputed_from_micro" % 1000000 = 0 ' +
        'AND "undisputed_to_micro" >= 0 AND "undisputed_to_micro" % 1000000 = 0))',
      'ALTER TABLE "credit_window_level_changes" ADD CONSTRAINT "credit_window_level_changes_still_paid" ' +
        'CHECK ("still_paid_minor" IS NULL OR "still_paid_minor" >= 0)',
      'ALTER TABLE "credit_window_level_changes" DROP CONSTRAINT "credit_window_level_changes_real"',
      'ALTER TABLE "credit_window_level_changes" ADD CONSTRAINT "credit_window_level_changes_real" ' +
        'CHECK ("from_level_micro" <> "to_level_micro" ' +
        'OR "undisputed_from_micro" IS DISTINCT FROM "undisputed_to_micro")',
      expect.stringMatching(/^CREATE OR REPLACE FUNCTION "credit_windows_guard"\(\)/),
      'ALTER TABLE "credit_clawbacks" ADD COLUMN IF NOT EXISTS "disputed_minor" bigint',
      'ALTER TABLE "credit_clawbacks" ADD CONSTRAINT "credit_clawbacks_disputed" ' +
        'CHECK ("disputed_minor" IS NULL OR "disputed_minor" >= 0)',
      expect.stringMatching(/^CREATE OR REPLACE FUNCTION "credit_clawbacks_guard"\(\)/),
    ]);
  });

  it('CRITICAL every column is nullable with no default: a catalog change, not a table rewrite', () => {
    const added = statements(code(MIGRATION)).filter((s) => /ADD COLUMN/.test(s));
    expect(added).toHaveLength(5);
    for (const s of added) expect(s).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it('CRITICAL the guard is 0130’s own, changed ONLY in what counts as a level change', () => {
    const before = guardIn(WINDOWS_MIGRATION).replace(
      /^CREATE FUNCTION/,
      'CREATE OR REPLACE FUNCTION',
    );
    const after = guardIn(MIGRATION);
    const widened = before.replace(
      '(CASE WHEN NEW."level_micro" <> OLD."level_micro" THEN 1 ELSE 0 END)',
      '(CASE WHEN (NEW."level_micro", COALESCE(NEW."undisputed_level_micro", NEW."level_micro")) ' +
        'IS DISTINCT FROM ' +
        '(OLD."level_micro", COALESCE(OLD."undisputed_level_micro", OLD."level_micro")) ' +
        'THEN 1 ELSE 0 END)',
    );
    expect(widened, 'the expected edit did not apply to 0130’s guard').not.toBe(before);
    expect(after).toBe(widened);
    // The search path stays pinned, as every credit guard's is.
    expect(after).toContain('SET search_path = public, pg_temp');
    // Every other term of a window is still immutable.
    expect(after).toContain(
      'IF (NEW."id", NEW."account_id", NEW."source", NEW."source_ref", NEW."natural_start", ' +
        'NEW."natural_end", NEW."window_start", NEW."window_end", NEW."tier", NEW."created_at")',
    );
  });

  it('CRITICAL the clawbacks guard is 0132’s own, changed ONLY by the disputed amount joining the facts that never change', () => {
    const before = guardIn(GUARD_GAPS_MIGRATION, 'credit_clawbacks_guard');
    const after = guardIn(MIGRATION, 'credit_clawbacks_guard');
    const widened = before
      .replace(
        'NEW."amount_micro", NEW."clawed_micro", NEW."created_at")',
        'NEW."amount_micro", NEW."clawed_micro", NEW."created_at", NEW."disputed_minor")',
      )
      .replace(
        'OLD."amount_micro", OLD."clawed_micro", OLD."created_at")',
        'OLD."amount_micro", OLD."clawed_micro", OLD."created_at", OLD."disputed_minor")',
      );
    expect(widened, 'the expected edit did not apply to 0132’s guard').not.toBe(before);
    expect(after).toBe(widened);
    expect(after).toContain('SET search_path = public, pg_temp');
  });

  it('never spells an enum statement, even in its prose', () => {
    const raw = readFileSync(MIGRATION, 'utf8');
    expect(raw).not.toMatch(/\bENUM\b/);
    expect(raw).not.toMatch(/ALTER TYPE/i);
  });

  it('the journal applies it last, after 0138, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(139);
    expect(journal.entries[at]?.idx).toBe(139);
    expect(journal.entries[at - 1]?.tag).toBe('0138_web_session_actor_columns');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('schema.ts mirrors it: the new columns as nullable bigints, and every CHECK by name', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const windows = /pgTable\(\s*'credit_windows',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(windows, 'the window table was not found in schema.ts').not.toBe('');
    expect(windows).toMatch(
      /undisputedLevelMicro: bigint\('undisputed_level_micro', \{ mode: 'number' \}\),/,
    );
    expect(windows).toContain("'credit_windows_undisputed_level'");
    const changes =
      /pgTable\(\s*'credit_window_level_changes',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(changes, 'the level-change table was not found in schema.ts').not.toBe('');
    for (const column of [
      /undisputedFromMicro: bigint\('undisputed_from_micro', \{ mode: 'number' \}\),/,
      /undisputedToMicro: bigint\('undisputed_to_micro', \{ mode: 'number' \}\),/,
      /stillPaidMinor: bigint\('still_paid_minor', \{ mode: 'number' \}\),/,
    ]) {
      expect(changes).toMatch(column);
    }
    expect(changes).not.toMatch(/undisputed_from_micro'[^\n]*\.notNull\(\)/);
    for (const name of [
      "'credit_window_level_changes_real'",
      "'credit_window_level_changes_undisputed'",
      "'credit_window_level_changes_still_paid'",
    ]) {
      expect(changes).toContain(name);
    }
    const clawbacks = /pgTable\(\s*'credit_clawbacks',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(clawbacks, 'the clawbacks table was not found in schema.ts').not.toBe('');
    expect(clawbacks).toMatch(/disputedMinor: bigint\('disputed_minor', \{ mode: 'number' \}\),/);
    expect(clawbacks).toContain("'credit_clawbacks_disputed'");
  });
});

// Migration 0136 adds ONE nullable column to `credit_window_level_changes` and
// nothing else, fails fast on a busy table, and is mirrored in schema.ts.
//
// The column is what lets a refund of a mid-month upgrade take back only what
// that upgrade bought (S17 audit #5): a plan-change step records the coverage
// that supplied its new level, so the proration lot it grants belongs to that
// invoice. Three properties keep the migration safe to run while the old
// process serves, and none of them is visible in a green run against an idle
// database:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds
//     (safe to retry) instead of queueing every writer behind the lock;
//   · the column is nullable with no default, so Postgres changes the catalog
//     and rewrites no row — existing rows keep NULL, which every reader treats
//     as attributable to no invoice;
//   · nothing else changes: the table stays append-only under the guard 0130
//     installed, and no row is written or updated here.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0136_credit_window_level_change_source';
const MIGRATION = resolve(DB, 'migrations', `${TAG}.sql`);

/** The migration with `--` comments removed: the prose mentions DROP and UPDATE. */
function statements(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return sql
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

describe('migration 0136 adds one nullable column and nothing else', () => {
  it('CRITICAL it is exactly two statements: the lock timeout FIRST, then the one column', () => {
    expect(statements()).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "credit_window_level_changes" ADD COLUMN IF NOT EXISTS "source_ref" text',
    ]);
  });

  it('CRITICAL the column is nullable with no default: a catalog change, not a table rewrite', () => {
    const added = statements().filter((s) => /ADD COLUMN/.test(s));
    expect(added).toHaveLength(1);
    for (const s of added) expect(s).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it('the journal applies it after 0135, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(136);
    expect(journal.entries[at]?.idx).toBe(136);
    expect(journal.entries[at - 1]?.tag).toBe('0135_ai_credits_admin_audit_log_cutover_actions');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('schema.ts mirrors it: the level-change table declares `source_ref` as a nullable text column', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const table = /pgTable\(\s*'credit_window_level_changes',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(table, 'the level-change table was not found in schema.ts').not.toBe('');
    expect(table).toMatch(/sourceRef: text\('source_ref'\),/);
    expect(table).not.toMatch(/sourceRef: text\('source_ref'\)\.notNull\(\)/);
  });
});

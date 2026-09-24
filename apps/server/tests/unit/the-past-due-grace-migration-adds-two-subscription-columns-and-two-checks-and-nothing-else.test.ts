// Migration 0141 lets a subscription remember when it fell into past_due, so a
// failed renewal keeps the paid plan for seven days (live-billing audit #3, ToS
// 8.5): `subscriptions.past_due_since` and the past-due sweep's done-mark
// `subscriptions.past_due_grace_ended_at`, each held by a CHECK. Properties that
// keep it safe to run while the old process serves, and that no green run
// against an idle database would show:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds
//     (safe to retry) instead of queueing every Stripe webhook behind the lock;
//   · both columns are nullable with no default: a catalog change, not a table
//     rewrite, and every existing row — including one already past_due, whose
//     start is unknown — reads "no grace recorded" (NULL);
//   · it touches no row and no other table, and spells no type statement.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0141_subscription_past_due_grace';
const MIGRATION = resolve(DB, 'migrations', `${TAG}.sql`);

/** SQL with `--` comments removed. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

describe('migration 0141 adds two subscription columns and two checks, and nothing else', () => {
  it('CRITICAL it is exactly these statements, the lock timeout FIRST', () => {
    expect(statements(code(MIGRATION))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "past_due_since" timestamp with time zone',
      'ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "past_due_grace_ended_at" timestamp with time zone',
      'ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_past_due_since" ' +
        'CHECK ("past_due_since" IS NULL OR "status" = \'past_due\')',
      'ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_past_due_grace_ended" ' +
        'CHECK ("past_due_grace_ended_at" IS NULL OR "past_due_since" IS NOT NULL)',
    ]);
  });

  it('CRITICAL both columns are nullable with no default: a catalog change, not a table rewrite', () => {
    const added = statements(code(MIGRATION)).filter((s) => /ADD COLUMN/.test(s));
    expect(added).toHaveLength(2);
    for (const s of added) expect(s).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it('never spells a type statement, even in its prose', () => {
    const raw = readFileSync(MIGRATION, 'utf8');
    expect(raw).not.toMatch(/\bENUM\b/i);
    expect(raw).not.toMatch(/ALTER TYPE|CREATE TYPE/i);
  });

  it('the journal applies it last, after 0140, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(141);
    expect(journal.entries[at]?.idx).toBe(141);
    expect(journal.entries[at - 1]?.tag).toBe(
      '0140_credit_clawback_frozen_cap_and_reversal_indexes',
    );
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('schema.ts mirrors it: the two columns as nullable timestamps and both CHECKs by name', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const table = /pgTable\(\s*'subscriptions',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(table, 'the subscriptions table was not found in schema.ts').not.toBe('');
    expect(table).toMatch(/pastDueSince: timestamp\('past_due_since', \{ withTimezone: true \}\),/);
    expect(table).toMatch(
      /pastDueGraceEndedAt: timestamp\('past_due_grace_ended_at', \{ withTimezone: true \}\),/,
    );
    expect(table).toContain("'subscriptions_past_due_since'");
    expect(table).toContain("'subscriptions_past_due_grace_ended'");
  });
});

// Migration 0129 rewrites nothing, fails fast on a busy table, and is mirrored
// name for name in schema.ts.
//
// It ALTERs `subscriptions`, a table the live process writes to, and migrations
// run while the old process is still serving. Three properties keep that safe,
// and none of them is visible in a green test run against an idle database:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds
//     (safe to retry) instead of queueing every writer behind an ACCESS
//     EXCLUSIVE lock;
//   · every added column is nullable with no default, so Postgres changes the
//     catalog and rewrites no row;
//   · nothing existing is dropped, retyped or tightened.
//
// The last arm holds the Drizzle mirror to the SQL by NAME: a CHECK or index
// that exists only on one side is a constraint the code believes in and the
// database does not have, or the reverse.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0129_billing_periods_and_paid_invoices';
const MIGRATION = resolve(DB, 'migrations', `${TAG}.sql`);

/** The migration with `--` comments removed: prose mentions DROP and DEFAULT. */
function statements(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('migration 0129 rewrites nothing and fails fast on a busy table', () => {
  it('CRITICAL the FIRST statement is the lock timeout — after it, a table that is busy fails the whole batch in five seconds rather than blocking every writer behind it', () => {
    const all = statements();
    expect(all.length).toBeGreaterThan(8);
    expect(all[0]).toBe("SET LOCAL lock_timeout = '5s'");
    // SET LOCAL, not SET: scoped to the migrator's transaction, never the session.
    expect(all.filter((s) => /lock_timeout/.test(s))).toHaveLength(1);
  });

  it('CRITICAL every column added to `subscriptions` is nullable with no default: a catalog change, not a table rewrite', () => {
    const added = statements().filter((s) => /^ALTER TABLE "subscriptions" ADD COLUMN/.test(s));
    expect(added.map((s) => s.replace(/\s+/g, ' '))).toEqual([
      'ALTER TABLE "subscriptions" ADD COLUMN "current_period_start" timestamptz',
      'ALTER TABLE "subscriptions" ADD COLUMN "billing_interval" text',
      'ALTER TABLE "subscriptions" ADD COLUMN "period_start_source" text',
      'ALTER TABLE "subscriptions" ADD COLUMN "tier_since" timestamptz',
    ]);
    for (const s of added) expect(s).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it('it only ADDS: no statement drops, retypes, renames or tightens anything that existed', () => {
    const kinds = statements().map((s) => {
      if (/^SET LOCAL /.test(s)) return 'set';
      if (/^ALTER TABLE "subscriptions" ADD COLUMN /.test(s)) return 'add column';
      if (/^ALTER TABLE "subscriptions" ADD CONSTRAINT "\w+"\s+CHECK /.test(s)) return 'add check';
      if (/^CREATE TABLE "billing_invoice_payments" /.test(s)) return 'create table';
      if (/^CREATE INDEX "billing_invoice_payments_\w+"\s+ON "billing_invoice_payments" /.test(s)) {
        return 'create index';
      }
      return `UNEXPECTED: ${s.slice(0, 60)}`;
    });
    expect(kinds).toEqual([
      'set',
      'add column',
      'add column',
      'add column',
      'add column',
      'add check',
      'add check',
      'add check',
      'create table',
      'create index',
      'create index',
      'create index',
    ]);
  });

  it('the journal applies it last, after 0128, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(129);
    expect(journal.entries[at]?.idx).toBe(129);
    expect(journal.entries[at - 1]?.tag).toBe('0128_credit_ledger');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('CRITICAL schema.ts mirrors every CHECK and every index the migration creates, by name, and names none the migration does not create', () => {
    const sql = statements().join(';\n');
    const inSql = {
      checks: [...sql.matchAll(/CONSTRAINT "(\w+)"\s+CHECK/g)].map((m) => m[1] ?? '').sort(),
      indexes: [...sql.matchAll(/CREATE INDEX "(\w+)"/g)].map((m) => m[1] ?? '').sort(),
    };
    expect(inSql.checks).toHaveLength(9);
    expect(inSql.indexes).toHaveLength(3);

    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const named = (kind: 'check' | 'index'): string[] =>
      [...schema.matchAll(new RegExp(`\\b${kind}\\(\\s*'(\\w+)'`, 'g'))]
        .map((m) => m[1] ?? '')
        .filter((n) => /^(billing_invoice_payments_|subscriptions_(billing|period))/.test(n))
        .sort();
    expect(named('check')).toEqual(inSql.checks);
    expect(named('index')).toEqual(inSql.indexes);
  });
});

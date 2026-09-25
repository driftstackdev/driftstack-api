// Migration 0144 adds TWO columns to `crypto_orders` and nothing else, fails fast
// on a busy table, and is mirrored in schema.ts.
//
// The columns are the payment mint claim (security sweep #18, residual): when a
// checkout last claimed the right to create the order's NowPayments payment, and
// how many payments were created for it. Three properties keep the migration safe
// to run while the old process serves, and none of them is visible in a green run
// against an idle database:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds
//     (safe to retry) instead of queueing every checkout and IPN behind the lock;
//   · neither column rewrites a row: the claim time is nullable with no default,
//     and the count's default is a constant, which Postgres keeps in the catalog;
//   · nothing else changes: no row is written or updated here, and no constraint
//     or index is added.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0144_crypto_order_payment_mint_claim';
const MIGRATION = resolve(DB, 'migrations', `${TAG}.sql`);

/** The migration with `--` comments removed: the prose mentions what it does not do. */
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

describe('migration 0144 adds two crypto order columns and nothing else', () => {
  it('CRITICAL it is exactly three statements: the lock timeout FIRST, then the two columns', () => {
    expect(statements()).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "crypto_orders" ADD COLUMN IF NOT EXISTS "payment_mint_claimed_at" timestamp with time zone',
      'ALTER TABLE "crypto_orders" ADD COLUMN IF NOT EXISTS "payment_mints" integer DEFAULT 0 NOT NULL',
    ]);
  });

  it('CRITICAL neither column rewrites a row: the claim time has no default, the count a constant one', () => {
    const added = statements().filter((s) => /ADD COLUMN/.test(s));
    expect(added).toHaveLength(2);
    expect(added[0]).not.toMatch(/NOT NULL|DEFAULT/i);
    expect(added[1]).toMatch(/DEFAULT 0 NOT NULL$/);
    expect(added[1]).not.toMatch(/DEFAULT\s+\w+\(/i);
  });

  it('the journal applies it after 0143, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(144);
    expect(journal.entries[at]?.idx).toBe(144);
    expect(journal.entries[at - 1]?.tag).toBe('0143_agent_session_profile_save_back_refused');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('schema.ts mirrors it: crypto_orders declares a nullable claim time and a not-null count defaulting to 0', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const table = /pgTable\(\s*'crypto_orders',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(table, 'the crypto_orders table was not found in schema.ts').not.toBe('');
    expect(table).toMatch(
      /paymentMintClaimedAt: timestamp\('payment_mint_claimed_at', \{\s*withTimezone: true,\s*mode: 'date',\s*\}\),/,
    );
    expect(table).toMatch(/paymentMints: integer\('payment_mints'\)\.notNull\(\)\.default\(0\),/);
  });
});

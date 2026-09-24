// Migration 0140 records three facts on a reversal's clawback rows — the
// interim cap's consumption FROZEN at the reversal (S17 R8), the ledger mark it
// was measured at, and how much more of the unit's credit may be spent before
// an unpaid claim of it stops being owed (audit 4 #3) — and adds the five
// partial indexes the reversal reads use instead of walking every ledger row,
// clawback or task of the account (audit 4 #10, R13). Properties that keep it safe to run
// while the old process serves, and that no green run against an idle database
// would show:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds
//     (safe to retry) instead of queueing every writer behind the lock;
//   · every new column is nullable with no default: a catalog change, not a
//     table rewrite, and every existing row reads "not measured" (NULL);
//   · the clawbacks guard it replaces is 0139's, byte for byte, but for the
//     three columns joining the facts that never change — a relaxed or
//     reworded guard would pass every arm that only inserts;
//   · each index is PARTIAL on exactly the rows its read asks for, and keyed on
//     the expression that read compares, so the planner can use it.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keyPrefixRange } from '../../src/db/credit-windows-repo.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0140_credit_clawback_frozen_cap_and_reversal_indexes';
const MIGRATION = resolve(DB, 'migrations', `${TAG}.sql`);
const PREVIOUS = resolve(DB, 'migrations', '0139_credit_window_undisputed_level.sql');

/** SQL with `--` comments removed (the prose mentions the guard and the indexes). */
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

function guardIn(path: string): string {
  const found = statements(code(path)).find((s) =>
    s.includes('FUNCTION "credit_clawbacks_guard"()'),
  );
  if (found === undefined) throw new Error(`credit_clawbacks_guard not found in ${path}`);
  return found;
}

describe('migration 0140 adds three clawback facts and five partial indexes for the reversal reads, and nothing else', () => {
  it('CRITICAL it is exactly these statements, the lock timeout FIRST', () => {
    expect(statements(code(MIGRATION))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "credit_clawbacks" ADD COLUMN IF NOT EXISTS "cap_spent_micro" bigint',
      'ALTER TABLE "credit_clawbacks" ADD COLUMN IF NOT EXISTS "ledger_mark" bigint',
      'ALTER TABLE "credit_clawbacks" ADD COLUMN IF NOT EXISTS "claim_forgive_after_micro" bigint',
      'ALTER TABLE "credit_clawbacks" ADD CONSTRAINT "credit_clawbacks_cap_spent" ' +
        'CHECK ("cap_spent_micro" IS NULL OR "cap_spent_micro" >= 0)',
      'ALTER TABLE "credit_clawbacks" ADD CONSTRAINT "credit_clawbacks_ledger_mark" ' +
        'CHECK ("ledger_mark" IS NULL OR "ledger_mark" >= 0)',
      'ALTER TABLE "credit_clawbacks" ADD CONSTRAINT "credit_clawbacks_claim_forgive_after" ' +
        'CHECK ("claim_forgive_after_micro" IS NULL OR "claim_forgive_after_micro" >= 0)',
      expect.stringMatching(/^CREATE OR REPLACE FUNCTION "credit_clawbacks_guard"\(\)/),
      'CREATE INDEX IF NOT EXISTS "credit_ledger_claim_clawback_idx" ON "credit_ledger" ' +
        '("account_id", "idempotency_key" text_pattern_ops) ' +
        'WHERE starts_with("idempotency_key", \'claim:\')',
      'CREATE INDEX IF NOT EXISTS "credit_ledger_giveback_window_idx" ON "credit_ledger" ' +
        '("account_id", "idempotency_key" text_pattern_ops) ' +
        'WHERE "kind" = \'adjustment\' AND starts_with("idempotency_key", \'reinstate:\')',
      'CREATE INDEX IF NOT EXISTS "credit_ledger_debt_idx" ON "credit_ledger" ' +
        '("account_id", "id") WHERE "debt_delta_micro" <> 0',
      'CREATE INDEX IF NOT EXISTS "credit_clawbacks_hold_idx" ON "credit_clawbacks" ' +
        '("account_id", "source_ref" text_pattern_ops) WHERE starts_with("source_ref", \'hold:\')',
      'CREATE INDEX IF NOT EXISTS "credit_reservations_account_created_idx" ON "credit_reservations" ' +
        '("account_id", "created_at") WHERE "mode" = \'enforce\'',
    ]);
  });

  it('CRITICAL every column is nullable with no default: a catalog change, not a table rewrite', () => {
    const added = statements(code(MIGRATION)).filter((s) => /ADD COLUMN/.test(s));
    expect(added).toHaveLength(3);
    for (const s of added) expect(s).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it('CRITICAL the clawbacks guard is 0139’s own, changed ONLY by the three facts joining those that never change', () => {
    const before = guardIn(PREVIOUS);
    const after = guardIn(MIGRATION);
    const widened = before
      .replace(
        'NEW."created_at", NEW."disputed_minor")',
        'NEW."created_at", NEW."disputed_minor", ' +
          'NEW."cap_spent_micro", NEW."ledger_mark", NEW."claim_forgive_after_micro")',
      )
      .replace(
        'OLD."created_at", OLD."disputed_minor")',
        'OLD."created_at", OLD."disputed_minor", ' +
          'OLD."cap_spent_micro", OLD."ledger_mark", OLD."claim_forgive_after_micro")',
      );
    expect(widened, 'the expected edit did not apply to 0139’s guard').not.toBe(before);
    expect(after).toBe(widened);
    expect(after).toContain('SET search_path = public, pg_temp');
  });

  it('never spells an enum statement, even in its prose', () => {
    const raw = readFileSync(MIGRATION, 'utf8');
    expect(raw).not.toMatch(/\bENUM\b/);
    expect(raw).not.toMatch(/ALTER TYPE/i);
  });

  it('the journal applies it last, after 0139, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(140);
    expect(journal.entries[at]?.idx).toBe(140);
    expect(journal.entries[at - 1]?.tag).toBe('0139_credit_window_undisputed_level');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('schema.ts mirrors it: the three columns as nullable bigints, every CHECK and every index by name', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const clawbacks = /pgTable\(\s*'credit_clawbacks',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(clawbacks, 'the clawbacks table was not found in schema.ts').not.toBe('');
    for (const column of [
      /capSpentMicro: bigint\('cap_spent_micro', \{ mode: 'number' \}\),/,
      /ledgerMark: bigint\('ledger_mark', \{ mode: 'number' \}\),/,
      /claimForgiveAfterMicro: bigint\('claim_forgive_after_micro', \{ mode: 'number' \}\),/,
    ]) {
      expect(clawbacks).toMatch(column);
    }
    for (const name of [
      "'credit_clawbacks_cap_spent'",
      "'credit_clawbacks_ledger_mark'",
      "'credit_clawbacks_claim_forgive_after'",
    ]) {
      expect(clawbacks).toContain(name);
    }
    const ledger = /pgTable\(\s*'credit_ledger',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(ledger, 'the ledger table was not found in schema.ts').not.toBe('');
    for (const name of [
      "'credit_ledger_claim_clawback_idx'",
      "'credit_ledger_giveback_window_idx'",
      "'credit_ledger_debt_idx'",
    ]) {
      expect(ledger).toContain(name);
    }
    expect(clawbacks).toContain("'credit_clawbacks_hold_idx'");
    const reservations = /pgTable\(\s*'credit_reservations',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(reservations, 'the reservations table was not found in schema.ts').not.toBe('');
    expect(reservations).toContain("'credit_reservations_account_created_idx'");
  });

  it('the reads the indexes serve state the indexed rows literally and bound the key with the pattern operators', () => {
    const repo = readFileSync(resolve(DB, 'credit-windows-repo.ts'), 'utf8');
    const reservations = readFileSync(resolve(DB, 'credit-reservations-repo.ts'), 'utf8');
    // collectedClaims: the claim prefix as a literal (a parameter would not let
    // the planner prove the partial predicate), then each clawback's
    // `claim:<clawback>:` as a byte range the text_pattern_ops index serves.
    expect(repo).toMatch(
      /starts_with\(x\.idempotency_key, 'claim:'\)\s+AND x\.idempotency_key ~>=~ \('claim:' \|\| c\.id \|\| ':'\)\s+AND x\.idempotency_key ~<~ \('claim:' \|\| c\.id \|\| ';'\)/,
    );
    // claimLetGoMicro read ONE clawback's claims by the same range; reversal
    // policy v2 removed it. What a settlement lets go of a claim is now a
    // `drop:<clawback>:<task>` record read with the unit's own clawbacks, and a
    // win reads one clawback's collected claims through collectedClaims — the
    // bounded read above. So the reservations repo walks no claim rows at all,
    // and no read anywhere walks them by an unbounded key: every
    // `~>=~ ('claim:' || …)` bound in the windows repo has its `~<~` partner.
    expect(reservations).not.toMatch(/'claim:'/);
    expect(repo.match(/~>=~ \('claim:' \|\| /g)?.length ?? 0).toBe(1);
    expect(repo.match(/~<~ \('claim:' \|\| /g)?.length ?? 0).toBe(1);
    // unitGivebackRows: the adjustment rows under `reinstate:`, the unit's prefix as a range.
    expect(repo).toMatch(
      /x\.kind = 'adjustment' AND starts_with\(x\.idempotency_key, 'reinstate:'\)\s+AND x\.idempotency_key ~>=~ \$\{range\.from\} AND x\.idempotency_key ~<~ \$\{range\.below\}/,
    );
    // holdRedirectsOf read a task's `hold:` records by the task's prefix as a
    // range; reversal policy v2 removed the hold redirects, so no `hold:`
    // record is written or read any more. The index that served the read stays
    // (dropping it would not be additive), and schema.ts says it is unused —
    // an index no read uses is a stated decision, not a forgotten one.
    expect(repo).not.toMatch(/'hold:'/);
    expect(readFileSync(resolve(DB, 'schema.ts'), 'utf8')).toMatch(
      /UNUSED SINCE REVERSAL POLICY v2[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*index\('credit_clawbacks_hold_idx'\)/,
    );
    // debtEvents: the rows that move debt.
    expect(repo).toMatch(/x\.debt_delta_micro <> 0\s+ORDER BY x\.id/);
  });

  it('a key prefix is bounded as exactly the keys that start with it, in byte order', () => {
    const { from, below } = keyPrefixRange('claim:aaaaaaaa-0000-4000-8000-000000000001:');
    expect(from).toBe('claim:aaaaaaaa-0000-4000-8000-000000000001:');
    expect(below).toBe('claim:aaaaaaaa-0000-4000-8000-000000000001;');
    const inside = (key: string): boolean => key >= from && key < below;
    // JavaScript compares strings by UTF-16 code unit, which for these ASCII
    // keys is the byte order the pattern operators use.
    expect(inside('claim:aaaaaaaa-0000-4000-8000-000000000001:task:lot')).toBe(true);
    expect(inside('claim:aaaaaaaa-0000-4000-8000-000000000001')).toBe(false);
    expect(inside('claim:aaaaaaaa-0000-4000-8000-0000000000011:task:lot')).toBe(false);
    expect(inside('claim:aaaaaaaa-0000-4000-8000-000000000002:task:lot')).toBe(false);
    expect(() => keyPrefixRange('hold:task')).toThrow(/ends in a colon/);
  });
});

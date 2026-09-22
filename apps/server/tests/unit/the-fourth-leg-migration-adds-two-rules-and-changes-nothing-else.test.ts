// Migration 0133 wires the fourth leg of the task balance and closes the shadow
// early return — and changes nothing else about the function it replaces.
//
// ⛔ IT REPLACES A FUNCTION THE WHOLE BALANCE RUNS THROUGH, which is why this
// file is written the way 0132's is. `credit_check_reservation` is 0131's, it is
// applied in production, and three constraint triggers already point at it.
// 0133 re-states its ENTIRE body in order to add eight lines to the middle, so
// every rule it carries is re-typed — and a rule accidentally dropped in the
// re-typing looks exactly like a function that was always shorter. A green
// integration run cannot show you that: the arms that would have caught the
// missing rule are arms nobody thought to write, because the rule was there.
//
// So the replacement is pinned BY DIFFERENCE against 0131's own text, read from
// 0131's file rather than from a copy kept here — a second copy of the body is
// the thing this file exists to avoid needing. The delta must be exactly the
// shadow check, in both directions.
//
// What the two rules DO is proved against real Postgres in
// `a-holds-only-statement-re-checks-its-task-and-a-measurement-is-never-charged`;
// this file is about the text that test runs against.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0133_credit_holds_leg_and_shadow_charge';

function migration(tag: string): string {
  return readFileSync(resolve(DB, 'migrations', `${tag}.sql`), 'utf8');
}

/** A migration with its `--` comments removed. */
function withoutComments(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const RAW = migration(TAG);
const SQL = withoutComments(RAW);

/** Top-level statements: split on `;` outside `$$ … $$` function bodies. */
function statementsOf(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inBody = false;
  for (const part of sql.split(/(\$\$)/)) {
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

function statements(): string[] {
  return statementsOf(SQL);
}

/** The `$$ … $$` body of one function, as trimmed non-empty lines. */
function functionLines(sql: string, signature: string): string[] {
  const at = sql.indexOf(`FUNCTION ${signature}`);
  if (at < 0) throw new Error(`${signature} is not in that migration`);
  const open = sql.indexOf('$$', at);
  const close = sql.indexOf('$$', open + 2);
  if (open < 0 || close < 0) throw new Error(`${signature} has no body`);
  return sql
    .slice(open + 2, close)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** Lines of `to` that `from` does not account for, counted as a multiset. */
function surplus(from: readonly string[], to: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const line of from) left.set(line, (left.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of to) {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else out.push(line);
  }
  return out.sort();
}

const CHECK_SIGNATURE = '"credit_check_reservation"(rid uuid)';
const CHECK_0131 = functionLines(
  withoutComments(migration('0131_credit_reservations')),
  CHECK_SIGNATURE,
);
const CHECK_0133 = functionLines(SQL, CHECK_SIGNATURE);

describe('migration 0133 adds the fourth leg and the shadow charge rule, and nothing else', () => {
  it('CRITICAL the FIRST statement is the lock timeout, and it is SET LOCAL: scoped to the migrator’s transaction, never the session', () => {
    expect(statements()[0]).toBe("SET LOCAL lock_timeout = '5s'");
    // Statement-level, not a scan of the whole file: `SET search_path` is an
    // ATTRIBUTE of a function declaration, not a session setting, and a regex
    // over the text reports it as one.
    expect(
      statements().filter((s) => /^SET\b/.test(s) && !/^SET LOCAL\b/.test(s)),
      'a bare SET would outlive the migration on a pooled connection',
    ).toEqual([]);
  });

  it('CRITICAL it is exactly five statements and each is one of the two rules. A sixth, or one of a shape not listed here, is a change nobody decided to make', () => {
    const kinds = statements().map((s) => {
      if (/^SET LOCAL lock_timeout/.test(s)) return 'set';
      if (/^CREATE OR REPLACE FUNCTION "credit_check_reservation"\(rid uuid\)/.test(s)) {
        return 'replace credit_check_reservation';
      }
      if (/^CREATE OR REPLACE FUNCTION "credit_check_reservation_from_hold"\(\)/.test(s)) {
        return 'function credit_check_reservation_from_hold';
      }
      if (/^DROP TRIGGER IF EXISTS "credit_holds_reservation_balance"/.test(s)) {
        return 'drop the trigger if a draft left one';
      }
      if (/^CREATE CONSTRAINT TRIGGER "credit_holds_reservation_balance"/.test(s)) {
        return 'constraint trigger on credit_reservation_holds';
      }
      return `UNEXPECTED: ${s.slice(0, 70)}`;
    });
    expect(kinds).toEqual([
      'set',
      'replace credit_check_reservation',
      'function credit_check_reservation_from_hold',
      'drop the trigger if a draft left one',
      'constraint trigger on credit_reservation_holds',
    ]);
  });

  it('⛔ CRITICAL nothing is destroyed. The one DROP is the trigger the very next statement creates — the re-runnability pair — and no table, column, index, constraint, function or row is removed, retyped or renamed anywhere in the file', () => {
    expect(SQL).not.toMatch(
      /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|FUNCTION)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bRENAME\b/i,
    );
    const drops = statements().filter((s) => /\bDROP\b/i.test(s));
    expect(drops).toHaveLength(1);
    const at = statements().findIndex((s) => /\bDROP\b/i.test(s));
    expect(
      statements()[at + 1],
      'the DROP and the CREATE are adjacent, or the file is not re-runnable',
    ).toMatch(/^CREATE CONSTRAINT TRIGGER "credit_holds_reservation_balance"/);
  });

  it('⛔ CRITICAL `credit_check_reservation` is 0131’s function plus the shadow check and NOTHING else — measured by difference against 0131’s own text, in both directions, not against a copy kept here. Every rule that function carries is re-typed by this migration, and one dropped in the re-typing reads as a function that was always shorter', () => {
    expect(surplus(CHECK_0131, CHECK_0133), 'the lines 0133 adds').toEqual(
      [
        `IF r."mode" = 'shadow' THEN`,
        'IF EXISTS (SELECT 1 FROM "credit_ledger"',
        `WHERE "reservation_id" = rid AND "kind" = 'task_charge') THEN`,
        `RAISE EXCEPTION 'shadow reservation % is measured, not charged: the ledger charges it', rid`,
        `USING ERRCODE = '23514';`,
        'END IF;',
        'END IF;',
        'RETURN;',
      ].sort(),
    );
    expect(surplus(CHECK_0133, CHECK_0131), 'the lines it removes — the bare early return').toEqual(
      [`IF r."mode" = 'shadow' THEN RETURN; END IF;`],
    );
  });

  it('⛔ CRITICAL the shadow check sits where the early return was: AFTER the calls are checked, so a measurement’s own counters are still verified, and BEFORE the return, or it would be dead code that never runs', () => {
    const at = CHECK_0133.indexOf(`IF r."mode" = 'shadow' THEN`);
    const calls = CHECK_0133.findIndex((l) => l.includes('but its calls commit'));
    const holds = CHECK_0133.findIndex((l) => l.includes('but holds'));
    expect(calls).toBeGreaterThan(-1);
    expect(at, 'after the calls check').toBeGreaterThan(calls);
    expect(at, 'and before the holds leg, which a measurement has none of').toBeLessThan(holds);
    expect(
      CHECK_0133.slice(at, at + 8).some((l) => l === 'RETURN;'),
      'the return is inside the same branch, not before the check',
    ).toBe(true);
  });

  it('CRITICAL every function in the file pins its search_path to public, then pg_temp — including the replacement, where the attribute has to be stated again or it is lost', () => {
    const fns = statements().filter((s) => /^CREATE OR REPLACE FUNCTION /.test(s));
    expect(fns).toHaveLength(2);
    for (const fn of fns) {
      expect(fn.replace(/\s+/g, ' '), fn.slice(0, 60)).toContain(
        'SET search_path = public, pg_temp',
      );
    }
  });

  it('⛔ CRITICAL the fourth leg is a CONSTRAINT trigger, DEFERRABLE INITIALLY DEFERRED, on INSERT OR UPDATE. An immediate check would refuse every reserve at its first hold and every settle at its first release, because a task and the holds behind it are separate statements of one transaction', () => {
    const trigger = statements().find((s) => /^CREATE CONSTRAINT TRIGGER/.test(s)) ?? '';
    const flat = trigger.replace(/\s+/g, ' ');
    expect(flat).toContain('AFTER INSERT OR UPDATE ON "credit_reservation_holds"');
    expect(flat).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(flat).toContain('FOR EACH ROW EXECUTE FUNCTION "credit_check_reservation_from_hold"()');
    // No WHEN clause: the ledger's leg has one because most ledger rows name no
    // task, and every hold names one.
    expect(flat, 'every hold names a task, so there is nothing to filter on').not.toMatch(/WHEN/);
  });

  it('⛔ CRITICAL the trigger’s name sorts AFTER `credit_holds_debt_vs_free`, and BOTH names are READ FROM THEIR OWN MIGRATIONS. Row triggers fire in name order and deferred events fire at COMMIT in the order they were queued, so a release that frees credit beside debt still reports the DEBT refusal — which is the one `a-hold-moves-held-credit-and-nothing-else-does` pins by constraint name', () => {
    // ⛔ NEITHER NAME IS A LITERAL IN THE ASSERTION, and that is the whole arm.
    // Written as two literals compared with their own `.sort()`, this is a
    // TAUTOLOGY: `['a','b'].sort()` is `['a','b']` whatever the migration is
    // actually called. MEASURED — with the trigger renamed in the SQL to
    // `credit_holds_aaa_balance`, a name that sorts FIRST and would steal the
    // refusal this ordering exists to protect, the literal form still passed.
    const mine =
      /CREATE CONSTRAINT TRIGGER "(\w+)"\s+AFTER INSERT OR UPDATE ON "credit_reservation_holds"/.exec(
        SQL,
      )?.[1];
    const debt =
      /CREATE CONSTRAINT TRIGGER "(\w+)"\s+AFTER UPDATE ON "credit_reservation_holds"/.exec(
        withoutComments(migration('0131_credit_reservations')),
      )?.[1];
    expect(typeof mine, '0133 installs a constraint trigger on the holds').toBe('string');
    expect(typeof debt, '0131 installed one on the same table').toBe('string');
    expect(mine, 'two legs, two names').not.toBe(debt);
    expect(
      [mine, debt].sort(),
      'the debt refusal is queued first, so it is the one that reports',
    ).toEqual([debt, mine]);
  });

  it('CRITICAL it adds no CHECK and no index, which is what keeps the schema.ts mirror counts in `the-reservations-migration-only-adds-and-every-guard-it-installs-is-pinned-down` unchanged — that arm now reads THIS file too, so a CHECK added here without a schema.ts entry fails there as well as breaking the count', () => {
    expect(SQL).not.toMatch(/CREATE (?:UNIQUE )?INDEX/);
    expect(SQL).not.toMatch(/CONSTRAINT "\w+"\s+CHECK/);
    expect(SQL).not.toMatch(/ADD CONSTRAINT/);
  });

  it('the journal applies it last, after 0132, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(133);
    expect(journal.entries[at]?.idx).toBe(133);
    expect(journal.entries[at - 1]?.tag).toBe('0132_credit_guard_gaps');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
    // 0134 (the credits admin audit trail, 2026-09-22) follows it; pinned from
    // both sides like 0132's guard pins 0133.
    expect(journal.entries[at + 1]?.tag).toBe('0134_ai_credits_admin_audit_log');
    expect(journal.entries[at + 1]?.when).toBeGreaterThan(journal.entries[at]?.when ?? Infinity);
    // 0135 (S16 — the cutover/rollback audit actions) follows 0134; 0134 no
    // longer needs its own guard file to pin it as "the last one" because
    // this file's own reach already extends one migration past it.
    expect(journal.entries[at + 2]?.tag).toBe('0135_ai_credits_admin_audit_log_cutover_actions');
    expect(journal.entries[at + 2]?.when).toBeGreaterThan(
      journal.entries[at + 1]?.when ?? Infinity,
    );
    expect(journal.entries, 'and 0135 is the last one').toHaveLength(136);
  });

  it('CRITICAL schema.ts names the trigger this migration installs, says where the shadow rule lives, and carries the one sentence about the relaxed clawback guard that 0133 is the record of', () => {
    const schema = readFileSync(resolve(DB, 'schema.ts'), 'utf8');
    const at = schema.indexOf(
      'credit_reservations / credit_reservation_holds / credit_model_calls',
    );
    expect(at).toBeGreaterThan(0);
    const note = schema.slice(at, schema.indexOf('export const creditReservations = pgTable(', at));
    for (const said of [
      'credit_holds_reservation_balance',
      'AFTER INSERT OR',
      'DEFERRABLE INITIALLY DEFERRED',
      '0133',
      'SHADOW task',
      'task_charge',
    ]) {
      expect(note, `schema.ts says "${said}"`).toContain(said);
    }
    // The clawback sentence sits beside the guard it is about, one table over.
    const clawbacks = schema.slice(
      schema.indexOf('credit_clawbacks_guard_trigger'),
      schema.indexOf('export const creditWindows = pgTable('),
    );
    expect(clawbacks).toContain('0133');
    expect(clawbacks.replace(/\s+\/\/\s+/g, ' ')).toContain('applied → reversed');
    expect(clawbacks).toContain('harmless today');
  });

  it('CRITICAL the SQL is what schema.ts claims it is: the trigger schema.ts documents is the trigger the migration creates, spelled the same way', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    expect(
      schema,
      'schema.ts declares nothing in code for a trigger — it is prose beside the table',
    ).not.toContain('credit_holds_reservation_balance');
    expect(SQL).toContain('CREATE CONSTRAINT TRIGGER "credit_holds_reservation_balance"');
  });
});

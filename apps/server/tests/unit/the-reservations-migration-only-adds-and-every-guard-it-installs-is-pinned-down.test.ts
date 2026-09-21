// Migration 0131 only adds, fails fast on a busy table, pins every guard it
// installs, and is mirrored name for name in schema.ts.
//
// It runs while the old process is still serving, and it touches four tables
// that already exist: `accounts`, `credit_rate_cards` and `credit_lots` through
// new foreign keys, `credit_ledger` through one of its own, and `credit_windows`
// through a constraint adopted onto an index that is already there. None of what
// keeps that safe shows in a green run against an idle database:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds,
//     whole, which is safe to retry;
//   · nothing existing is dropped, retyped or rewritten — the one statement that
//     touches an existing object is `ADD CONSTRAINT … UNIQUE USING INDEX`, which
//     re-labels an index rather than building one;
//   · every function pins `search_path = public, pg_temp`, so a session's
//     temporary table named like a credit table cannot stand in for the real one
//     inside a guard (pg_temp is otherwise searched FIRST);
//   · the hold trigger requires a STARTED lot (H4) — without that clause a task
//     could hold, and then spend, credits of a month that has not begun;
//   · the three balance checks are CONSTRAINT triggers, DEFERRABLE INITIALLY
//     DEFERRED, because a reservation and the holds that back it are separate
//     statements of one transaction and an immediate check would refuse every
//     one of them halfway through.
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
const TAG = '0131_credit_reservations';
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

describe('migration 0131 only adds, and every guard it installs is pinned down', () => {
  it('CRITICAL the FIRST statement is the lock timeout, and it is SET LOCAL: scoped to the migrator’s transaction, never the session', () => {
    const all = statements();
    expect(all[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(all.filter((s) => /lock_timeout/.test(s))).toHaveLength(1);
  });

  it('CRITICAL it only ADDS: one adopted constraint, three tables, their indexes, six functions with their triggers, and one foreign key on `credit_ledger`. Nothing that existed is dropped, retyped or rewritten', () => {
    const kinds = statements().map((s) => {
      if (/^SET LOCAL /.test(s)) return 'set';
      const table = /^CREATE TABLE "(\w+)" /.exec(s)?.[1];
      if (table !== undefined) return `table ${table}`;
      const index = /^CREATE (?:UNIQUE )?INDEX "(\w+)"\s+ON "(\w+)"/.exec(s);
      if (index !== null) return `index on ${index[2] ?? '?'}`;
      const fn = /^CREATE FUNCTION "(\w+)"\(/.exec(s)?.[1];
      if (fn !== undefined) return `function ${fn}`;
      const constraintTrigger = /^CREATE CONSTRAINT TRIGGER "\w+" AFTER [A-Z ]+ ON "(\w+)"/.exec(
        s,
      )?.[1];
      if (constraintTrigger !== undefined) return `constraint trigger on ${constraintTrigger}`;
      const trigger = /^CREATE TRIGGER "\w+" (?:BEFORE|AFTER) [A-Z ]+ ON "(\w+)"/.exec(s)?.[1];
      if (trigger !== undefined) return `trigger on ${trigger}`;
      if (
        /^ALTER TABLE "credit_windows" ADD CONSTRAINT "credit_windows_id_account_unique"\s+UNIQUE USING INDEX "credit_windows_id_account_unique"$/.test(
          s,
        )
      ) {
        return 'adopt the credit_windows unique index as a constraint';
      }
      if (
        /^ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_reservation_fk"\s+FOREIGN KEY/.test(
          s,
        )
      ) {
        return 'foreign key on credit_ledger';
      }
      return `UNEXPECTED: ${s.slice(0, 70)}`;
    });
    expect(kinds).toEqual([
      'set',
      'adopt the credit_windows unique index as a constraint',
      'table credit_reservations',
      'index on credit_reservations',
      'index on credit_reservations',
      'index on credit_reservations',
      'index on credit_reservations',
      'index on credit_reservations',
      'table credit_reservation_holds',
      'table credit_model_calls',
      'index on credit_model_calls',
      'foreign key on credit_ledger',
      'function credit_holds_apply',
      'trigger on credit_reservation_holds',
      'trigger on credit_reservation_holds',
      'trigger on credit_model_calls',
      'trigger on credit_reservations',
      'function credit_reservations_guard',
      'trigger on credit_reservations',
      'function credit_model_calls_guard',
      'trigger on credit_model_calls',
      'function credit_check_reservation',
      'function credit_check_reservation_from_call',
      'function credit_check_reservation_from_row',
      'constraint trigger on credit_model_calls',
      'constraint trigger on credit_reservations',
      'constraint trigger on credit_reservation_holds',
    ]);
    expect(SQL).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bRENAME\b/i,
    );
  });

  it('CRITICAL the credit_windows key is ADOPTED, not rebuilt: `UNIQUE USING INDEX` re-labels the index 0130 already created, so the statement rewrites nothing and builds nothing', () => {
    const adopt = statements().find((s) =>
      /ADD CONSTRAINT "credit_windows_id_account_unique"/.test(s),
    );
    expect(adopt).toBeDefined();
    expect(adopt).toContain('UNIQUE USING INDEX "credit_windows_id_account_unique"');
    // The other spelling — CREATE UNIQUE INDEX, or a UNIQUE (…) column list —
    // would build a second index over the same columns on a live table.
    expect(adopt).not.toMatch(/UNIQUE\s*\(/);
    expect(SQL, '0131 creates no index on credit_windows at all').not.toMatch(
      /CREATE (?:UNIQUE )?INDEX "\w+"\s+ON "credit_windows"/,
    );
  });

  it('CRITICAL every function pins its search_path to public, then pg_temp — including the one that is not a trigger function', () => {
    const functions = statements().filter((s) => /^CREATE FUNCTION /.test(s));
    expect(functions).toHaveLength(6);
    for (const fn of functions) {
      expect(fn, fn.slice(0, 60)).toMatch(/\s+SET search_path = public, pg_temp AS \$\$/);
    }
  });

  it('⛔ CRITICAL the hold trigger requires a lot that has STARTED (H4). Without that clause a task could hold — and then spend — credits of a month that has not begun, and a payment refunded before that month starts would take back credit that is already gone', () => {
    const fn = statements().find((s) => /^CREATE FUNCTION "credit_holds_apply"/.test(s)) ?? '';
    expect(fn.replace(/\s+/g, ' ')).toContain(
      'WHERE "id" = NEW."lot_id" AND "account_id" = NEW."account_id" AND "revoked_at" IS NULL AND "starts_at" <= now() AND "expires_at" > now()',
    );
    expect(fn).toMatch(/a hold needs a started, live, unrevoked lot of the same account/);
    // And the release branch takes the WHOLE hold back off the lot, whatever the
    // lot's term is by then: a task that outlived its month still gives its
    // credit up.
    expect(fn.replace(/\s+/g, ' ')).toContain(
      'UPDATE "credit_lots" SET "held_micro" = "held_micro" - OLD."held_micro" WHERE "id" = OLD."lot_id"',
    );
  });

  it('⛔ CRITICAL a hold is BORN UNRELEASED, and a release keeps the hold’s account and its task — without those three clauses held credit can be frozen on a lot for ever, or freed past the COMMIT-time debt check by naming an account that owes nothing', () => {
    const fn = (
      statements().find((s) => /^CREATE FUNCTION "credit_holds_apply"/.test(s)) ?? ''
    ).replace(/\s+/g, ' ');
    // Born unreleased: the release branch needs OLD."released_at" IS NULL, so a
    // row that arrives already released can never give its credit back.
    expect(fn).toContain(
      'IF NEW."released_at" IS NOT NULL OR NEW."charged_micro" IS NOT NULL THEN',
    );
    expect(fn).toContain("RAISE EXCEPTION 'a hold is born unreleased'");
    // The release keeps its account (which `credit_check_debt_vs_free` asks
    // about) and its task (whose holds must sum to what it reserved).
    expect(fn).toContain('AND NEW."account_id" = OLD."account_id"');
    expect(fn).toContain('AND NEW."reservation_id" = OLD."reservation_id"');
  });

  it('⛔ CRITICAL a hold and a model call are keyed to their task by (task, ACCOUNT), not by the task alone — keyed on the task alone, a hold can put another account’s credit behind this task, which freezes that credit and leaves the task unable to ever settle', () => {
    const all = statements();
    const reservations = all.find((s) => /^CREATE TABLE "credit_reservations" /.test(s)) ?? '';
    expect(reservations.replace(/\s+/g, ' '), 'the target the two keys point at').toContain(
      'CONSTRAINT "credit_reservations_id_account_unique" UNIQUE ("id", "account_id")',
    );
    for (const table of ['credit_reservation_holds', 'credit_model_calls']) {
      const body = (all.find((s) => new RegExp(`^CREATE TABLE "${table}" `).test(s)) ?? '').replace(
        /\s+/g,
        ' ',
      );
      expect(body, `${table} keys on the task AND the account`).toContain(
        `CONSTRAINT "${table}_reservation_fk" FOREIGN KEY ("reservation_id", "account_id") ` +
          'REFERENCES "credit_reservations"("id", "account_id") ON DELETE CASCADE',
      );
      // The column-level key is the one this replaces: left in place it would
      // accept the pair the composite key refuses, and nothing would say so.
      expect(body, `${table}.reservation_id carries no single-column key`).toContain(
        '"reservation_id" uuid NOT NULL,',
      );
    }
  });

  it('CRITICAL the three balance checks are CONSTRAINT triggers, DEFERRABLE INITIALLY DEFERRED — a reservation and its holds are separate statements of one transaction, so an immediate check would refuse every reserve halfway through', () => {
    const constraintTriggers = statements().filter((s) => /^CREATE CONSTRAINT TRIGGER /.test(s));
    expect(constraintTriggers).toHaveLength(3);
    for (const t of constraintTriggers) {
      expect(t.replace(/\s+/g, ' '), t.slice(0, 60)).toContain('DEFERRABLE INITIALLY DEFERRED');
    }
    expect(constraintTriggers.map((t) => /"(\w+)"/.exec(t)?.[1]).sort()).toEqual([
      'credit_holds_debt_vs_free',
      'credit_model_calls_balance',
      'credit_reservations_balance',
    ]);
  });

  it('CRITICAL the debt-beside-free-credit check is 0128’s function, REUSED — releasing a hold frees credit with no ledger row, which is the second way that state can arise, and a second copy of the predicate would be a second thing to keep in step', () => {
    expect(SQL).toMatch(
      /CREATE CONSTRAINT TRIGGER "credit_holds_debt_vs_free" AFTER UPDATE ON "credit_reservation_holds"/,
    );
    expect(SQL).toContain('EXECUTE FUNCTION "credit_check_debt_vs_free"()');
    expect(SQL, '0131 does not redefine it').not.toMatch(
      /CREATE FUNCTION "credit_check_debt_vs_free"/,
    );
    const ledger = readFileSync(resolve(DB, 'migrations', '0128_credit_ledger.sql'), 'utf8');
    expect(ledger, 'and 0128 is where it is defined').toMatch(
      /CREATE FUNCTION "credit_check_debt_vs_free"/,
    );
  });

  it('CRITICAL the delete guards are 0128’s append-only function, reused for all three new tables', () => {
    for (const table of ['credit_reservation_holds', 'credit_model_calls', 'credit_reservations']) {
      expect(SQL.replace(/\s+/g, ' ')).toContain(
        `BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "credit_rows_die_only_with_their_account"()`,
      );
    }
  });

  it('the journal applies it last, after 0130, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(131);
    expect(journal.entries[at]?.idx).toBe(131);
    expect(journal.entries[at - 1]?.tag).toBe('0130_credit_windows');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('CRITICAL schema.ts mirrors every CHECK and every index the migration creates, by name, and names none it does not create — counting 0132, which adds one of each to these same three tables', () => {
    // ⛔ TWO MIGRATIONS, ONE SET OF TABLES. 0132 adds
    // `credit_model_calls_no_record_really` and
    // `credit_reservation_holds_open_idx` to tables 0131 created, so a mirror
    // check scoped to 0131 alone would report both as names schema.ts invents.
    // The union is what schema.ts actually has to match; 0132's own guard is
    // `the-credit-gap-migration-changes-exactly-three-guards-and-pins-each-one`.
    //
    // ⛔ THE LATER MIGRATIONS ARE LISTED HERE BY NAME, so a further one on these
    // tables joins this comparison by being ADDED to this list — it does not
    // join itself. This used to say the opposite; 0133 is the migration that
    // proved it wrong, having been written without appearing here. It
    // contributes no CHECK and no index (its own guard,
    // `the-fourth-leg-migration-adds-two-rules-and-changes-nothing-else`, has
    // the arm that keeps that true), so the counts below are unchanged by it —
    // which is exactly why a stale list here fails silently and has to be read
    // as a list.
    const LATER = ['0132_credit_guard_gaps', '0133_credit_holds_leg_and_shadow_charge']
      .map((tag) => readFileSync(resolve(DB, 'migrations', `${tag}.sql`), 'utf8'))
      .join('\n')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const both = `${SQL}\n${LATER}`;
    const inSql = {
      checks: [...both.matchAll(/CONSTRAINT "(\w+)"\s+CHECK/g)].map((m) => m[1] ?? '').sort(),
      indexes: [...both.matchAll(/CREATE (?:UNIQUE )?INDEX "(\w+)"/g)]
        .map((m) => m[1] ?? '')
        .sort(),
    };
    // 10 on reservations, 2 on holds, 10 on model calls — plus 0132's one more
    // on model calls, and its re-statement of `credit_reservations_amounts`,
    // which names a constraint 0131 already named and so must be de-duplicated.
    expect(new Set(inSql.checks).size).toBe(23);
    expect(inSql.indexes).toHaveLength(7);
    inSql.checks = [...new Set(inSql.checks)].sort();

    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const mine = /^(credit_reservations_|credit_reservation_holds_|credit_model_calls_)/;
    const named = (kinds: string[]): string[] =>
      [...schema.matchAll(new RegExp(`\\b(?:${kinds.join('|')})\\(\\s*'(\\w+)'`, 'g'))]
        .map((m) => m[1] ?? '')
        .filter((n) => mine.test(n))
        .sort();
    expect(named(['check'])).toEqual(inSql.checks);
    expect(named(['index', 'uniqueIndex'])).toEqual(inSql.indexes);
    // The one uniqueness the migration states inside CREATE TABLE rather than as
    // an index, so it is declared as a table-level `unique(...)` rather than a
    // `uniqueIndex(...)` and the arm above would not see it.
    expect(SQL).toContain(
      'CONSTRAINT "credit_model_calls_seq_unique" UNIQUE ("reservation_id", "seq")',
    );
    expect(schema.replace(/\s+/g, ' ')).toContain(
      "unique('credit_model_calls_seq_unique').on(t.reservationId, t.seq)",
    );
  });

  it('CRITICAL every column the migration creates is on a LINE OF ITS OWN, because the guard that holds schema.ts to the migrations reads one column per line and would report the rest as missing', () => {
    for (const table of statements().filter((s) => /^CREATE TABLE /.test(s))) {
      const body = /\(([\s\S]*)\n\)$/.exec(table)?.[1] ?? '';
      for (const line of body.split('\n')) {
        const columns = [
          ...line.matchAll(
            /^\s*"(\w+)"\s+(?:uuid|text|bigint|integer|smallint|boolean|timestamptz)\b/g,
          ),
        ];
        expect(columns.length, `two column declarations on one line: ${line.trim()}`).toBeLessThan(
          2,
        );
      }
    }
  });

  it('CRITICAL what Drizzle cannot declare is written down beside the tables — the six triggers, the two partial unique indexes and the COMMIT-time checks — and every test that comment names exists', () => {
    const schema = readFileSync(resolve(DB, 'schema.ts'), 'utf8');
    const at = schema.indexOf(
      'credit_reservations / credit_reservation_holds / credit_model_calls',
    );
    expect(at).toBeGreaterThan(0);
    const note = schema.slice(at, schema.indexOf('export const creditReservations = pgTable(', at));
    for (const said of [
      'credit_holds_apply_trigger',
      'credit_reservations_guard_trigger',
      'credit_model_calls_guard_trigger',
      'credit_reservations_balance',
      'credit_model_calls_balance',
      'credit_holds_debt_vs_free',
      'credit_reservations_open_slot_unique',
      'credit_reservations_request_unique',
      'DEFERRABLE',
      'search_path = public, pg_temp',
      'starts_at <= now()',
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

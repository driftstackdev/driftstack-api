// Migration 0132 closes six gaps the S7/S8/S9 reviews proved, changes exactly
// three things that already existed, and is mirrored name for name in schema.ts.
//
// ⛔ IT IS THE FIRST CREDITS MIGRATION THAT DOES NOT ONLY ADD, which is why this
// file exists and why it is stricter than its two siblings. 0127–0131 are
// applied in production and are immutable; everything here is new text, and two
// of its statements REPLACE a guard function while a third drops a CHECK and
// states it again. Each of those three is supposed to be a WIDENING in one named
// direction and nothing else, and "nothing else" is not something a green
// integration run can show you — an accidentally deleted clause in a replaced
// function body looks exactly like a function that was always shorter.
//
// So the three changes are pinned by DIFFERENCE against the migration that
// installed them: every line of 0131's `credit_holds_apply` must still be there,
// the lines that are new must be only the reservation lookup, and 0130's
// `credit_clawbacks_guard` must keep every rule it had except the one that is
// deliberately relaxed.
//
// What these rules DO is proved against Postgres in
// `a-late-charge-is-refused-an-unsent-call-is-not-billed-and-a-clawback-records-its-debt`
// and `a-hold-moves-held-credit-and-nothing-else-does`; this file is about the
// text those tests run against.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0132_credit_guard_gaps';

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

/**
 * The `$$ … $$` body of one function, as a list of trimmed non-empty lines.
 *
 * Read from whichever migration is asked, so a replacement can be compared with
 * the original rather than with a copy of it kept here — a second copy of the
 * text is the thing this file exists to avoid needing.
 */
function functionLines(sql: string, name: string): string[] {
  const at = sql.indexOf(`FUNCTION "${name}"()`);
  if (at < 0) throw new Error(`${name} is not in that migration`);
  const open = sql.indexOf('$$', at);
  const close = sql.indexOf('$$', open + 2);
  if (open < 0 || close < 0) throw new Error(`${name} has no body`);
  return sql
    .slice(open + 2, close)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

const HOLDS_0131 = functionLines(
  withoutComments(migration('0131_credit_reservations')),
  'credit_holds_apply',
);
const HOLDS_0132 = functionLines(SQL, 'credit_holds_apply');
const CLAWBACKS_0130 = functionLines(
  withoutComments(migration('0130_credit_windows')),
  'credit_clawbacks_guard',
);
const CLAWBACKS_0132 = functionLines(SQL, 'credit_clawbacks_guard');

describe('migration 0132 changes exactly three guards, and pins each one', () => {
  it('CRITICAL the FIRST statement is the lock timeout, and it is SET LOCAL: scoped to the migrator’s transaction, never the session', () => {
    const all = statements();
    expect(all[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(all.filter((s) => /lock_timeout/.test(s))).toHaveLength(1);
  });

  it('CRITICAL it is exactly nine statements and each is one of the six gaps. A tenth, or one of a shape not listed here, is a change nobody decided to make', () => {
    const kinds = statements().map((s) => {
      if (/^SET LOCAL /.test(s)) return 'set';
      const add = /^ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"/.exec(s);
      if (add !== null) return `add check ${add[2] ?? '?'} on ${add[1] ?? '?'}`;
      const drop = /^ALTER TABLE "(\w+)" DROP CONSTRAINT "(\w+)"/.exec(s);
      if (drop !== null) return `drop constraint ${drop[2] ?? '?'} on ${drop[1] ?? '?'}`;
      const index = /^CREATE (?:UNIQUE )?INDEX "(\w+)" ON "(\w+)"/.exec(s);
      if (index !== null) return `index ${index[1] ?? '?'} on ${index[2] ?? '?'}`;
      const replaced = /^CREATE OR REPLACE FUNCTION "(\w+)"\(/.exec(s)?.[1];
      if (replaced !== undefined) return `replace function ${replaced}`;
      const fn = /^CREATE FUNCTION "(\w+)"\(/.exec(s)?.[1];
      if (fn !== undefined) return `function ${fn}`;
      const ct = /^CREATE CONSTRAINT TRIGGER "(\w+)" AFTER [A-Z ]+ ON "(\w+)"/.exec(s);
      if (ct !== null) return `constraint trigger ${ct[1] ?? '?'} on ${ct[2] ?? '?'}`;
      return `UNEXPECTED: ${s.slice(0, 70)}`;
    });
    expect(kinds).toEqual([
      'set',
      'add check credit_model_calls_no_record_really on credit_model_calls',
      'drop constraint credit_reservations_amounts on credit_reservations',
      'add check credit_reservations_amounts on credit_reservations',
      'index credit_reservation_holds_open_idx on credit_reservation_holds',
      'replace function credit_holds_apply',
      'function credit_check_reservation_from_ledger',
      'constraint trigger credit_ledger_reservation_balance on credit_ledger',
      'replace function credit_clawbacks_guard',
    ]);
  });

  it('⛔ CRITICAL nothing is destroyed. The one DROP is the CHECK that is re-stated in the very next statement, and no table, index, trigger, function or row is removed, retyped or renamed anywhere in the file', () => {
    const all = statements();
    const drops = all.filter((s) => /\bDROP\b/i.test(s));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toBe(
      'ALTER TABLE "credit_reservations" DROP CONSTRAINT "credit_reservations_amounts"',
    );
    // …and it is re-stated IMMEDIATELY, in the same batch, so there is no window
    // in which the table is running without it.
    expect(all[all.indexOf(drops[0] ?? '') + 1]).toMatch(
      /^ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_amounts"\s+CHECK/,
    );
    expect(SQL).not.toMatch(
      /\bDROP\s+(?:TABLE|INDEX|TRIGGER|FUNCTION|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bRENAME\b/i,
    );
  });

  it('⛔ CRITICAL the two replaced functions keep their OID — `CREATE OR REPLACE`, never DROP and CREATE — so the eight triggers already pointing at them are untouched and this migration creates no trigger on their tables', () => {
    for (const name of ['credit_holds_apply', 'credit_clawbacks_guard']) {
      expect(SQL, name).toContain(`CREATE OR REPLACE FUNCTION "${name}"()`);
      expect(SQL, `${name} is not dropped first`).not.toMatch(
        new RegExp(`DROP FUNCTION[^\\n]*${name}`),
      );
    }
    // The only trigger this migration creates is the new one on credit_ledger.
    const triggers = statements().filter((s) => /CREATE (?:CONSTRAINT )?TRIGGER/.test(s));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatch(/^CREATE CONSTRAINT TRIGGER "credit_ledger_reservation_balance"/);
  });

  it('CRITICAL every function in the file pins its search_path to public, then pg_temp — including the two that are replacements, where the attribute has to be stated again or it is lost', () => {
    const functions = statements().filter((s) => /^CREATE (?:OR REPLACE )?FUNCTION /.test(s));
    expect(functions).toHaveLength(3);
    for (const fn of functions) {
      expect(fn, fn.slice(0, 60)).toMatch(/\s+SET search_path = public, pg_temp AS \$\$/);
    }
  });

  it('⛔ CRITICAL `credit_holds_apply` is 0131’s function plus ONE lookup and nothing else. Every line 0131 installed is still there — measured by difference against 0131’s own text, not against a copy kept here — and the only new lines are the open-enforced-task test', () => {
    const removed = HOLDS_0131.filter(
      (line) => !HOLDS_0132.includes(line) && !/^CREATE FUNCTION/.test(line),
    );
    expect(removed, 'lines 0131 had that the replacement dropped').toEqual([]);

    const added = HOLDS_0132.filter(
      (line) => !HOLDS_0131.includes(line) && !/^CREATE OR REPLACE FUNCTION/.test(line),
    );
    expect(added).toEqual([
      'PERFORM 1 FROM "credit_reservations"',
      'WHERE "id" = NEW."reservation_id"',
      'AND "state" = \'open\' AND "mode" = \'enforce\'',
      'FOR SHARE;',
      "RAISE EXCEPTION 'a hold needs an open, enforced task' USING ERRCODE = '23514';",
    ]);
    // `IF NOT FOUND THEN` and `END IF;` close the new block too and are
    // therefore NOT in the list above: both are lines 0131 already had, so a
    // difference by line cannot see them. Said out loud, and counted, because
    // "the added lines are five" would otherwise read as a block with no end.
    for (const line of ['IF NOT FOUND THEN', 'END IF;']) {
      expect(HOLDS_0132.filter((l) => l === line).length, line).toBe(
        HOLDS_0131.filter((l) => l === line).length + 1,
      );
    }

    // Both halves of the predicate are required. `state` and `mode` are closed
    // CHECK domains, so a test on one alone would leave the other shape — a hold
    // behind a settled ENFORCED task, or behind an open SHADOW one — accepted,
    // and each of those freezes credit in its own way.
    const body = HOLDS_0132.join(' ');
    expect(body).toContain('"state" = \'open\' AND "mode" = \'enforce\'');
  });

  it('⛔ CRITICAL the lookup LOCKS the task row it reads — `FOR SHARE`, not an unlocked read — and asks by task id alone. Unlocked it answers from the inserting transaction’s snapshot and, when 0132 was written, nothing re-asked, because a statement touching only `credit_reservation_holds` queued no COMMIT-time check (0133 added that leg): measured, a hold inserted while the task was open committed AFTER a concurrent settlement and landed on a settled task, `held_micro` raised with no path back. Adding the ACCOUNT here would be the opposite mistake — answering, with a different code, a question the composite foreign key already answers first.', () => {
    const from = HOLDS_0132.findIndex((l) => /^PERFORM 1 FROM "credit_reservations"/.test(l));
    const to = HOLDS_0132.findIndex((l) => /^FOR SHARE;$/.test(l));
    expect(from, 'the lookup is there').toBeGreaterThan(-1);
    expect(to, 'and it ends in a row lock').toBeGreaterThan(from);
    expect(HOLDS_0132.slice(from, to + 1).join(' ')).toBe(
      'PERFORM 1 FROM "credit_reservations" WHERE "id" = NEW."reservation_id" ' +
        'AND "state" = \'open\' AND "mode" = \'enforce\' FOR SHARE;',
    );
    // `FOR SHARE`, never `FOR UPDATE`: two holds of the same task must not
    // serialise against each other, and the foreign-key check has already taken
    // `FOR KEY SHARE` on this row — which is not enough on its own, because KEY
    // SHARE does not block an UPDATE of a non-key column and `state` is one.
    expect(HOLDS_0132.join(' '), 'a row lock, and the weakest one that works').not.toMatch(
      /FOR UPDATE|FOR NO KEY UPDATE|FOR KEY SHARE/,
    );
    // ⛔ AND IT ASKS BY TASK ID ALONE.
    expect(HOLDS_0132.slice(from, to + 1).join(' ')).not.toContain('account_id');
  });

  it('⛔ CRITICAL the new lookup runs BEFORE the lot is touched, so a refused hold never reaches the statement that moves `held_micro`, and AFTER the born-unreleased test, whose message the hold tests pin', () => {
    const born = HOLDS_0132.findIndex((l) => /a hold is born unreleased/.test(l));
    const task = HOLDS_0132.findIndex((l) => /a hold needs an open, enforced task/.test(l));
    const lot = HOLDS_0132.findIndex((l) => /UPDATE "credit_lots" SET "held_micro"/.test(l));
    expect(born).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(born);
    expect(lot).toBeGreaterThan(task);
  });

  it('⛔ CRITICAL `credit_clawbacks_guard` keeps every rule 0130 gave it, and `debt_micro` leaves the immutable tuple only to be pinned to one movement in the same breath', () => {
    const before = CLAWBACKS_0130.join(' ').replace(/\s+/g, ' ');
    const after = CLAWBACKS_0132.join(' ').replace(/\s+/g, ' ');

    // The DELETE branch is untouched, word for word.
    expect(after).toContain(
      'IF TG_OP = \'DELETE\' THEN IF NOT EXISTS (SELECT 1 FROM "accounts" WHERE "id" = OLD."account_id") THEN RETURN OLD; END IF;',
    );
    // A claim still only ever falls, and the state still only ever moves
    // applied → reversed — the two rules that have nothing to do with the change.
    for (const kept of [
      'NEW."pending_micro" > OLD."pending_micro"',
      'OR (NEW."state" <> OLD."state" AND NOT (OLD."state" = \'applied\' AND NEW."state" = \'reversed\'))',
    ]) {
      expect(before, `0130 really said this: ${kept}`).toContain(kept);
      expect(after, `and 0132 still says it: ${kept}`).toContain(kept);
    }
    // Every other fact is still immutable. `debt_micro` is the ONLY name that
    // left the tuple.
    const tupleNames = (text: string): string[] =>
      [...(/IF \((NEW\."id".*?)\) IS DISTINCT FROM/.exec(text)?.[1] ?? '').matchAll(/"(\w+)"/g)]
        .map((m) => m[1] ?? '')
        .sort();
    expect(tupleNames(before).filter((n) => !tupleNames(after).includes(n))).toEqual([
      'debt_micro',
    ]);
    expect(tupleNames(after).filter((n) => !tupleNames(before).includes(n))).toEqual([]);

    // …and in its place, one movement and no other: a rise matched by an equal
    // fall in the claim, with both NULL tests spelled out — `debt_micro` is
    // nullable, and a comparison that came back unknown would make the whole IF
    // false, which is to say ACCEPT the update.
    expect(after).toContain(
      'OR (NEW."debt_micro" IS DISTINCT FROM OLD."debt_micro" AND NOT (NEW."pending_micro" < OLD."pending_micro" AND NEW."debt_micro" IS NOT NULL AND OLD."debt_micro" IS NOT NULL AND NEW."debt_micro" = OLD."debt_micro" + (OLD."pending_micro" - NEW."pending_micro")))',
    );
  });

  it('⛔ CRITICAL the re-stated amounts CHECK is a WIDENING: it keeps both of 0131’s other conjuncts word for word and admits exactly one new row shape — a shadow measurement of a model the card cannot price, reserving nothing', () => {
    const restated = (
      statements().find((s) =>
        /^ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_amounts"/.test(s),
      ) ?? ''
    ).replace(/\s+/g, ' ');
    const original = withoutComments(migration('0131_credit_reservations'))
      .replace(/\s+/g, ' ')
      .match(/CONSTRAINT "credit_reservations_amounts" CHECK \((.*?)\), CONSTRAINT/)?.[1];
    expect(original, "0131's own predicate was read").toBeTruthy();
    for (const conjunct of [
      '"committed_micro" >= 0',
      '("mode" = \'shadow\' OR "committed_micro" <= "reserved_micro")',
    ]) {
      expect(original ?? '', `0131 said ${conjunct}`).toContain(conjunct);
      expect(restated, `and 0132 still says ${conjunct}`).toContain(conjunct);
    }
    expect(original ?? '', '0131 required a positive reservation').toContain(
      '"reserved_micro" > 0',
    );
    expect(restated).toContain(
      '("reserved_micro" > 0 OR ("reserved_micro" = 0 AND "mode" = \'shadow\' ' +
        'AND "would_refuse_reason" IS NOT DISTINCT FROM \'model\'))',
    );
    // ⛔ `IS NOT DISTINCT FROM`, NEVER `= 'model'`, AND THE DIFFERENCE IS A
    // SECOND ROW SHAPE. A CHECK passes when its expression is NULL and
    // `would_refuse_reason` is nullable, so `= 'model'` evaluates to NULL — and
    // `FALSE OR NULL` is NULL — for a shadow row reserving zero with NO reason
    // recorded. Measured: that row inserted cleanly against `=` and is refused
    // against this. S11's census reads that column to tell a refusal from a
    // reading, so a zero with no reason would count as a reading of zero.
    expect(restated, 'the new disjunct is total over NULL').not.toMatch(
      /"would_refuse_reason" = 'model'/,
    );
  });

  it('⛔ CRITICAL the ledger’s balance check is a CONSTRAINT trigger, DEFERRABLE INITIALLY DEFERRED, on INSERT only, and only for a row that names a task — the same wiring 0131 gives the other two legs, because a settlement writes its charge, its releases and its ledger rows as separate statements of one transaction', () => {
    const trigger = (
      statements().find((s) =>
        /^CREATE CONSTRAINT TRIGGER "credit_ledger_reservation_balance"/.test(s),
      ) ?? ''
    ).replace(/\s+/g, ' ');
    expect(trigger).toContain('AFTER INSERT ON "credit_ledger"');
    expect(trigger, 'credit_ledger is append-only, so INSERT is the only event').not.toMatch(
      /AFTER [A-Z ]*UPDATE|AFTER [A-Z ]*DELETE/,
    );
    expect(trigger).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(trigger).toContain('FOR EACH ROW WHEN (NEW."reservation_id" IS NOT NULL)');
    expect(trigger).toContain('EXECUTE FUNCTION "credit_check_reservation_from_ledger"()');
    // It reuses 0131's checker rather than restating the balance, for the same
    // reason 0131 reuses 0128's debt check: a second copy of a predicate is a
    // second thing to keep in step.
    expect(SQL).toContain('PERFORM "credit_check_reservation"(NEW."reservation_id")');
    expect(SQL, '0132 does not redefine it').not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION "credit_check_reservation"\(/,
    );
    expect(
      withoutComments(migration('0131_credit_reservations')),
      'and 0131 is where it is defined',
    ).toMatch(/CREATE FUNCTION "credit_check_reservation"\(/);
  });

  it('⛔ CRITICAL the holds index is PARTIAL on “unreleased” and leads with `account_id`. A full index would grow with every enforced task for ever while the audit only ever reads the open set, and a different leading column would leave `claim_pending_with_no_open_hold` correlating on a column the index cannot seek', () => {
    const index = (
      statements().find((s) => /^CREATE INDEX "credit_reservation_holds_open_idx"/.test(s)) ?? ''
    ).replace(/\s+/g, ' ');
    expect(index).toBe(
      'CREATE INDEX "credit_reservation_holds_open_idx" ON "credit_reservation_holds" ("account_id", "reservation_id") WHERE "released_at" IS NULL',
    );
  });

  it('the journal applies it after 0131 and before 0133, each with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(132);
    expect(journal.entries[at]?.idx).toBe(132);
    expect(journal.entries[at - 1]?.tag).toBe('0131_credit_reservations');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
    // 0133 follows it — the fourth leg of the balance and the shadow charge
    // rule, both of which 0132's own text says it does not have. Pinned from
    // BOTH sides so neither a new migration that forgets its journal entry nor
    // a journal entry with no migration reads as this arm passing.
    expect(journal.entries[at + 1]?.tag).toBe('0133_credit_holds_leg_and_shadow_charge');
    expect(journal.entries[at + 1]?.when).toBeGreaterThan(journal.entries[at]?.when ?? Infinity);
    // 0134 (the credits admin audit trail) follows 0133; its own guard pins it.
    expect(journal.entries[at + 2]?.tag).toBe('0134_ai_credits_admin_audit_log');
    // 0135 (S16 — the cutover/rollback audit actions) follows 0134.
    expect(journal.entries[at + 3]?.tag).toBe('0135_ai_credits_admin_audit_log_cutover_actions');
    // 0136 (the S17 audit fix — a level change names the invoice it came from)
    // follows 0135.
    expect(journal.entries[at + 4]?.tag).toBe('0136_credit_window_level_change_source');
    // 0137 (the S17 re-audit fix — a lot remembers what its payment still paid
    // when it was granted) follows 0136.
    expect(journal.entries[at + 5]?.tag).toBe('0137_credit_lot_still_paid');
    // 0138 (an action taken from a signed-in browser is recorded against its
    // web session) follows 0137; its own guard pins its shape.
    expect(journal.entries[at + 6]?.tag).toBe('0138_web_session_actor_columns');
    // 0139 (the S17 third-audit fix — a window's undisputed level, and what a
    // level change's payment still paid) follows 0138; its own guard pins its
    // shape.
    expect(journal.entries[at + 7]?.tag).toBe('0139_credit_window_undisputed_level');
    expect(journal.entries, 'and 0139 is the last one').toHaveLength(140);
  });

  it('CRITICAL schema.ts mirrors the CHECK and the index this migration adds, by name, and its prose names the trigger it installs and the guard it relaxes', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    expect(schema.replace(/\s+/g, ' ')).toContain("check('credit_model_calls_no_record_really'");
    expect(schema.replace(/\s+/g, ' ')).toContain(
      "index('credit_reservation_holds_open_idx') .on(t.accountId, t.reservationId) .where(sql`${t.releasedAt} IS NULL`)",
    );
    expect(schema.replace(/\s+/g, ' ')).toContain(
      "check( 'credit_reservations_amounts', sql`(${t.reservedMicro} > 0 OR (${t.reservedMicro} = 0 AND ${t.mode} = 'shadow' AND ${t.wouldRefuseReason} IS NOT DISTINCT FROM 'model'))",
    );

    // The prose, which is the only place a trigger or a row lock can be
    // declared at all.
    const raw = readFileSync(resolve(DB, 'schema.ts'), 'utf8');
    for (const said of [
      'credit_ledger_reservation_balance',
      'a hold whose TASK is not an OPEN ENFORCED',
      'The lookup takes `FOR SHARE` on the task row',
      'may RISE by exactly the amount `pending_micro` FALLS',
    ]) {
      expect(raw, said).toContain(said);
    }
  });
});

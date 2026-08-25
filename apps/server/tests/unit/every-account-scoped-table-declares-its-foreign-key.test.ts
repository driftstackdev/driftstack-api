// An `account_id` column means a foreign key to `accounts`, or a stated reason.
//
// Thirty-one tables carry an `account_id`. Thirty declare
// `.references(() => accounts.id, { onDelete: 'cascade' })`. One — `crypto_orders`
// — declares no foreign key at all: not in the schema, not in any migration.
//
// Nothing therefore stops a crypto-order row referencing an account id that does
// not exist. The database will not catch a typo'd id, a row written for an
// account that was never created, or a row that outlives its account. Every
// other account-scoped table gets that check for free.
//
// WHAT THIS IS NOT ABOUT, because the obvious reading is wrong and I had it
// wrong first. This is NOT an erasure gap. `deleteAccount` is a SOFT delete: it
// sets `accounts.status = 'deleted'` and `deleted_at`, and the retention sweeper
// then clears the BYOK key. The account ROW is never hard-deleted, so the
// `onDelete: 'cascade'` foreign keys on the other thirty tables never fire
// either. Cascade-based erasure is not the mechanism here — the internal
// retention audit says so in as many words — so a missing cascade neither
// removes nor preserves customer data. The gap is referential integrity, which
// is a smaller claim and the true one.
//
// Whether crypto orders SHOULD outlive their account is a real question with a
// real answer somewhere in tax and chargeback obligations, and it is not one a
// test should decide. What a test can do is make the decision visible. Today the
// table is simply missing a constraint its thirty siblings have, with nothing
// recording whether that was chosen or overlooked — and an exemption nobody
// wrote down is indistinguishable from an oversight.
//
// So `crypto_orders` sits in an explicit roster below, stating exactly what is
// known and what is not. A new account-scoped table must either declare the key
// or join that roster, which is a one-line deliberate edit rather than a silent
// omission.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(HERE, '..', '..', 'src', 'db', 'schema.ts');

/**
 * Account-scoped tables deliberately WITHOUT a foreign key to `accounts`, each
 * with the reason it is exempt. An empty reason is not allowed — the point of
 * the roster is that the decision is written down.
 */
const NO_FOREIGN_KEY_BY_DECISION: Record<string, string> = {
  crypto_orders:
    'Payment records. No FK is declared in the schema or any migration, and no ' +
    'document records whether that was a retention decision (tax / chargeback ' +
    'windows commonly outlive an account) or an omission. Listed here so the ' +
    'question is visible rather than invisible; if it was deliberate, replace ' +
    'this note with the obligation it serves, and if it was not, add the key.',
};

interface TableInfo {
  name: string;
  accountScoped: boolean;
  declaresForeignKey: boolean;
}

/** How many tables the schema declares, independent of the parse below. */
function declarationCount(): number {
  return [...readFileSync(SCHEMA, 'utf8').matchAll(/=\s*pgTable\(/g)].length;
}

/** Every pgTable in the schema, with whether it is account-scoped and keyed. */
function tables(): TableInfo[] {
  const lines = readFileSync(SCHEMA, 'utf8').split('\n');
  const starts: { line: number; ident: string }[] = [];
  lines.forEach((l, i) => {
    // V-970 — BOTH declaration forms. The anchored `pgTable($` shape misses a
    // table declared on one line, `export const x = pgTable('x', {`, and three of
    // the schema's tables are written that way — pricing, platform_secrets and
    // account_mfa. All three are compliant today (account_mfa is account-scoped
    // and does declare its key), so this was a latent hole rather than a live one:
    // a NEW account-scoped table written single-line without a foreign key simply
    // would not have entered the population this guard checks.
    const m = /^export const (\w+) = pgTable\(/.exec(l);
    if (m) starts.push({ line: i, ident: m[1]! });
  });

  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]!.line : lines.length;
    const body = lines.slice(start.line, end).join('\n');
    // The table's wire name follows the paren on either the same line or the next.
    const named = /pgTable\(\s*'([a-z0-9_]+)'/.exec(body);
    const accountScoped = body.includes("'account_id'");
    // Look only at the account_id column's own declaration, so a `.references()`
    // on some other column (api_key_id, profile_id) cannot stand in for it.
    let declaresForeignKey = false;
    if (accountScoped) {
      const at = body.indexOf("'account_id'");
      const segment = body.slice(at, at + 400);
      declaresForeignKey = segment.includes('.references(');
    }
    return { name: named?.[1] ?? start.ident, accountScoped, declaresForeignKey };
  });
}

describe('every account-scoped table declares its foreign key', () => {
  it('CRITICAL the schema was parsed into a plausible set of tables. The assertions below are "none of these is unkeyed", and a parser that matched nothing has none unkeyed — it would report every table correctly keyed having read no table at all. An earlier version of this scan found THREE tables in a 49-table schema and would have passed exactly that way.', () => {
    const all = tables();
    const scoped = all.filter((t) => t.accountScoped);

    // V-970 — compared against an independent count rather than floored. The floor
    // this replaces was 45 against 49 parsed, so losing three tables to a
    // declaration shape the regex did not know cleared it comfortably — which is
    // what happened. A floor detects a scan that matches NOTHING; it cannot detect
    // one that matches most things.
    expect(all.length, 'every pgTable declaration is parsed').toBe(declarationCount());
    expect(all.length, 'pgTable declarations parsed').toBeGreaterThanOrEqual(50);
    expect(scoped.length, 'tables carrying an account_id').toBeGreaterThanOrEqual(30);
    expect(
      all.some((t) => t.name === 'accounts'),
      'and the accounts table itself was seen',
    ).toBe(true);
  });

  it('CRITICAL every account-scoped table declares a foreign key, or is listed with a reason. Without one the database cannot reject a row pointing at an account that does not exist — a typo, a row written for an account never created, or one that outlives its account are all accepted silently.', () => {
    const unkeyed = tables()
      .filter((t) => t.accountScoped && !t.declaresForeignKey)
      .map((t) => t.name)
      .filter((name) => !(name in NO_FOREIGN_KEY_BY_DECISION))
      .sort();
    expect(unkeyed, 'account-scoped table(s) with no foreign key and no stated reason:').toEqual(
      [],
    );
  });

  it('CRITICAL every roster entry still describes a real unkeyed table. An exemption that outlives the thing it exempts is where the next unkeyed table lands quietly — and if crypto_orders gains its key, this fails and says to delete the entry rather than leaving a note that reads as current.', () => {
    const unkeyed = new Set(
      tables()
        .filter((t) => t.accountScoped && !t.declaresForeignKey)
        .map((t) => t.name),
    );
    const stale = Object.keys(NO_FOREIGN_KEY_BY_DECISION)
      .filter((name) => !unkeyed.has(name))
      .sort();
    expect(stale, 'roster entr(ies) for a table that is now keyed or gone:').toEqual([]);
  });

  it('CRITICAL every roster entry carries an actual reason. A roster whose entries say nothing is a list of exemptions, which is the state this replaces — the value is in the sentence, not the membership.', () => {
    const empty = Object.entries(NO_FOREIGN_KEY_BY_DECISION)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([name]) => name)
      .sort();
    expect(empty, 'roster entr(ies) with no substantive reason:').toEqual([]);
  });
});

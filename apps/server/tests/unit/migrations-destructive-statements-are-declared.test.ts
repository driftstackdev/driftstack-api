// A migration that destroys data must be a deliberate, named decision.
//
// Drizzle migrations run automatically on deploy. A `DROP TABLE`, a dropped
// column, or an unscoped `DELETE FROM` that reaches production is not a bug you
// roll back — the rows are gone. Nothing in this repo asserted anything about
// the content of a migration, so such a statement would have shipped with the
// same review weight as an added index.
//
// Measured across all 112 migrations before writing this: zero `DROP TABLE`,
// one dropped column, one `DELETE FROM`, and both were read and are correct.
//   * 0065 drops the two trial_pack columns, retiring a product the free tier
//     replaced on 2026-05-27.
//   * 0104 collapses duplicate PENDING team invites to the newest row before
//     installing a partial unique index. It is scoped by
//     (owner_account_id, invitee_email), restricted to `accepted_at IS NULL`,
//     and keeps the newest by created_at — accepted invite history is untouched.
//
// So this guard does not report a problem. It fixes the state where the NEXT
// one arrives unannounced: the roster below is exact, so a new destructive
// migration fails until somebody writes down what it destroys and why.
//
// Comments are stripped before matching, and that is not defensive
// housekeeping: 0058 contains the word "truncated" in prose describing a 5-min
// time bucket, and a naive scan reports it as a TRUNCATE.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const MIGRATIONS = resolve(REPO, 'apps/server/src/db/migrations');

/**
 * Statements that remove data or the ability to read it.
 *
 * `ALTER COLUMN … TYPE` and `DROP CONSTRAINT` are deliberately absent: they can
 * lose data but usually do not, and a roster that fires on routine schema work
 * gets entries added without thought, which is how an exact list stops meaning
 * anything.
 */
const DESTRUCTIVE = [
  { name: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { name: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  { name: 'TRUNCATE', re: /\bTRUNCATE\b/i },
  { name: 'DELETE FROM', re: /\bDELETE\s+FROM\b/i },
];

/**
 * Migrations that destroy data, and the reason each is allowed to.
 *
 * Exact, so it fails in both directions: a new destructive migration is not in
 * it, and an entry whose file stopped being destructive no longer describes
 * anything. The second matters as much as the first — an entry that exempts
 * nothing reads as reviewed, and is what lets a real one be added beside it.
 */
const DECLARED: Record<string, string> = {
  '0065_retire_trial_pack_free_tier.sql':
    'Drops accounts.trial_pack_purchased_at and trial_pack_credit_cents. The ' +
    'trial pack was retired on 2026-05-27 and replaced by the perpetual free ' +
    'tier; the columns hold no live product state.',
  '0104_team_invites_pending_unique.sql':
    'Collapses duplicate PENDING team invites to the newest row before adding a ' +
    'partial unique index. Scoped by (owner_account_id, invitee_email) and ' +
    'restricted to accepted_at IS NULL, so accepted invite history is untouched.',
};

/** SQL with comments removed, so prose about "truncated" buckets is not a hit. */
function statementsOf(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** The destructive statement kinds present in a migration's real SQL. */
function destructiveKinds(sql: string): string[] {
  const body = statementsOf(sql);
  return DESTRUCTIVE.filter(({ re }) => re.test(body)).map(({ name }) => name);
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('every destructive migration is declared', () => {
  it('CRITICAL the scan found the migrations and the detector still fires. Both assertions below report an absence, so an empty directory or a matcher that stopped matching satisfies them having inspected nothing — and this guard is the only thing reading the CONTENT of a migration at all.', () => {
    const files = migrationFiles();
    expect(files.length, 'migration files found').toBeGreaterThan(100);

    expect(destructiveKinds('ALTER TABLE "accounts" DROP COLUMN "x";'), 'a dropped column').toEqual(
      ['DROP COLUMN'],
    );
    expect(destructiveKinds('DROP TABLE "sessions";'), 'a dropped table').toEqual(['DROP TABLE']);
    expect(destructiveKinds('DELETE FROM team_invites WHERE id = 1;'), 'a delete').toEqual([
      'DELETE FROM',
    ]);
    expect(
      destructiveKinds('CREATE INDEX "x" ON "y" ("z");'),
      'while ordinary schema work is not reported',
    ).toEqual([]);
    // The false positive this strip exists for: 0058 says "truncated to a
    // 5-min bucket" in prose.
    expect(
      destructiveKinds('-- rows are truncated to a 5-min bucket\nCREATE TABLE "a" ("b" text);'),
      'and neither is a comment that merely says truncated',
    ).toEqual([]);
  });

  it('CRITICAL no migration destroys data without a written reason. These run automatically on deploy, so a DROP TABLE or an unscoped DELETE that reaches production is not something to roll back — the rows are gone.', () => {
    const undeclared = migrationFiles()
      .map((f) => ({
        file: f,
        kinds: destructiveKinds(readFileSync(resolve(MIGRATIONS, f), 'utf8')),
      }))
      .filter(({ file, kinds }) => kinds.length > 0 && DECLARED[file] === undefined)
      .map(({ file, kinds }) => `${file}: ${kinds.join(', ')}`);
    expect(
      undeclared,
      'migration(s) that destroy data with no entry declaring what and why:',
    ).toEqual([]);
  });

  it('CRITICAL every declaration still describes a real destructive migration. An entry for a file that no longer exists, or that no longer destroys anything, exempts nothing and reads as reviewed.', () => {
    const present = new Set(migrationFiles());
    const stale = Object.keys(DECLARED).filter(
      (f) =>
        !present.has(f) ||
        destructiveKinds(readFileSync(resolve(MIGRATIONS, f), 'utf8')).length === 0,
    );
    expect(stale, 'declaration(s) that no longer describe a destructive migration:').toEqual([]);
  });
});

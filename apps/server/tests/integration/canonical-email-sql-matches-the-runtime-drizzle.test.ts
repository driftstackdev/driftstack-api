// The canonical-email rule exists twice, in two languages, and nothing checked
// that the two agree.
//
// `canonicalizeEmailForDedup` (services/auth-flows.ts) is what every runtime
// path computes: signup's dedup pre-check, and `findAccountByEmailOrCanonical`
// behind login, requestPasswordReset, requestMagicLink and
// resendSignupVerification. The same column was populated for pre-existing
// accounts by hand-written SQL, across two migrations, and the first of them
// did not match the runtime.
//
// 0096 stripped `+tag` for EVERY domain. The runtime deliberately does not:
// subaddressing is provider-controlled, so `foo+tag@example.com` may be a
// different mailbox from `foo@example.com`, and the runtime's own comment names
// the consequence — "an anonymous recovery request resolve one account through
// canonical_email while naming a different mailbox". 0102 corrected it on
// 2026-07-13 by expanding every non-Gmail row back to its literal address.
//
// So the invariant worth holding is not about either file alone: it is that the
// END STATE the shipped migrations produce equals what the runtime computes.
// This composes the two expressions, read out of the migration files rather
// than restated here, runs them against a real Postgres, and compares case by
// case. A restated copy would drift from the migrations exactly the way 0096
// drifted from the runtime.
//
// Verified while writing this: with both migrations applied there is no
// residual divergence, including the shapes 0096 got wrong —
// foo+tag@example.com, foo.bar+x@example.com, a@b@example.com and an address
// with no '@' at all.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalizeEmailForDedup } from '../../src/services/auth-flows.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');
const BACKFILL_0096 = resolve(MIGRATIONS_DIR, '0096_accounts_canonical_email.sql');
const CORRECTION_0102 = resolve(MIGRATIONS_DIR, '0102_accounts_canonical_email_provider_scope.sql');

let sql: ReturnType<typeof postgres> | null = null;
let dbReachable = false;

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
  } catch {
    /* local dev without a database */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) sql = postgres(DB_URL, { max: 1 });
});

afterAll(async () => {
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

/**
 * The end state the two shipped migrations leave a row in: 0096's CASE, then
 * 0102's conditional overwrite for non-Gmail domains. Both expressions are read
 * from the migration files, so this cannot drift from what actually ran.
 */
function shippedEndStateSql(): string {
  const first = /SET "canonical_email" =\s*([\s\S]*?)\nWHERE/.exec(
    readFileSync(BACKFILL_0096, 'utf8'),
  );
  expect(first, '0096 canonical expression not found').not.toBeNull();
  const second = /SET "canonical_email" = (lower\("email"\))\nWHERE ([\s\S]*?);/.exec(
    readFileSync(CORRECTION_0102, 'utf8'),
  );
  expect(second, '0102 correction expression not found').not.toBeNull();
  const applied0096 = (first?.[1] ?? '').trim();
  const overwrite = second?.[1] ?? '';
  // 0102's WHERE, minus the idempotence clause, is the condition under which
  // the overwrite applies.
  const condition = (second?.[2] ?? '').split('AND "canonical_email"')[0]!.trim();
  return `CASE WHEN ${condition} THEN ${overwrite} ELSE ${applied0096} END`;
}

/**
 * Cases chosen so a rule that merely looks reasonable still fails: the first
 * four are exactly where 0096 diverged, and the rest keep the Gmail behaviour
 * honest so "return the input unchanged" cannot pass.
 *
 * All lowercase, because that is the only state a stored email can be in: every
 * creation path lowercases before writing (signup does
 * `args.email.trim().toLowerCase()`), which is why 0102 describes its own
 * `lower()` as defensive parity. Feeding a mixed-case address here would test a
 * row the system cannot produce — the migrations would fold it and the runtime
 * would not, and the "divergence" would be an artifact of the fixture. The
 * precondition is asserted below rather than left implicit.
 */
const CASES = [
  'foo+tag@example.com',
  'foo.bar+x@example.com',
  'a@b@example.com',
  'no-at-sign',
  'user+1@gmail.com',
  'u.s.e.r@gmail.com',
  'a.b.c+d+e@gmail.com',
  'x+y@googlemail.com',
  'plain@example.com',
  'trailing@',
] as const;

describe('the canonical-email SQL computes what the runtime computes', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — this arm asserts nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL every case agrees between the shipped SQL and canonicalizeEmailForDedup', async () => {
    if (!dbReachable || !sql) return;
    const expression = shippedEndStateSql();
    const disagreements: string[] = [];
    for (const email of CASES) {
      // 0096 writes the column unquoted, 0102 quotes it — substitute both, and
      // never the `canonical_email` that shares the suffix.
      const parameterised = expression
        .replaceAll('"email"', '$1')
        .replace(/(?<![_a-zA-Z"])email\b/g, '$1');
      const [row] = await sql.unsafe<{ canonical: string }[]>(
        `SELECT ${parameterised} AS canonical`,
        [email],
      );
      const fromSql = row?.canonical ?? null;
      const fromRuntime = canonicalizeEmailForDedup(email);
      if (fromSql !== fromRuntime) {
        disagreements.push(`${email}: SQL ${String(fromSql)} vs runtime ${fromRuntime}`);
      }
    }
    expect(
      disagreements,
      'the shipped migrations and the runtime disagree about an account’s canonical email. Rows ' +
        'written by a migration and rows written at signup would then be canonicalised ' +
        'differently, so the ' +
        'dedup pre-check blocks signups it should allow and anonymous recovery resolves accounts ' +
        'by an address their owner never registered',
    ).toEqual([]);
  });

  // Deliberately not async and not gated on the database: it checks the case
  // table and the runtime function only, so it must still fail on a machine
  // with no Postgres rather than quietly skipping.
  it('CRITICAL the case table still contains the shapes that actually diverged', () => {
    // Without this the table could be trimmed to cases every rule agrees on,
    // leaving a green that proves nothing. These are where 0096 was wrong.
    for (const email of ['foo+tag@example.com', 'a@b@example.com', 'no-at-sign']) {
      expect(CASES).toContain(email);
    }
    // And the runtime must still be doing the thing that made them diverge:
    // keeping a non-Gmail local part literal while stripping it for Gmail.
    expect(canonicalizeEmailForDedup('foo+tag@example.com')).toBe('foo+tag@example.com');
    expect(canonicalizeEmailForDedup('foo+tag@gmail.com')).toBe('foo@gmail.com');
  });

  it('CRITICAL the lowercase precondition the comparison rests on still holds', () => {
    // The migrations fold case and the runtime does not, so the two only have to
    // agree on lowercase input. That is safe exactly while every creation path
    // lowercases first — if signup stopped, stored emails could carry uppercase
    // and the pair WOULD diverge on real rows, silently, because the case table
    // above is all lowercase and could not see it.
    const signup = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/services/auth-flows.ts'),
      'utf8',
    );
    // Scoped to signup's own body. A bare toContain passes on this file whatever
    // signup does, because four other methods lowercase too — which is exactly
    // how the first version of this arm failed to notice signup being mutated.
    const body = /async signup\(args: SignupArgs\)[\s\S]{0,600}/.exec(signup)?.[0] ?? '';
    expect(body, 'the signup method could not be located, so this arm checked nothing').not.toBe(
      '',
    );
    expect(
      body,
      'signup no longer lowercases the address before storing it, so stored emails can carry ' +
        'uppercase — the migrations fold case and the runtime does not, and the all-lowercase ' +
        'case table above cannot see the resulting divergence',
    ).toContain('args.email.trim().toLowerCase()');
  });
});

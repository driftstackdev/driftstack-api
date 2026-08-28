// `findAccountByCanonicalEmail` is the free-tier abuse control, and its SQL had
// never run.
//
// It was the one method the auth-flows census came back missing. Signup calls it
// UNCONDITIONALLY before creating an account, and login / resend-verification /
// magic-link / password-reset call it through `findAccountByEmailOrCanonical`, so
// it sits on five customer-facing flows and its query had been exercised only
// against an in-memory double.
//
// What it defends. `attacker+1@gmail.com`, `att.acker@gmail.com` and
// `attacker@gmail.com` are ONE Gmail inbox. Without the canonical pre-check, one
// mailbox mints unlimited "distinct" free-tier accounts. The service comment is
// explicit that the lookup must hit `accounts.canonical_email` rather than the
// literal `email` column, because the realistic abuse ordering registers a
// VARIANT first — and a variant is its own canonical form, so a literal-column
// lookup against it never matches the bare address that follows.
//
// Two halves make that work, and they live in different methods:
//
//   createAccount WRITES the canonical form at creation time.
//   findAccountByCanonicalEmail READS it back.
//
// Either half failing silently reopens the gap with every in-memory test still
// green — the double stores whatever it is handed and answers from the same map,
// so it cannot disagree with itself. Only Postgres can, which is what these arms
// ask it.
//
// The `accounts_canonical_email_unique` index is asserted too, as the backstop
// under the pre-check: the service comment calls the lookup "an ADDITIONAL,
// STRICTER pre-check ahead of the DB constraint", which is only true while the
// constraint exists.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import { canonicalizeEmailForDedup } from '../../src/services/auth-flows.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAuthFlowsRepo | null = null;
let dbReachable = false;
const seededEmails: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  sql = postgres(DB_URL, { max: 2 });
  try {
    await sql`SELECT canonical_email FROM accounts LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleAuthFlowsRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seededEmails.length > 0) {
    await sql`DELETE FROM accounts WHERE email = ANY(${sql.array(seededEmails)})`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

/** A gmail address whose local part is unique to this run, so arms cannot collide. */
function gmailVariant(shape: (unique: string) => string): string {
  const unique = `ds${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const email = `${shape(unique)}@gmail.com`;
  seededEmails.push(email);
  return email;
}

async function createAccount(email: string): Promise<void> {
  await repo!.createAccount({
    email,
    name: null,
    passwordHash: 'x'.repeat(32),
    initialTier: 'free',
  });
}

describe('canonical-email dedup is enforced by the database, not just the double', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database". Every arm is a SQL round-trip; without a connection they would skip and this file would report success on the control that stops one mailbox minting unlimited free accounts.', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL createAccount persists the canonical form, and findAccountByCanonicalEmail finds the account through it. Two methods, two halves of one control: the write puts the canonical form in the column, the read looks the column up. An in-memory double answers from the map it was handed and so can never disagree with itself — only a real column can be the wrong column.', async () => {
    if (!dbReachable) return;
    const registered = gmailVariant((u) => `${u}+tag`);
    await createAccount(registered);

    const canonical = canonicalizeEmailForDedup(registered);
    expect(canonical, 'the canonicaliser did not strip the +tag').not.toBe(registered);

    const found = await repo!.findAccountByCanonicalEmail(canonical);
    expect(found, 'the account did not resolve through its canonical form').not.toBeNull();
    expect(found?.email, 'the canonical lookup resolved to a different account').toBe(registered);
  });

  it('CRITICAL a DOT variant of a registered gmail address resolves to the same account. This is the abuse ordering the service comment calls realistic: the variant registers FIRST, and a variant is its own canonical form, so a lookup against the literal email column never matches the address that follows. Here the second address is never registered at all — the pre-check has to recognise it from the first one alone.', async () => {
    if (!dbReachable) return;
    // Registered with dots; the attacker then tries the dotless form.
    const registered = gmailVariant((u) => `${u.slice(0, 8)}.${u.slice(8)}`);
    await createAccount(registered);

    const attempted = registered.replace(/\./g, '').replace('@gmailcom', '@gmail.com');
    expect(attempted, 'the fixture produced the same string twice').not.toBe(registered);

    const found = await repo!.findAccountByCanonicalEmail(canonicalizeEmailForDedup(attempted));
    expect(
      found?.email,
      'a dot-variant of a registered gmail address did not resolve — one mailbox could mint a second free account',
    ).toBe(registered);
  });

  it('a NON-gmail address is not canonicalised, so two different addresses at the same domain stay two accounts. The control must not over-match: dots and +tags are only equivalent on gmail, and folding them everywhere would merge unrelated customers at every other provider.', async () => {
    if (!dbReachable) return;
    const unique = `ds${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const first = `${unique}.a@example.com`;
    const second = `${unique}a@example.com`;
    seededEmails.push(first, second);
    await createAccount(first);

    expect(
      await repo!.findAccountByCanonicalEmail(canonicalizeEmailForDedup(second)),
      'a non-gmail dot variant matched an unrelated account',
    ).toBeNull();
  });

  it('CRITICAL the accounts_canonical_email_unique index exists. The service documents its lookup as "an ADDITIONAL, STRICTER pre-check ahead of the DB constraint" — which is only true while the constraint is there. Without it the pre-check is the ONLY thing standing between two concurrent signups from one mailbox, and a pre-check is not race-free.', async () => {
    if (!dbReachable) return;
    const [row] = await sql!<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'accounts' AND indexname = 'accounts_canonical_email_unique'`;
    expect(row?.indexdef, 'the canonical-email unique index is gone').toBeTruthy();
    expect(row?.indexdef, 'the index is no longer UNIQUE').toMatch(/CREATE UNIQUE INDEX/);
    expect(row?.indexdef, 'the index no longer covers canonical_email').toMatch(/canonical_email/);
  });

  it('CRITICAL markEmailVerified is a FIRST-TRANSITION claim and POSTGRES enforces it, not just the source. Four content-parity and cross-source pins already assert the body says and(eq(id), isNull(emailVerifiedAt)) — but a text pin is reading, mechanised: it catches an edit to the source, never the database disagreeing with what the source assumes. The boolean gates the one-time signup-welcome email, so a guard that stopped biting sends one per outstanding verify token. This is the first test to run that SQL at all.', async () => {
    if (!dbReachable) return;
    const email = `ds${randomUUID().replace(/-/g, '').slice(0, 16)}@example.com`;
    seededEmails.push(email);
    const account = await repo!.createAccount({
      email,
      name: null,
      passwordHash: 'x'.repeat(32),
      initialTier: 'free',
    });
    // Positive control: without it the first assertion could pass on a fixture
    // that was already verified, proving nothing about the transition.
    expect(account.emailVerifiedAt, 'a fresh account must start unverified').toBeNull();

    const firstAt = new Date('2026-01-01T00:00:00.000Z');
    const secondAt = new Date('2026-02-02T00:00:00.000Z');
    expect(
      await repo!.markEmailVerified(account.id, firstAt),
      'the first verification must claim the null -> verified transition',
    ).toBe(true);
    expect(
      await repo!.markEmailVerified(account.id, secondAt),
      'a second verification must LOSE - otherwise every outstanding token fires a welcome email',
    ).toBe(false);

    // The booleans alone cannot separate a working isNull guard from a broken
    // one that returns true twice AND moves the timestamp. Read the row back.
    const [row] = await sql!<{ email_verified_at: Date }[]>`
      SELECT email_verified_at FROM accounts WHERE id = ${account.id}`;
    expect(row?.email_verified_at, 'the account was not verified at all').toBeTruthy();
    expect(
      new Date(row!.email_verified_at).toISOString(),
      'the losing call overwrote the winner timestamp - the isNull guard is not biting',
    ).toBe(firstAt.toISOString());
  });
});

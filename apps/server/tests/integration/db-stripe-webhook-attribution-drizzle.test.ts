// The query that decides WHICH account a Stripe payment lands on, run against a
// real Postgres for the first time.
//
// `findAccountIdFromCustomerOrRef` is called three times in `stripe-webhooks.ts` —
// it is how an incoming webhook is attributed to a Driftstack account — and
// `getAccountTier` twice, as the not-null filler that keeps a mirror write from
// moving the account's tier. Both were reachable in tests only through the
// in-memory double, which compares strings in a Map and cannot disagree with
// Postgres about anything.
//
// ── the live branch ────────────────────────────────────────────────────────
//
// Every call site today passes `clientReferenceId: null`, so attribution runs
// entirely on `accounts.stripe_customer_id`. That column is `text`, the lookup is
// an equality, and the arms below drive found / not-found / null-input against the
// real table.
//
// ── the branch that is not wired, and is a trap ────────────────────────────
//
// The other branch does `eq(accounts.id, clientReferenceId)`, and `accounts.id` is
// `uuid`. Postgres does not coerce — it raises `22P02 invalid input syntax for type
// uuid` — while the in-memory double compares two strings and quietly returns null.
// So the two implementations disagree about a whole class of input, and only one of
// them is what production runs.
//
// ⚠️ Stated precisely, because the first read of this was wrong and the difference
// matters: this is NOT a live defect. All five call sites pass null, so the branch
// is unreachable today. What it is, is loaded — `lib/stripe-api.ts` DOES set
// `client_reference_id` on every checkout session it creates, so the field is
// populated in Stripe and waiting. The day someone threads it through, a value that
// is not a bare UUID throws inside a webhook handler, which means a 500, a Stripe
// retry, and a payment that never attributes.
//
// The arm below asserts the throw rather than pretending it away. That is the honest
// shape while the branch is unwired: it documents the precondition where whoever
// wires it will run into it, and it fails the day the behaviour changes — including
// if someone adds the UUID validation that would make `null` the right answer, at
// which point this arm should be rewritten to expect null and the change is a
// decision rather than a surprise.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import { InMemoryStripeWebhooksRepo } from './_helpers/in-memory-stripe-webhooks-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleStripeWebhooksRepo | null = null;
let dbReachable = false;
const seededAccounts: string[] = [];

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
    await sql`SELECT stripe_customer_id FROM accounts LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleStripeWebhooksRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seededAccounts.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seededAccounts)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedAccount(
  opts: { stripeCustomerId?: string; tier?: string } = {},
): Promise<string> {
  const accountId = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status, tier, stripe_customer_id)
    VALUES (${accountId}, ${`stripe-attr-${accountId}@test.local`}, 'active',
            ${opts.tier ?? 'free'}::account_tier, ${opts.stripeCustomerId ?? null})`;
  seededAccounts.push(accountId);
  return accountId;
}

describe('stripe webhook attribution, against the database it actually queries', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database". Every arm is a SQL round-trip against the query that decides whose account a payment lands on.', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a stripe customer id resolves to the account that carries it. This is the LIVE branch — all five call sites pass clientReferenceId null, so every real attribution runs through this lookup, and it had only ever been exercised against a Map.', async () => {
    if (!dbReachable) return;
    const customerId = `cus_${randomUUID().replace(/-/g, '')}`;
    const accountId = await seedAccount({ stripeCustomerId: customerId });

    const found = await repo!.findAccountIdFromCustomerOrRef({
      stripeCustomerId: customerId,
      clientReferenceId: null,
    });
    expect(found, 'a known stripe customer did not resolve to its account').toBe(accountId);
  });

  it('CRITICAL an UNKNOWN stripe customer resolves to null rather than to somebody. A lookup that fell back to a first row would attribute a stranger’s payment to a real customer, and the failure would look like a successful charge on both sides.', async () => {
    if (!dbReachable) return;
    // Seed a real account so the table is not empty — a null from an empty table
    // proves nothing about the predicate.
    await seedAccount({ stripeCustomerId: `cus_${randomUUID().replace(/-/g, '')}` });

    expect(
      await repo!.findAccountIdFromCustomerOrRef({
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '')}`,
        clientReferenceId: null,
      }),
      'an unknown stripe customer resolved to an account',
    ).toBeNull();
  });

  it('both inputs null resolves to null without touching the table. The handlers call this before they know whether the payload carried anything identifying, so the no-information case has to be a clean null rather than a first row.', async () => {
    if (!dbReachable) return;
    await seedAccount({ stripeCustomerId: `cus_${randomUUID().replace(/-/g, '')}` });
    expect(
      await repo!.findAccountIdFromCustomerOrRef({
        stripeCustomerId: null,
        clientReferenceId: null,
      }),
      'a payload with nothing identifying resolved to an account',
    ).toBeNull();
  });

  it('a client_reference_id that IS a real account uuid resolves, and takes precedence over the customer id. The branch is unwired today, but its ordering is the contract: the explicit reference wins over the customer mapping, which is what makes it usable to correct a mis-mapped customer.', async () => {
    if (!dbReachable) return;
    const customerId = `cus_${randomUUID().replace(/-/g, '')}`;
    const viaCustomer = await seedAccount({ stripeCustomerId: customerId });
    const viaReference = await seedAccount();

    const found = await repo!.findAccountIdFromCustomerOrRef({
      stripeCustomerId: customerId,
      clientReferenceId: viaReference,
    });
    expect(found, 'the client reference did not take precedence over the customer id').toBe(
      viaReference,
    );
    expect(found, 'the customer-id branch won when a reference was supplied').not.toBe(viaCustomer);
  });

  it('CRITICAL a NON-UUID client_reference_id THROWS against Postgres, where the in-memory double returns null. accounts.id is uuid and Postgres does not coerce — it raises 22P02. The branch is unreachable today (all five call sites pass null), so this is a loaded trap rather than a live defect: stripe-api.ts already sets client_reference_id on every checkout session, so the value exists in Stripe and waits. Whoever threads it through gets a throw inside a webhook handler, which is a 500, a Stripe retry, and a payment that never attributes. Asserted rather than pretended away — and if UUID validation is ever added, this arm fails and gets rewritten to expect null, which makes that a decision instead of a surprise.', async () => {
    if (!dbReachable) return;
    const thrown = await repo!
      .findAccountIdFromCustomerOrRef({
        stripeCustomerId: null,
        // The shape Stripe hands back from a Payment Link or a legacy session.
        clientReferenceId: 'cs_test_not_a_uuid',
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(
      thrown,
      'a non-uuid client_reference_id no longer throws — if validation was added, expect null here instead',
    ).toBeInstanceOf(Error);
    // Pin the SQLSTATE, not the message. Drizzle wraps the driver error, so the
    // text is "Failed query: …" and the real diagnosis is on `cause`; the message
    // itself also varies with server locale and version, which a regex would make
    // this arm depend on for no benefit.
    const cause = (thrown as { cause?: { code?: string } }).cause;
    expect(cause?.code, 'the rejection was not the uuid cast error (22P02)').toBe('22P02');
  });

  it('CRITICAL getAccountTier reads the tier the account actually holds. It is the not-null filler for a mirror write whose own log line claims "written without tier change" — a filler that read the wrong row, or defaulted, would move a paying customer’s tier through the rank recompute while reporting that it changed nothing.', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount({ tier: 'api_builder' });
    expect(await repo!.getAccountTier(accountId), 'the stored tier did not read back').toBe(
      'api_builder',
    );
    expect(
      await repo!.getAccountTier(randomUUID()),
      'an account that does not exist reported a tier',
    ).toBeNull();
  });
});

// V-1277 — the OTHER half of the disagreement this file documents.
//
// The header above states that the double "compares two strings and quietly returns null" where
// Postgres raises 22P02, and the arm above pins the Postgres side. Nothing pinned the double's
// side, so the sentence was prose: someone making the double throw — a reasonable thing to attempt
// in the name of fidelity — would have broken the agreement this file describes without failing
// anything, and the description would have gone quietly wrong.
//
// This is the shape V-1276 was written about. An invariant asserted on ONE implementation is not a
// parity assertion, and a documented DISAGREEMENT needs both halves pinned for the same reason an
// agreement does: the file is only trustworthy if a change to either side has to come here first.
//
// Ungated on purpose. Every arm above early-returns without a database, so a local run proves
// nothing about attribution; these two need no database at all and always run.
describe('stripe webhook attribution, the in-memory double on the same inputs', () => {
  it('CRITICAL the double resolves a stripe customer id the same way the database does. The two halves of this file are only comparable if the double is right about the LIVE branch — a fixture that disagreed here would make the disagreement pinned below look like the only one.', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    const accountId = randomUUID();
    repo.registerAccount({ accountId, stripeCustomerId: 'cus_double_live', tier: 'free' });

    expect(
      await repo.findAccountIdFromCustomerOrRef({
        stripeCustomerId: 'cus_double_live',
        clientReferenceId: null,
      }),
      'the double did not resolve a known stripe customer',
    ).toBe(accountId);
    expect(
      await repo.findAccountIdFromCustomerOrRef({
        stripeCustomerId: 'cus_nobody',
        clientReferenceId: null,
      }),
      'the double resolved an unknown stripe customer to somebody',
    ).toBeNull();
  });

  it('CRITICAL the double returns NULL for the non-uuid client_reference_id that makes Postgres raise 22P02. This is a DISAGREEMENT, pinned deliberately on both sides rather than repaired: the branch is unwired, and the honest record is that the two implementations answer differently until someone threads the field through. If validation is added so null becomes the right answer everywhere, the Drizzle arm above changes to expect null and this one stops being a divergence — a decision, made in one place, rather than a surprise found later.', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    repo.registerAccount({ accountId: randomUUID(), stripeCustomerId: 'cus_x', tier: 'free' });

    expect(
      await repo.findAccountIdFromCustomerOrRef({
        stripeCustomerId: null,
        // The same value the Drizzle arm above sends, so the two arms are about one input.
        clientReferenceId: 'cs_test_not_a_uuid',
      }),
      'the double no longer returns null — if it was taught to throw, the Drizzle arm above and ' +
        'this file\u2019s header both need rewriting in the same commit',
    ).toBeNull();
  });
});

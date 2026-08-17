// Binding a Driftstack account to its Stripe customer.
//
// v8 coverage: `getAccount`, `setStripeCustomerId` and `toAccount` execute zero
// statements, while the subscription lookups beside them are exercised. These
// are the smaller half of `billing-repo` and the arms below are correspondingly
// modest — but they sit on the money path, and the one that matters is scoping.
//
// `setStripeCustomerId` is an unconditional UPDATE keyed on the account id, and
// there is no unique index on `accounts.stripe_customer_id` to catch a mistake
// afterwards. If that WHERE ever matched more than the intended row, two
// Driftstack accounts would point at one Stripe customer and every invoice,
// subscription and refund after that is attributed to whichever account is read
// first. Nothing downstream would flag it: both accounts look correctly
// configured, and Stripe is perfectly happy to have two systems reference one
// customer.
//
// The read side gets a projection arm for the same reason the OAuth admin
// listing does — `toAccount` hand-picks five fields off the full `accounts` row,
// which carries password hashes, BYOK ciphertext and auth epochs. That snapshot
// is handed to the billing provider, so a spread here would take account
// internals along to Stripe.
//
// Not covered here, because it is already covered and I checked rather than
// assumed: the read-then-write race in `BillingService.ensureCustomerId` is
// defended by a Stripe idempotency key of `stripe-customer-create:<accountId>`,
// and `stripe-billing-provider.test.ts` asserts the actual header sent.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleBillingRepo } from '../../src/db/billing-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Exactly the fields the billing snapshot is written to carry. */
const SNAPSHOT_FIELDS = ['email', 'id', 'name', 'stripeCustomerId', 'tier'] as const;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleBillingRepo | null = null;
let dbReachable = false;
const seeded: string[] = [];

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
  repo = new DrizzleBillingRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seeded.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status, name)
    VALUES (${id}, ${`billing-${id}@test.local`}, 'active', 'Test Account')`;
  seeded.push(id);
  return id;
}

describe('billing account binding', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an account reads back with no Stripe customer until one is bound', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const snapshot = await repo.getAccount(accountId);
    expect(snapshot?.id).toBe(accountId);
    expect(snapshot?.name).toBe('Test Account');
    expect(
      snapshot?.stripeCustomerId,
      'a fresh account already claimed a Stripe customer — ensureCustomerId short-circuits on this ' +
        'being null, so it would never create one',
    ).toBeNull();
  });

  it('CRITICAL an unknown account reads as null', async () => {
    if (!dbReachable || !repo) return;
    expect(await repo.getAccount(randomUUID())).toBeNull();
  });

  it('CRITICAL the snapshot carries exactly the five billing fields', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const snapshot = await repo.getAccount(accountId);
    expect(
      Object.keys(snapshot ?? {}).sort(),
      'the billing snapshot grew a field. It is built by hand off the full accounts row — which ' +
        'holds password hashes, BYOK ciphertext and auth epochs — and is handed to the billing ' +
        'provider, so anything extra here travels to Stripe',
    ).toEqual([...SNAPSHOT_FIELDS]);
  });

  it('CRITICAL binding a Stripe customer is readable straight back', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const customerId = `cus_${randomUUID().slice(0, 12)}`;
    await repo.setStripeCustomerId({ accountId, customerId });
    expect(
      (await repo.getAccount(accountId))?.stripeCustomerId,
      'the Stripe customer id did not persist — every later call would mint another customer',
    ).toBe(customerId);
  });

  it('CRITICAL binding one account never rebinds another', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const theirCustomer = `cus_${randomUUID().slice(0, 12)}`;
    await repo.setStripeCustomerId({ accountId: theirs, customerId: theirCustomer });
    await repo.setStripeCustomerId({
      accountId: mine,
      customerId: `cus_${randomUUID().slice(0, 12)}`,
    });
    expect(
      (await repo.getAccount(theirs))?.stripeCustomerId,
      'binding one account’s Stripe customer overwrote another’s. There is no unique index on ' +
        'stripe_customer_id to catch it, so two accounts would share one customer and every ' +
        'invoice after that is attributed to whichever is read first',
    ).toBe(theirCustomer);
  });

  it('CRITICAL rebinding replaces the id rather than appending a second one', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await repo.setStripeCustomerId({ accountId, customerId: 'cus_first' });
    await repo.setStripeCustomerId({ accountId, customerId: 'cus_second' });
    expect((await repo.getAccount(accountId))?.stripeCustomerId).toBe('cus_second');
  });
});

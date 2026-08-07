// Three account-scoped reads that no test could see unscoped.
//
// Second pass of the ownership mutation sweep. Neutralising the single
// `eq(table.accountId, …)` predicate in each of `crypto-orders-repo.listAll`,
// `bundled-llm-repo.sumMonthlySpendCents` and `oauth-links-repo.listForAccount`
// — all three at once — left the FULL suite green: 2,565 files, 26,592 tests,
// zero failures.
//
// Each leaks something different, and one of them is not merely a disclosure:
//
//   listAll            → a customer's crypto payment history
//   listForAccount     → a customer's linked Google/GitHub identities and the
//                        provider email behind them
//   sumMonthlySpendCents → the bundled-LLM monthly spend total, which is what
//                        the budget check reads. Unscoped it sums EVERY
//                        account's spend, so the first customer to be checked
//                        after the platform crosses one customer's budget is
//                        refused for someone else's usage — and the refusal
//                        looks exactly like their own budget being exhausted.
//
// The reads are the whole boundary here: none of these three has a service-side
// account filter behind it, so unlike the agent-session and proxy repos there is
// no second line at all. `listAll` is the one exception worth noting — its
// `accountId` is OPTIONAL, because an admin view legitimately lists every order.
// That makes the predicate conditional, which is exactly the shape that hides a
// break: pass an accountId and get everything back, and nothing distinguishes it
// from the admin call that is supposed to.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { DrizzleCryptoOrdersRepo } from '../../src/db/crypto-orders-repo.js';
import { DrizzleBundledLlmRepo } from '../../src/db/bundled-llm-repo.js';
import { DrizzleOAuthLinksRepo } from '../../src/db/oauth-links-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const NOW = new Date('2026-08-15T12:00:00.000Z');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let orders: DrizzleCryptoOrdersRepo | null = null;
let bundled: DrizzleBundledLlmRepo | null = null;
let links: DrizzleOAuthLinksRepo | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM crypto_orders LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
  const db = drizzle(client, { schema });
  const handle = { client, db, close: async () => {} };
  orders = new DrizzleCryptoOrdersRepo(handle);
  bundled = new DrizzleBundledLlmRepo(handle);
  links = new DrizzleOAuthLinksRepo(handle);
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM crypto_orders WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM account_oauth_links WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM usage_records WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccount(): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seeded.push(accountId);
  await client`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`scoped-read-${accountId}@test.local`}, 'active')`;
  return accountId;
}

async function seedOrder(accountId: string): Promise<void> {
  if (!client) throw new Error('no client');
  await client`
    INSERT INTO crypto_orders (order_id, account_id, product, price_cents, price_currency, status)
    VALUES (${`ord_${randomUUID()}`}, ${accountId}, 'desktop_lifetime', 9900, 'usd', 'pending')`;
}

async function seedOauthLink(accountId: string): Promise<void> {
  if (!client) throw new Error('no client');
  await client`
    INSERT INTO account_oauth_links (id, account_id, provider, provider_sub, provider_email)
    VALUES (${randomUUID()}, ${accountId}, 'google', ${`sub-${randomUUID()}`}, 'linked@test.local')`;
}

async function seedBundledSpend(accountId: string, cents: number): Promise<void> {
  if (!client) throw new Error('no client');
  await client`
    INSERT INTO usage_records (id, account_id, record_type, quantity, recorded_at, metadata)
    VALUES (
      ${randomUUID()}, ${accountId}, 'agent_decomposer_bundled', 1,
      ${new Date(NOW.getTime() - 60_000).toISOString()}::timestamptz,
      ${JSON.stringify({ cost_usd_cents: cents, bundled: true })}::text::jsonb
    )`;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'account-scoped reads do not cross the account boundary',
  () => {
    it('CRITICAL the database is reachable. Every case is a SQL round-trip; if the connection failed they would skip and this file would report success while proving nothing about a cross-account read.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL the fixtures are real — each victim row IS visible to its true owner. Every check below is an absence, so without this arm a repo returning nothing to anybody would satisfy all of them.', async () => {
      const owner = await seedAccount();
      await seedOrder(owner);
      await seedOauthLink(owner);
      await seedBundledSpend(owner, 250);

      expect((await orders!.listAll({ accountId: owner })).length, 'owner sees its order').toBe(1);
      expect((await links!.listForAccount(owner)).length, 'owner sees its link').toBe(1);
      expect(
        await bundled!.sumMonthlySpendCents({ accountId: owner, now: NOW }),
        'owner sees its own spend',
      ).toBe(250);
    });

    it('CRITICAL crypto orders are not listed to another account. These rows are a customer’s payment history.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedOrder(victim);

      const visible = await orders!.listAll({ accountId: attacker });

      expect(visible, 'the attacker sees none of the victim’s orders').toEqual([]);
    });

    it('CRITICAL linked OAuth identities are not listed to another account. The rows carry the provider email behind a customer’s Google or GitHub login.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedOauthLink(victim);

      expect(await links!.listForAccount(attacker), 'the attacker sees no links').toEqual([]);
    });

    it('CRITICAL the bundled-LLM monthly spend sum is per account. This is not only a disclosure: the number feeds the budget check, so an unscoped sum totals every account and refuses one customer for another customer’s usage — indistinguishable, to them, from their own budget running out.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedBundledSpend(victim, 5_000);

      expect(
        await bundled!.sumMonthlySpendCents({ accountId: attacker, now: NOW }),
        'the attacker’s spend total excludes the victim’s',
      ).toBe(0);
    });

    it('CRITICAL an account with spend of its own sums ONLY its own. The zero-spend case above would still pass if the sum returned a constant 0, which would disable budget enforcement entirely.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedBundledSpend(victim, 5_000);
      await seedBundledSpend(attacker, 700);

      expect(
        await bundled!.sumMonthlySpendCents({ accountId: attacker, now: NOW }),
        'exactly its own spend, not the pair',
      ).toBe(700);
    });

    it('CRITICAL listAll WITHOUT an accountId still returns across accounts, so the scoping above is not achieved by breaking the admin view. The optional filter is what makes this repo easy to get wrong in either direction.', async () => {
      const owner = await seedAccount();
      await seedOrder(owner);

      const all = await orders!.listAll({ limit: 200 });

      expect(all.length, 'the unscoped admin listing still sees orders').toBeGreaterThan(0);
    });
  },
);

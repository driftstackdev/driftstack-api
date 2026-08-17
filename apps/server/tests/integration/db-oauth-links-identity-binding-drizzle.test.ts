// Which account a social login resolves to.
//
// v8 coverage: `db/oauth-links-repo.ts` has `findByProviderSub`, `insertLink`,
// `markLoginAt` and `markRevokedAt` at zero executed statements. The service
// above them is covered against a double; this SQL is not, and
// `findByProviderSub` is the single query that turns an identity provider's
// subject into a Driftstack account. Everything "sign in with Google" does
// downstream trusts its answer.
//
// Two things make that answer safe, and neither is a JavaScript decision:
//
//   composite lookup   the WHERE is `and(provider, providerSub)`. A subject is
//                      only unique WITHIN an issuer — Google and GitHub hand out
//                      identifiers from separate namespaces and nothing stops
//                      them colliding. Drop the provider term and a GitHub
//                      subject can resolve a Google link, which signs the caller
//                      into an account they do not own.
//   unique index       `account_oauth_links_provider_sub_idx` is UNIQUE on
//                      (provider, provider_sub), so one IDP identity can be
//                      claimed by exactly one account. Without it two rows can
//                      hold the same identity and this query — `.limit(1)` with
//                      no ORDER BY — resolves to whichever Postgres returns
//                      first. Account resolution would be non-deterministic,
//                      which is a worse failure than resolving wrongly, because
//                      it is not reproducible.
//
// Revocation is asserted as a LAYERING property rather than a filter. A revoked
// link must still RESOLVE — `linkOrCreateAccount` reads `lastRevokedAt` off the
// returned row and forks to 'existing-link-revoked' so the route can prompt a
// re-link. If this query started hiding revoked rows the service would instead
// fall through to its no-link path and, for a matching email, issue a pending
// merge. Making the query stricter would therefore change what the product does,
// which is exactly the kind of "obviously safer" edit worth pinning against.
//
// Against a real Postgres: a unique-index violation is the database's decision,
// and the composite lookup is the database's comparison.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleOAuthLinksRepo } from '../../src/db/oauth-links-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleOAuthLinksRepo | null = null;
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
    await sql`SELECT provider_sub FROM account_oauth_links LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleOAuthLinksRepo({ db: drizzle(sql) } as unknown as never);
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
    INSERT INTO accounts (id, email, status)
    VALUES (${id}, ${`oalink-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

const link = (accountId: string, provider: 'google' | 'github', providerSub: string) =>
  repo!.insertLink({
    accountId,
    provider,
    providerSub,
    providerEmail: `${providerSub}@idp.test.local`,
    providerName: 'Test User',
    providerAvatarUrl: null,
  });

describe('OAuth identity binding', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an identity resolves to the account that linked it', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const sub = `sub-${randomUUID()}`;
    const inserted = await link(accountId, 'google', sub);
    const found = await repo.findByProviderSub('google', sub);
    expect(found?.accountId, 'a linked identity did not resolve — social sign-in would fail').toBe(
      accountId,
    );
    expect(found?.id).toBe(inserted.id);
  });

  it('CRITICAL the same subject under a different provider does not resolve', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const sub = `sub-${randomUUID()}`;
    await link(mine, 'google', sub);
    expect(
      await repo.findByProviderSub('github', sub),
      'a subject from one identity provider resolved another provider’s link. Subjects are only ' +
        'unique WITHIN an issuer, so this signs the caller into an account they do not own',
    ).toBeNull();
  });

  it('CRITICAL two accounts cannot claim the same identity', async () => {
    if (!dbReachable || !repo) return;
    const first = await seedAccount();
    const second = await seedAccount();
    const sub = `sub-${randomUUID()}`;
    await link(first, 'google', sub);
    await expect(
      link(second, 'google', sub),
      'a second account claimed an identity another account already holds. findByProviderSub takes ' +
        'limit(1) with no ORDER BY, so which account a login resolves to would depend on row order',
    ).rejects.toThrow();
    expect((await repo.findByProviderSub('google', sub))?.accountId).toBe(first);
  });

  it('CRITICAL one account can link both providers independently', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const googleSub = `sub-${randomUUID()}`;
    const githubSub = `sub-${randomUUID()}`;
    await link(accountId, 'google', googleSub);
    await link(accountId, 'github', githubSub);
    expect((await repo.findByProviderSub('google', googleSub))?.accountId).toBe(accountId);
    expect((await repo.findByProviderSub('github', githubSub))?.accountId).toBe(accountId);
    expect(
      (await repo.listForAccount(accountId)).length,
      'linking a second provider replaced the first instead of adding to it',
    ).toBe(2);
  });

  it('CRITICAL stamping a login touches only that link', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const a = await link(accountId, 'google', `sub-${randomUUID()}`);
    const b = await link(accountId, 'github', `sub-${randomUUID()}`);
    await repo.markLoginAt(a.id, new Date());
    const rows = await repo.listForAccount(accountId);
    // toBeInstanceOf, not not.toBeNull(): an unfound row yields undefined,
    // which satisfies not-null and would pass on nothing at all.
    expect(
      rows.find((r) => r.id === a.id)?.lastLoginAt,
      'the login was not recorded',
    ).toBeInstanceOf(Date);
    expect(
      rows.find((r) => r.id === b.id)?.lastLoginAt,
      'signing in through one provider stamped a login on the other',
    ).toBeNull();
  });

  it('CRITICAL a revoked link still resolves, so the service can act on it', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const sub = `sub-${randomUUID()}`;
    const inserted = await link(accountId, 'google', sub);
    await repo.markRevokedAt(inserted.id, new Date());
    const found = await repo.findByProviderSub('google', sub);
    expect(
      found,
      'a revoked link stopped resolving. linkOrCreateAccount reads lastRevokedAt off this row to ' +
        'fork to "existing-link-revoked"; hiding the row sends it down the no-link path instead, ' +
        'where a matching email issues a pending merge',
    ).not.toBeNull();
    expect(found?.lastRevokedAt, 'the revocation was not recorded on the row').toBeInstanceOf(Date);
  });

  it('CRITICAL one account’s links are not another’s', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    await link(mine, 'google', `sub-${randomUUID()}`);
    await link(theirs, 'google', `sub-${randomUUID()}`);
    const rows = await repo.listForAccount(mine);
    expect(rows).toHaveLength(1);
    expect(
      rows.every((r) => r.accountId === mine),
      'the link listing returned another account’s identity providers',
    ).toBe(true);
  });
});

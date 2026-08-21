// V-1207 — one contract, executed against BOTH implementations of `OAuthLinksRepo`.
//
// The second of the twenty-nine V-1197 named as owed, following the V-1198 template. It exists
// because of a drift I introduced myself: V-1201 gave `DrizzleOAuthLinksRepo.listForAccount` an
// `ORDER BY (linked_at, id)` so the customer's "Connected accounts" list stops reordering between
// page loads, and did NOT touch `InMemoryOAuthLinksRepo.listForAccount`, which still returns
// `rows.filter(...)` in insertion order. Two implementations of one interface, one of them
// changed. That is precisely the failure V-1198's template was built to catch, and it caught it.
//
// WHY THE ORDERING ARM NEEDS A BACKDATE. Both implementations assign `linkedAt` at insert time, so
// insertion order and `linkedAt` order agree in any fixture that just inserts twice — the arm would
// pass on both and prove nothing about either. `backdate` pushes one link's `linkedAt` behind the
// other so the two orders DISAGREE, which is the only way the assertion can distinguish "sorted by
// linkedAt" from "whatever order it was written in". Same vacuity trap as V-1191/1194/1201.
//
// THE SECURITY ARM IS `findByProviderSub`. It is deliberately account-unscoped — it IS the login
// lookup, mapping an IDP identity onto whichever account holds it — so the thing protecting one
// customer from another is that it matches on BOTH provider and sub. If it ever matched on sub
// alone, a subject identifier issued by one provider would resolve a link created for another,
// which is an account takeover with no credential involved. Pinning the unscoped-ness alongside it
// is what keeps that read honest, the same asymmetry V-1198 pinned for `findApiKeyUnscoped`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { OAuthLinksRepo } from '../../src/services/oauth-client.js';
import { DrizzleOAuthLinksRepo } from '../../src/db/oauth-links-repo.js';
import { InMemoryOAuthLinksRepo } from './_helpers/in-memory-oauth-links-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM account_oauth_links LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM account_oauth_links WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: OAuthLinksRepo;
  account: () => Promise<string>;
  /** Force a link's `linkedAt`, so insertion order and linked-at order can be made to disagree. */
  backdate: (id: string, at: Date) => Promise<void>;
}

function inMemorySubject(): Subject {
  const repo = new InMemoryOAuthLinksRepo();
  return {
    repo,
    account: () => Promise.resolve(randomUUID()),
    backdate: (id, at) => {
      const row = repo.rows.find((r) => r.id === id);
      if (row) row.linkedAt = at;
      return Promise.resolve();
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleOAuthLinksRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`oauth-contract-${id}@test.local`})`;
      return id;
    },
    backdate: async (id, at) => {
      // Explicit casts: postgres-js will not infer the parameter types for a bare timestamp or
      // uuid here, matching how the repo layer writes its own raw statements.
      await c`UPDATE account_oauth_links
                 SET linked_at = ${at.toISOString()}::timestamptz
               WHERE id = ${id}::uuid`;
    },
  };
}

async function link(
  s: Subject,
  accountId: string,
  provider: 'google' | 'github',
  sub: string,
): Promise<string> {
  const row = await s.repo.insertLink({
    accountId,
    provider,
    providerSub: sub,
    providerEmail: `${sub}@idp.test`,
    providerName: null,
    providerAvatarUrl: null,
  });
  return row.id;
}

function oauthLinksRepoContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`OAuthLinksRepo contract — ${label}`, () => {
    it('CRITICAL a link handed to the caller is a SNAPSHOT — a later write does not reach into it, in both. Postgres cannot mutate a row the caller already holds. A fixture that can makes every before/after comparison against it read "nothing changed", because `before` and `after` are the same object, and the arm then passes forever asserting nothing.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const id = await link(s, account, 'google', `snap-${randomUUID().slice(0, 8)}`);

      const held = (await s.repo.listForAccount(account)).find((r) => r.id === id);
      expect(
        held?.lastLoginAt ?? null,
        'precondition: never logged in through this link',
      ).toBeNull();

      await s.repo.markLoginAt(id, new Date('2026-08-21T00:00:00.000Z'));

      expect(
        held?.lastLoginAt ?? null,
        'the link handed to the caller mutated underneath it — reads are aliasing the store',
      ).toBeNull();
      expect(
        (await s.repo.listForAccount(account)).find((r) => r.id === id)?.lastLoginAt ?? null,
        'and the write itself did not land, so the arm above proves nothing',
      ).not.toBeNull();
    });

    it('CRITICAL findByProviderSub matches on BOTH provider and subject. It is the login lookup and it is account-unscoped by design, so the only thing separating one customer from another is that a subject issued by one provider cannot resolve a link created for a different one — that would be an account takeover with no credential involved.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const sub = `shared-sub-${randomUUID().slice(0, 8)}`;
      const id = await link(s, owner, 'google', sub);

      expect((await s.repo.findByProviderSub('google', sub))?.id, 'the link is not findable').toBe(
        id,
      );
      expect(
        await s.repo.findByProviderSub('github', sub),
        'a subject from another provider resolved this link',
      ).toBeNull();
    });

    it('CRITICAL findByProviderSub really is account-unscoped, in both. It resolves the link whoever holds it — that is what makes it a login lookup rather than a scoped read, and pinning it is what makes the provider+subject arm above meaningful.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const sub = `sub-${randomUUID().slice(0, 8)}`;
      const id = await link(s, owner, 'google', sub);

      const found = await s.repo.findByProviderSub('google', sub);
      expect(found?.id, 'the unscoped lookup stopped resolving').toBe(id);
      expect(found?.accountId, 'the lookup lost the owning account').toBe(owner);
    });

    it("CRITICAL listForAccount is account-scoped and returns the asking account's links. Both halves matter: an implementation returning nothing would satisfy the exclusion on its own.", async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      const id = await link(s, owner, 'google', `own-${randomUUID().slice(0, 8)}`);

      expect((await s.repo.listForAccount(owner)).map((r) => r.id)).toEqual([id]);
      expect(await s.repo.listForAccount(stranger), 'a foreign account listed the link').toEqual(
        [],
      );
    });

    it('CRITICAL listForAccount orders by linkedAt, in both. The customer sees this order directly in Connected accounts, so an implementation that returns insertion order agrees with one that sorts only until the two disagree — which is why the fixture backdates the SECOND link behind the first.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const first = await link(s, owner, 'google', `a-${randomUUID().slice(0, 8)}`);
      const second = await link(s, owner, 'github', `b-${randomUUID().slice(0, 8)}`);

      // Inserted first, second — but linked second, first.
      await s.backdate(second, new Date('2020-01-01T00:00:00.000Z'));

      expect(
        (await s.repo.listForAccount(owner)).map((r) => r.id),
        'the list is in insertion order, not linkedAt order',
      ).toEqual([second, first]);
    });

    it('CRITICAL markRevokedAt stamps the row rather than removing it, in both. The audit view reads revoked links back through this same list, so a delete would erase history the customer is shown.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const id = await link(s, owner, 'google', `rev-${randomUUID().slice(0, 8)}`);

      await s.repo.markRevokedAt(id, new Date('2026-01-01T00:00:00.000Z'));

      const rows = await s.repo.listForAccount(owner);
      expect(
        rows.map((r) => r.id),
        'the revoked link vanished from the account',
      ).toEqual([id]);
      expect(rows[0]?.lastRevokedAt, 'the revocation was not recorded').not.toBeNull();
    });
  });
}

oauthLinksRepoContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'OAuthLinksRepo contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    oauthLinksRepoContract('drizzle', drizzleSubject, () => dbReachable);
  },
);

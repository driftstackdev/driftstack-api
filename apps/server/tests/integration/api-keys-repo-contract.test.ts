// V-1198 — one contract, executed against BOTH implementations of `ApiKeysRepo`.
//
// V-1197 established the structural cause behind eighteen db-layer defects: the unit tests
// for these flows drive `InMemoryApiKeysRepo`, which reimplements scoping in TypeScript, so
// the property was proven in the double and unproven in the SQL that ships. The doubles were
// checked afterwards and every one was CORRECT — which is precisely why nothing failed. A
// wrong double breaks tests and gets fixed; a faithful one keeps the suite green while the
// real artifact goes unchecked.
//
// The remedy named there was a contract test run against both implementations. This is that,
// for one repo, as the template for the other twenty-eight. It is cheap because the two
// classes already share an interface:
//
//     class InMemoryApiKeysRepo implements ApiKeysRepo
//     class DrizzleApiKeysRepo  implements ApiKeysRepo
//
// so the assertions below are written once and parameterised over a factory.
//
// WHAT THIS ADDS over the arms in V-1187. Those pin the Drizzle predicates directly, and they
// stay — this does not replace them. What it adds is the AGREEMENT: if someone tightens the
// double, or loosens the SQL, or fixes one and not the other, the same arm fails on whichever
// side drifted. A property that lives in two implementations needs a test that names both.
//
// The unscoped-escape-hatch arm is deliberate. `findApiKeyUnscoped` exists one method below
// `findApiKey` and is SUPPOSED to ignore the account, so asserting that it does is what makes
// the scoping arm above it meaningful: the two differ by a single clause, and a regression
// that collapsed them would otherwise look like the scoped read simply working.
//
// The Drizzle half is DB-gated the same way its siblings are — quiet skip locally without
// `DATABASE_URL`, hard failure in CI, because a vacuous pass on a boundary contract is worse
// than no test. The in-memory half always runs.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { ApiKeysRepo } from '../../src/services/api-keys.js';
import { DrizzleApiKeysRepo } from '../../src/db/api-keys-repo.js';
import { InMemoryApiKeysRepo } from './_helpers/in-memory-api-keys-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM api_keys LIMIT 0`;
    dbReachable = true;
  } catch {
    /* leave dbReachable false — the Drizzle half skips, the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

/**
 * Each implementation supplies a repo and a way to mint an account id it will accept. The
 * Drizzle rows carry a foreign key to `accounts`; the in-memory store does not, and that
 * difference is a fixture detail rather than part of the contract.
 */
interface Subject {
  repo: ApiKeysRepo;
  account: () => Promise<string>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryApiKeysRepo(),
    account: () => Promise.resolve(randomUUID()),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleApiKeysRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`contract-${id}@test.local`})`;
      return id;
    },
  };
}

/** `key_prefix` is uniquely indexed, so every fixture needs its own. */
async function mintKey(repo: ApiKeysRepo, accountId: string): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const row = await repo.insertApiKey({
    accountId,
    name: `contract-${tag}`,
    scopes: ['read'],
    keyPrefix: `ds_test_${tag}`,
    keyHash: `hash-${tag}`,
    expiresAt: null,
  });
  return row.id;
}

/**
 * The contract. Every assertion here must hold for ANY `ApiKeysRepo`, so it is stated once
 * and run against each implementation.
 */
function apiKeysRepoContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`ApiKeysRepo contract — ${label}`, () => {
    it('CRITICAL findApiKey is account-scoped. The parameter is the entire boundary on this read; both implementations must refuse a foreign account rather than one of them carrying the property while the other is merely believed to.', async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();
      const stranger = await account();
      const keyId = await mintKey(repo, owner);

      expect((await repo.findApiKey(keyId, owner))?.id, 'the owner cannot read its own key').toBe(
        keyId,
      );
      expect(
        await repo.findApiKey(keyId, stranger),
        'a foreign account read the key by id',
      ).toBeNull();
    });

    it("CRITICAL listApiKeys is account-scoped, and returns the asking account's keys. Both halves matter: an implementation that returned nothing at all would satisfy the exclusion on its own.", async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();
      const stranger = await account();
      const keyId = await mintKey(repo, owner);

      expect(
        (await repo.listApiKeys(owner)).map((r) => r.id),
        'the owner sees its own key',
      ).toEqual([keyId]);
      expect(await repo.listApiKeys(stranger), 'a foreign account listed the key').toEqual([]);
    });

    it('CRITICAL findApiKeyUnscoped really is unscoped, in both. It sits one method below the scoped read and exists to ignore the account; pinning that asymmetry is what makes the scoping arm above meaningful, since a regression collapsing the two would otherwise look like the scoped read simply working.', async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();
      const keyId = await mintKey(repo, owner);

      expect(
        (await repo.findApiKeyUnscoped(keyId))?.id,
        'the deliberate escape hatch stopped resolving',
      ).toBe(keyId);
    });

    it('CRITICAL revokeApiKeyAtomic refuses a foreign account and leaves the key live. Its input takes `accountId: string | null`, where null is the deliberate admin-unscoped path — so a customer call that stops scoping becomes the admin path without changing shape.', async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();
      const stranger = await account();
      const keyId = await mintKey(repo, owner);

      const result = await repo.revokeApiKeyAtomic({
        id: keyId,
        accountId: stranger,
        revokedAt: new Date(),
      });
      expect(result.kind, 'a foreign account revoked the key').not.toBe('revoked');
      expect(
        (await repo.findApiKey(keyId, owner))?.revokedAt ?? null,
        'the key was revoked by someone else',
      ).toBeNull();
    });

    it('CRITICAL a cursor survives the boundary key being REVOKED between pages, in both. The listing filters on `revoked`, and revoking a key is an ordinary customer action — so the cursor row leaves the filtered set during exactly the workflow this listing serves. Resolving the cursor by its POSITION inside the filtered array returns -1 once that happens, which reads as "start from the top": page two comes back as page one and the caller acts twice on keys it has already seen. The Drizzle anchor lookup scopes by account only, never by revoked, which is what lets the cursor row be gone from the page and still hold its place.', async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();
      // Four active keys. mintKey stamps createdAt from the clock, so space them out to
      // make the DESC order deterministic rather than a same-millisecond tie.
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(await mintKey(repo, owner));
        await new Promise((r) => setTimeout(r, 5));
      }
      const newestFirst = [...ids].reverse();

      const first = await repo.listAllApiKeys({ limit: 2, accountId: owner, revoked: false });
      expect(
        first.items.map((k) => k.id),
        'page one was not the two newest active keys',
      ).toEqual(newestFirst.slice(0, 2));

      // The key at the page boundary is revoked, so it leaves the `revoked: false` set.
      const boundary = first.nextCursor;
      expect(boundary, 'page one handed out no cursor').not.toBeNull();
      await repo.revokeApiKeyAtomic({
        id: boundary ?? '',
        accountId: owner,
        revokedAt: new Date(),
      });

      const second = await repo.listAllApiKeys({
        limit: 2,
        accountId: owner,
        revoked: false,
        cursor: boundary ?? undefined,
      });
      expect(
        second.items.map((k) => k.id),
        'page two restarted from the top after the boundary key was revoked, repeating keys from page one',
      ).toEqual(newestFirst.slice(2, 4));
    });
  });
}

apiKeysRepoContract('in-memory double', inMemorySubject, () => true);

// Same contract, real SQL. Quiet skip locally without a database; hard failure in CI, because
// a vacuous pass on a boundary contract reports the property as proven when nothing ran.
describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)('ApiKeysRepo contract — real', () => {
  it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
    if (!process.env.CI && !dbReachable) return;
    expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
      true,
    );
  });

  apiKeysRepoContract('drizzle', drizzleSubject, () => dbReachable);
});

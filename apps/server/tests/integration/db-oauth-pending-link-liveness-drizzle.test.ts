// `DrizzleOAuthPendingLinksRepo` liveness and single-use, against real Postgres.
//
// A pending link is the short-lived token that binds an OAuth provider identity
// to an existing account. Three SQL-level rules decide whether one is still
// usable, and all three were held by NOTHING but a content-parity pin over the
// source text (`db-oauth-links-repo-content-parity.test.ts`):
//
//   findActiveByTokenHash  isNull(consumedAt)   — a consumed token is spent
//   findActiveByTokenHash  gt(expiresAt, now)   — an expired token is dead
//   markConsumedAt         isNull(consumedAt)   — the conditional CAS that makes
//                                                 consumption single-use
//
// Measured by mutation at full unit scope: dropping the consumed filter, dropping
// the expiry filter, and dropping the CAS predicate each redded ONLY that pin.
// No test anywhere drove these against a database — `oauth_pending_links` did not
// appear in a single integration test.
//
// A text pin fires when the source text changes, which is exactly what a refactor
// does, so it is updated as part of the very change it should have caught. That
// makes it the weakest possible guard for a rule whose failure mode is a spent or
// expired token still resolving.
//
// Run scope: CI always (postgres:17, migrated). Local dev skips unless a
// reachable DATABASE_URL is set.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleOAuthPendingLinksRepo } from '../../src/db/oauth-links-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
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
  client = postgres(DB_URL, { max: 2 });
  try {
    await client`SELECT 1 FROM oauth_pending_links LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const id of seeded) {
    await client`DELETE FROM oauth_pending_links WHERE account_id = ${id}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'oauth pending links (real Postgres) — spent and expired tokens must not resolve',
  () => {
    const mkRepo = (): DrizzleOAuthPendingLinksRepo => {
      if (!client) throw new Error('no client');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      return new DrizzleOAuthPendingLinksRepo({ client, db, close: async () => {} });
    };

    async function seedAccount(): Promise<string> {
      if (!client) throw new Error('no client');
      const id = randomUUID();
      seeded.push(id);
      await client`INSERT INTO accounts (id, email)
                   VALUES (${id}, ${`oauth-pending-${id}@test.local`})`;
      return id;
    }

    /** A pending link whose token hash is unique to this call. */
    async function seedPending(expiresAt: Date): Promise<{ id: string; tokenHash: string }> {
      const accountId = await seedAccount();
      const tokenHash = `hash-${randomUUID()}`;
      const row = await mkRepo().insertPending({
        accountId,
        provider: 'google',
        providerSub: `sub-${randomUUID()}`,
        providerEmail: `p-${randomUUID()}@provider.test`,
        providerName: null,
        providerAvatarUrl: null,
        tokenHash,
        expiresAt,
      });
      return { id: row.id, tokenHash };
    }

    const soon = (): Date => new Date(Date.now() + 10 * 60 * 1000);
    const past = (): Date => new Date(Date.now() - 10 * 60 * 1000);

    it('CRITICAL the database is reachable and the table present, so the arms below cannot pass vacuously', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and oauth_pending_links present').toBe(true);
    });

    it('a live, unconsumed pending link resolves — the arm that keeps the refusals honest', async () => {
      if (!dbReachable || !client) return;
      const { id, tokenHash } = await seedPending(soon());
      const found = await mkRepo().findActiveByTokenHash(tokenHash, new Date());
      expect(found?.id, 'a live token resolves to its row').toBe(id);
    });

    it('CRITICAL a CONSUMED pending link no longer resolves, so a replayed link token is inert', async () => {
      if (!dbReachable || !client) return;
      const repo = mkRepo();
      const { id, tokenHash } = await seedPending(soon());
      expect(await repo.markConsumedAt(id, new Date()), 'first consumption wins').toBe(true);
      expect(
        await repo.findActiveByTokenHash(tokenHash, new Date()),
        'and the token is spent from then on',
      ).toBeNull();
    });

    it('CRITICAL an EXPIRED pending link never resolves, however untouched it is', async () => {
      if (!dbReachable || !client) return;
      const { tokenHash } = await seedPending(past());
      expect(await mkRepo().findActiveByTokenHash(tokenHash, new Date())).toBeNull();
    });

    it('CRITICAL consumption is single-use at the SQL level — a second claim on the same row loses', async () => {
      if (!dbReachable || !client) return;
      const repo = mkRepo();
      const { id } = await seedPending(soon());
      expect(await repo.markConsumedAt(id, new Date()), 'the first claim wins').toBe(true);
      expect(
        await repo.markConsumedAt(id, new Date()),
        'the second is refused by the conditional predicate, not by the caller',
      ).toBe(false);
    });

    it('an unknown token hash resolves to nothing, so the lookup is not simply returning any row', async () => {
      if (!dbReachable || !client) return;
      await seedPending(soon());
      expect(await mkRepo().findActiveByTokenHash(`hash-${randomUUID()}`, new Date())).toBeNull();
    });
  },
);

// V-997 — two account-scoped READS whose predicate is the whole boundary.
//
// `db-repo-account-scoped-reads-boundary` (2026-08-07) is the second pass of the
// ownership mutation sweep and covers three reads: `crypto-orders-repo.listAll`,
// `bundled-llm-repo.sumMonthlySpendCents`, `oauth-links-repo.listForAccount`. These
// two are the same shape and were not in it — both sit on V-993's list of 19
// account-scoped `src/db` functions no integration test executes.
//
//   `auth-flows-repo.listActiveWebSessionsForAccount(accountId, now)`
//   `profiles-repo.listTrashed({ accountId })`
//
// **Neither has a second line.** `listActiveWebSessions` is a straight pass-through —
// `routes/account-web-sessions.ts` calls it with `ctx.account.id` and maps the rows to
// the response, adding no filter — so the repo's `eq(webSessions.accountId, …)` is the
// only thing between one customer and every customer's active sign-ins: device string,
// issuing IP, last-used time, one row per live session. `listTrashed` is the same
// shape through `services/profiles.ts`, returning the recycle-bin listing.
//
// What existed before this file: both rules are implemented a SECOND time, by hand, in
// the in-memory doubles the integration tests wire —
// `_helpers/in-memory-auth-flows-repo.ts` filters with
// `if (row.accountId !== accountId) continue;`, and `_helpers/in-memory-profiles-repo.ts`
// does the equivalent. `auth-flows.test.ts` imports the double. So the RULE is proven
// against a re-implementation of itself and the shipped SQL never runs.
//
// V-999 CORRECTION — for the web-session arm that understates what existed.
// `db-auth-flows-repo-content-parity` pins that method's full WHERE, so unscoping it
// REDS an existing test; this arm is defence-in-depth against a reformat the regex
// cannot survive, not a closed hole. `listTrashed` IS unheld: unscoped, 290 tests
// over 15 profiles files stay green, because the only pin on it freezes the
// signature plus a file-level `toContain('isNotNull(profiles.deletedAt)')` that any
// other method in the file satisfies.
//
// The sibling predicates in the same WHERE are pinned alongside the account one,
// because a boundary test that only proves tenancy leaves them free to drift:
// `isNull(revokedAt)` and `expiresAt > now` decide whether a revoked or expired
// sign-in is still advertised as active, and `deletedAt` decides whether a LIVE
// profile appears in the recycle bin.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
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
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM web_sessions LIMIT 0`;
    await client`SELECT 1 FROM profiles LIMIT 0`;
    await client`SELECT 1 FROM webhook_endpoints LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM webhook_endpoints WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM web_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

/** Hard-fail in CI, quiet skip locally — a vacuous pass would report a boundary as proven. */
function unusable(what: string): boolean {
  if (dbReachable && client) return false;
  if (process.env.CI) {
    throw new Error(`real-PG ${what} tenant-scope test: database unreachable/unmigrated in CI`);
  }
  return true;
}

async function seedPair(sql: ReturnType<typeof postgres>, tag: string): Promise<[string, string]> {
  const owner = randomUUID();
  const stranger = randomUUID();
  seeded.push(owner, stranger);
  for (const [id, who] of [
    [owner, 'owner'],
    [stranger, 'stranger'],
  ] as const) {
    await sql`INSERT INTO accounts (id, email) VALUES (${id}, ${`${tag}-${who}-${id}@test.local`})`;
  }
  return [owner, stranger];
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'account-scoped list predicates (real Postgres)',
  () => {
    it("CRITICAL listActiveWebSessionsForAccount returns only the asking account's live sign-ins. The route maps these straight to the response with no filter of its own, so this predicate is the only thing between one customer and every customer's device, IP and last-used time. Held today by a content-parity regex over the source and by the in-memory double; this is the executable proof neither of those is.", async () => {
      if (unusable('web sessions')) return;
      const sql = client as ReturnType<typeof postgres>;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client: sql, db, close: async () => {} });
      const [owner, stranger] = await seedPair(sql, 'ws');

      // Timestamps as SQL intervals, not JS Dates: postgres.js refuses a raw Date
      // bind ("must be of type string or Buffer"), which is the same trap ci.yml
      // records these suites carrying since birth.
      const [ownerLive] = await sql`
        INSERT INTO web_sessions (account_id, token_hash, expires_at, user_agent)
        VALUES (${owner}, ${`h-owner-${owner}`}, now() + interval '1 hour', 'owner-device') RETURNING id`;
      const [ownerRevoked] = await sql`
        INSERT INTO web_sessions (account_id, token_hash, expires_at, revoked_at)
        VALUES (${owner}, ${`h-owner-rev-${owner}`}, now() + interval '1 hour', now()) RETURNING id`;
      const [ownerExpired] = await sql`
        INSERT INTO web_sessions (account_id, token_hash, expires_at)
        VALUES (${owner}, ${`h-owner-exp-${owner}`}, now() - interval '1 hour') RETURNING id`;
      const [strangerLive] = await sql`
        INSERT INTO web_sessions (account_id, token_hash, expires_at, user_agent)
        VALUES (${stranger}, ${`h-stranger-${stranger}`}, now() + interval '1 hour', 'stranger-device') RETURNING id`;

      const rows = await repo.listActiveWebSessionsForAccount(owner, new Date());
      const ids = rows.map((r) => r.id);

      // Positive control first — otherwise every assertion below also passes on a
      // query that returns nothing at all.
      expect(ids, "the owner's own live sign-in must be listed").toContain(ownerLive?.id as string);
      // The tenant boundary.
      expect(ids, "another account's sign-in must never be listed").not.toContain(
        strangerLive?.id as string,
      );
      // The sibling predicates in the same WHERE.
      expect(ids, 'a revoked sign-in must not be advertised as active').not.toContain(
        ownerRevoked?.id as string,
      );
      expect(ids, 'an expired sign-in must not be advertised as active').not.toContain(
        ownerExpired?.id as string,
      );
      // Exact, not a superset — a list that quietly grew is the failure this catches.
      expect(ids).toEqual([ownerLive?.id as string]);

      // And the stranger sees exactly their own, so the arms above are a boundary
      // rather than a query that returns one row for everyone.
      const theirs = await repo.listActiveWebSessionsForAccount(stranger, new Date());
      expect(theirs.map((r) => r.id)).toEqual([strangerLive?.id as string]);
    });

    it("CRITICAL listEndpoints returns only the asking account's webhook endpoints. V-1000 — the eighth and last genuinely unheld predicate on the cold list: unscoping it leaves 357 tests over 30 webhook files green. The customer-facing list is a pass-through (`services/webhooks.ts:447` returns it directly), so unscoped it hands every account's endpoint URLs to any caller. The route maps to `secret_prefix` rather than the decrypted secret, so signing secrets do NOT leak — the disclosure is the URLs and their metadata, which is bad enough and is stated at its real size.", async () => {
      if (unusable('webhook endpoints')) return;
      const sql = client as ReturnType<typeof postgres>;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleWebhooksRepo(
        { client: sql, db, close: async () => {} },
        { secretEncryptionKeyBase64: Buffer.alloc(32, 17).toString('base64') },
      );
      const [owner, stranger] = await seedPair(sql, 'wh');

      // Rows are created through the repo rather than seeded by hand: the stored
      // secret must be a v2 envelope, and a raw plaintext one makes the read throw
      // before any assertion runs.
      const ownerEp = await repo.insertEndpoint({
        accountId: owner,
        url: 'https://owner.test/hook',
        secret: 'whsec_abcdefghijklmnopqrstuvwxyz234567',
        secretPrefix: 'whsec_owner',
        events: ['session.completed'],
        description: null,
      });
      const strangerEp = await repo.insertEndpoint({
        accountId: stranger,
        url: 'https://stranger.test/hook',
        secret: 'whsec_abcdefghijklmnopqrstuvwxyz234567',
        secretPrefix: 'whsec_stranger',
        events: ['session.completed'],
        description: null,
      });

      const ids = (await repo.listEndpoints(owner)).map((e) => e.id);
      expect(ids, "the owner's own endpoint must be listed").toContain(ownerEp.id);
      expect(ids, "another account's webhook endpoint must never be listed").not.toContain(
        strangerEp.id,
      );
      expect(ids).toEqual([ownerEp.id]);
    });

    it("CRITICAL listTrashed returns only the asking account's trashed profiles, and no live one. The recycle-bin listing goes straight back through services/profiles.ts, so this predicate is the boundary; the rule is currently proven against the in-memory profiles double.", async () => {
      if (unusable('profiles listTrashed')) return;
      const sql = client as ReturnType<typeof postgres>;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client: sql, db, close: async () => {} });
      const [owner, stranger] = await seedPair(sql, 'trash');

      const [ownerTrashed] = await sql`
        INSERT INTO profiles (account_id, name, deleted_at) VALUES (${owner}, 'owner trashed', now()) RETURNING id`;
      const [ownerLive] = await sql`
        INSERT INTO profiles (account_id, name) VALUES (${owner}, 'owner live') RETURNING id`;
      const [strangerTrashed] = await sql`
        INSERT INTO profiles (account_id, name, deleted_at) VALUES (${stranger}, 'stranger trashed', now()) RETURNING id`;

      const ids = (await repo.listTrashed({ accountId: owner })).map((p) => p.id);

      expect(ids, "the owner's trashed profile must be listed").toContain(
        ownerTrashed?.id as string,
      );
      expect(ids, "another account's trashed profile must never be listed").not.toContain(
        strangerTrashed?.id as string,
      );
      expect(ids, 'a live profile must not appear in the recycle bin').not.toContain(
        ownerLive?.id as string,
      );
      expect(ids).toEqual([ownerTrashed?.id as string]);
    });
  },
);

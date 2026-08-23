// V-1317 — the last two paginated repos whose overfetch boundary nothing exercised.
//
// Every paginated repo fetches `limit + 1` rows and derives `hasMore = rows.length > limit`. The
// classic defect is `>=`, and it only shows when the final page is EXACTLY full — when the row
// count is an exact multiple of the limit. Past that line the repo reports more rows than exist and
// hands back a cursor onto a page that is not there, so the caller's own paging loop makes one more
// request and receives nothing.
//
// Mutating all fourteen boundary sites to `>=` at once left the suite's behavioural coverage almost
// untouched: twenty-one files went red, but nineteen of them were source-text pins that fired
// because the LINE changed, not because anything observed the wrong answer. Those pins would fire
// identically on a correct refactor, and would say nothing at all if someone updated the pin to
// match a wrong new line.
//
// The other twelve repos are covered by arms added to the `db-*-keyset-drizzle` harnesses that
// already existed for them. These two had no paging harness to extend: `recipes-repo` and
// `profile-snapshots-repo` appear in DB-backed tests only for encryption and tenant scoping, and a
// pagination arm bolted onto either of those would sit outside what the file is about. Hence a file.
//
// WHY THIS CANNOT LIVE AT THE ROUTE LEVEL. `buildTestApp` wires the in-memory doubles, so route
// tests exercise the doubles' paging and are structurally incapable of seeing a Drizzle mistake.
// The doubles derive `hasMore` correctly and are not the subject here; the Drizzle path is.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { DrizzleRecipesRepo } from '../../src/db/recipes-repo.js';
import { DrizzleProfileSnapshotsRepo } from '../../src/db/profile-snapshots-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Recipe payloads are encrypted at rest, so fixtures go through the repo rather than raw SQL. */
const RECIPE_KEY = Buffer.alloc(32, 7).toString('base64');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let recipesRepo: DrizzleRecipesRepo | null = null;
let snapshotsRepo: DrizzleProfileSnapshotsRepo | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM recipes LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 2 });
  const db = drizzle(client, { schema });
  const handle = { client, db, close: async () => {} };
  recipesRepo = new DrizzleRecipesRepo(handle, { payloadEncryptionKeyBase64: RECIPE_KEY });
  snapshotsRepo = new DrizzleProfileSnapshotsRepo(handle);
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM recipes WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM profile_snapshots WHERE account_id = ${accountId}`.catch(() => {});
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
    VALUES (${accountId}, ${`paging-boundary-${accountId}@test.local`}, 'active')`;
  return accountId;
}

/**
 * Created through the repo (the payload is encrypted), then stamped to a chosen instant.
 *
 * The stamping is what makes the ordering total: four rows created in a loop can land on the same
 * millisecond, and while the (createdAt, id) keyset still pages them correctly, a fixture whose
 * order depends on tie-breaking is a fixture that argues with itself later.
 */
async function seedRecipe(accountId: string, createdAt: Date): Promise<void> {
  if (!recipesRepo || !client) throw new Error('no repo');
  const rec = await recipesRepo.create({
    accountId,
    agentSessionId: null,
    label: `boundary-${randomUUID().slice(0, 8)}`,
    intentLog: [],
    transcriptSnapshot: [],
  });
  await client`
    UPDATE recipes SET created_at = ${createdAt.toISOString()}::timestamptz WHERE id = ${rec.id}`;
}

/** Snapshots are read with a plain row mapper, so raw SQL is safe here. */
async function seedSnapshot(accountId: string, createdAt: Date): Promise<void> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO profile_snapshots (id, account_id, label, parent_archetype, parent_name, created_at)
    VALUES (${id}, ${accountId}, ${`snap-${id.slice(0, 8)}`}, 'iphone17_ios18_7_safari26_4',
            'parent', ${createdAt.toISOString()}::timestamptz)`;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a full final page reports no further pages (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable, so a green run here is not "no database". Both arms below are SQL round-trips; skipped silently they would report success having paged nothing.', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — neither boundary would be exercised`).toBe(
        true,
      );
    });

    it('CRITICAL recipes: a page the size of the whole population offers no cursor, and a walk whose final page is exactly full ends there. A recipe list that reports more rows than exist sends the customer’s next request to an empty page.', async () => {
      if (!dbReachable || !recipesRepo) return;
      const accountId = await seedAccount();
      const base = Date.UTC(2026, 0, 2, 0, 0, 0);
      for (let i = 0; i < 4; i += 1) {
        await seedRecipe(accountId, new Date(base + i * 1000));
      }

      const exact = await recipesRepo.list({ accountId, limit: 4 });
      expect(exact.data, 'the full population came back in one page').toHaveLength(4);
      expect(exact.hasMore, 'a full final page has no rows behind it').toBe(false);
      expect(
        exact.nextCursor,
        'a full final page must not offer a cursor — it leads to an empty page',
      ).toBeNull();

      const first = await recipesRepo.list({ accountId, limit: 2 });
      expect(first.data, 'first page is full').toHaveLength(2);
      expect(first.hasMore, 'four rows at limit two: there IS a second page').toBe(true);
      expect(first.nextCursor, 'and a cursor to reach it').not.toBeNull();

      const second = await recipesRepo.list({ accountId, limit: 2, cursor: first.nextCursor! });
      expect(second.data, 'the second page is also exactly full').toHaveLength(2);
      expect(second.hasMore, 'and it is the last one').toBe(false);
      expect(second.nextCursor, 'so it offers no cursor').toBeNull();
    });

    it('CRITICAL profile snapshots: the same boundary. Snapshots are what a customer restores a profile from, and a listing that claims another page hands their tooling a cursor that fetches nothing.', async () => {
      if (!dbReachable || !snapshotsRepo) return;
      const accountId = await seedAccount();
      const base = Date.UTC(2026, 0, 3, 0, 0, 0);
      for (let i = 0; i < 4; i += 1) {
        await seedSnapshot(accountId, new Date(base + i * 1000));
      }

      const exact = await snapshotsRepo.list({ accountId, limit: 4 });
      expect(exact.data, 'the full population came back in one page').toHaveLength(4);
      expect(exact.hasMore, 'a full final page has no rows behind it').toBe(false);
      expect(
        exact.nextCursor,
        'a full final page must not offer a cursor — it leads to an empty page',
      ).toBeNull();

      const first = await snapshotsRepo.list({ accountId, limit: 2 });
      expect(first.data, 'first page is full').toHaveLength(2);
      expect(first.hasMore, 'four rows at limit two: there IS a second page').toBe(true);
      expect(first.nextCursor, 'and a cursor to reach it').not.toBeNull();

      const second = await snapshotsRepo.list({ accountId, limit: 2, cursor: first.nextCursor! });
      expect(second.data, 'the second page is also exactly full').toHaveLength(2);
      expect(second.hasMore, 'and it is the last one').toBe(false);
      expect(second.nextCursor, 'so it offers no cursor').toBeNull();
    });
  },
);

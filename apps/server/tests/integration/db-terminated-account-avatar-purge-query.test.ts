// Security sweep E-23 (2026-09-24): the query that decides whose avatar leaves
// the public bucket, and the write that records it gone.
//
// `findTerminatedAccountIdsWithAvatarBefore` feeds an irreversible delete of
// public-bucket objects; `clearAvatarKey` then drops the pointer, which is what
// makes the arm self-limiting. The sweeper tests use in-memory doubles and prove
// only the orchestration; these run the SQL. Both directions matter: a live
// customer's avatar must never be selected, and a terminated account past the
// window must be.
//
// `findAvatarKeysForAccounts` is the other read an irreversible delete trusts:
// the orphan reaper deletes any avatar object that is not its account's current
// pointer, so a pointer it failed to return would read as "nothing points here".

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import {
  DrizzleAvatarPointerRepo,
  DrizzleTerminatedAccountAvatarPurgeRepo,
} from '../../src/db/account-deletion-purge-repo.js';
import * as schema from '../../src/db/schema.js';

// Its own database, like the sibling purge-query files: the candidate query is
// GLOBAL across accounts, so on a shared database other files' rows are
// candidates too.
const ISOLATED_DB_NAME = 'driftstack_iso_purge_avatar';
let DB_URL = '';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-01T12:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 30 * DAY_MS);

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleTerminatedAccountAvatarPurgeRepo | null = null;
let pointerRepo: DrizzleAvatarPointerRepo | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM accounts LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
  const db = drizzle(client, { schema });
  repo = new DrizzleTerminatedAccountAvatarPurgeRepo({ client, db, close: async () => {} });
  pointerRepo = new DrizzleAvatarPointerRepo({ client, db, close: async () => {} });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccount(args: {
  status: 'active' | 'suspended' | 'deleted';
  deletedDaysAgo: number | null;
  hasAvatar: boolean;
}): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seeded.push(accountId);
  const deletedAt =
    args.deletedDaysAgo === null
      ? null
      : new Date(NOW.getTime() - args.deletedDaysAgo * DAY_MS).toISOString();
  await client`
    INSERT INTO accounts (id, email, status, deleted_at, avatar_r2_key)
    VALUES (
      ${accountId},
      ${`avatar-candidate-${accountId}@test.local`},
      ${args.status}::account_status,
      ${deletedAt},
      ${args.hasAvatar ? `avatars/${accountId}.png` : null}
    )`;
  return accountId;
}

async function avatarKeyOf(accountId: string): Promise<string | null> {
  const rows = await client!<Array<{ avatar_r2_key: string | null }>>`
    SELECT avatar_r2_key FROM accounts WHERE id = ${accountId}`;
  return rows[0]?.avatar_r2_key ?? null;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'the avatar purge selects exactly the terminated accounts past the window',
  () => {
    it('CRITICAL the database is reachable — otherwise every case below would skip and prove nothing', () => {
      expect(dbReachable, `could not reach ${DB_URL}`).toBe(true);
    });

    it('CRITICAL a terminated account past the cutoff WITH an avatar is selected', async () => {
      const id = await seedAccount({ status: 'deleted', deletedDaysAgo: 45, hasAvatar: true });
      expect(await repo!.findTerminatedAccountIdsWithAvatarBefore(CUTOFF)).toContain(id);
    });

    it("CRITICAL a live customer's avatar is never selected — active, suspended, or active with a stale deleted_at", async () => {
      const active = await seedAccount({ status: 'active', deletedDaysAgo: null, hasAvatar: true });
      const suspended = await seedAccount({
        status: 'suspended',
        deletedDaysAgo: null,
        hasAvatar: true,
      });
      // Proves the status predicate is load-bearing: this row passes the
      // deleted_at predicates on its own.
      const reinstated = await seedAccount({
        status: 'deleted',
        deletedDaysAgo: 90,
        hasAvatar: true,
      });
      await client!`UPDATE accounts SET status = 'active' WHERE id = ${reinstated}`;

      const ids = await repo!.findTerminatedAccountIdsWithAvatarBefore(CUTOFF);

      expect(ids).not.toContain(active);
      expect(ids).not.toContain(suspended);
      expect(ids).not.toContain(reinstated);
    });

    it('an account terminated inside the window, or with no avatar, is not selected', async () => {
      const recent = await seedAccount({ status: 'deleted', deletedDaysAgo: 5, hasAvatar: true });
      const none = await seedAccount({ status: 'deleted', deletedDaysAgo: 45, hasAvatar: false });
      const ids = await repo!.findTerminatedAccountIdsWithAvatarBefore(CUTOFF);
      expect(ids).not.toContain(recent);
      expect(ids).not.toContain(none);
    });

    it('CRITICAL clearing the pointer drops the account out of the candidate set (self-limiting), and never touches a live account', async () => {
      const gone = await seedAccount({ status: 'deleted', deletedDaysAgo: 45, hasAvatar: true });
      const live = await seedAccount({ status: 'active', deletedDaysAgo: null, hasAvatar: true });

      await repo!.clearAvatarKey(gone);
      await repo!.clearAvatarKey(live);

      expect(await avatarKeyOf(gone)).toBeNull();
      expect(await repo!.findTerminatedAccountIdsWithAvatarBefore(CUTOFF)).not.toContain(gone);
      expect(await avatarKeyOf(live), 'a live account keeps its avatar').toBe(
        `avatars/${live}.png`,
      );
    });

    it('the per-tick bound is applied in SQL', async () => {
      for (let i = 0; i < 3; i += 1) {
        await seedAccount({ status: 'deleted', deletedDaysAgo: 60, hasAvatar: true });
      }
      expect((await repo!.findTerminatedAccountIdsWithAvatarBefore(CUTOFF, 2)).length).toBe(2);
    });
  },
);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  "the orphan reaper reads each account's current avatar pointer",
  () => {
    it('CRITICAL the database is reachable — otherwise every case below would skip and prove nothing', () => {
      expect(dbReachable, `could not reach ${DB_URL}`).toBe(true);
    });

    it('CRITICAL returns the current pointer of every account asked about, whatever its status, so no image an account still points at is ever read as an orphan', async () => {
      const live = await seedAccount({ status: 'active', deletedDaysAgo: null, hasAvatar: true });
      const suspended = await seedAccount({
        status: 'suspended',
        deletedDaysAgo: null,
        hasAvatar: true,
      });
      const deleted = await seedAccount({ status: 'deleted', deletedDaysAgo: 5, hasAvatar: true });

      const keys = await pointerRepo!.findAvatarKeysForAccounts([live, suspended, deleted]);

      expect(keys.get(live)).toBe(`avatars/${live}.png`);
      expect(keys.get(suspended)).toBe(`avatars/${suspended}.png`);
      expect(keys.get(deleted)).toBe(`avatars/${deleted}.png`);
    });

    it('CRITICAL an account with no avatar maps to null, and an id with no account row is absent; the reaper treats both as pointing at nothing', async () => {
      const removed = await seedAccount({
        status: 'active',
        deletedDaysAgo: null,
        hasAvatar: false,
      });
      const noRow = randomUUID();

      const keys = await pointerRepo!.findAvatarKeysForAccounts([removed, noRow]);

      expect(keys.has(removed)).toBe(true);
      expect(keys.get(removed)).toBeNull();
      expect(keys.has(noRow)).toBe(false);
    });

    it('returns only the accounts asked about, and nothing for an empty list', async () => {
      const asked = await seedAccount({ status: 'active', deletedDaysAgo: null, hasAvatar: true });
      await seedAccount({ status: 'active', deletedDaysAgo: null, hasAvatar: true });

      expect([...(await pointerRepo!.findAvatarKeysForAccounts([asked])).keys()]).toEqual([asked]);
      expect((await pointerRepo!.findAvatarKeysForAccounts([])).size).toBe(0);
    });
  },
);

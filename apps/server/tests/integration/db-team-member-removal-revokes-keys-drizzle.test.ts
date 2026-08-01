// V-726 — real-Postgres proof that removing a team member revokes the API keys
// that member minted on the OWNER's account, in the same transaction.
//
// An admin-role member can mint keys on the owner (POST /v1/api-keys with
// X-Driftstack-Account). Such a key is stored with account_id = the owner, and
// authentication resolves the account straight from account_id
// (services/auth.ts) without ever re-checking whether the minter is still a
// member. So deleting the membership did nothing to the credential: an
// offboarded member kept a working key with full owner authority.
//
// This has to be proved against real Postgres rather than the in-memory twin.
// The revocation is an UPDATE inside removeMemberWithInvites' transaction, and
// what matters is the SQL: that it matches on (account_id, created_by_account_id)
// with revoked_at IS NULL, that the new column and its supporting index exist,
// and above all that it revokes ONLY the departing member's keys. A twin that
// filters the same fields in JavaScript proves the intent, not the statement.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleTeamMembersRepo } from '../../src/db/team-members-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccountIds: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
  try {
    // Requires migration 0111 — without the column there is nothing to prove.
    await client`SELECT created_by_account_id FROM api_keys LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seededAccountIds) {
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'team member removal revokes that member keys (Drizzle path, real Postgres)',
  () => {
    it('revokes only the departing member keys on the owner account, atomically with the membership delete', async () => {
      if (!dbReachable || !client) {
        throw new Error('real PostgreSQL setup failed');
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleTeamMembersRepo({ client, db, close: async () => {} });

      const ownerId = randomUUID();
      const departingId = randomUUID();
      const stayingId = randomUUID();
      seededAccountIds.push(ownerId, departingId, stayingId);
      for (const [id, label] of [
        [ownerId, 'owner'],
        [departingId, 'departing'],
        [stayingId, 'staying'],
      ] as const) {
        await client`INSERT INTO accounts (id, email) VALUES (${id}, ${`${label}-${id}@test.local`})`;
      }

      const membershipId = randomUUID();
      await client`
        INSERT INTO team_members
          (id, owner_account_id, member_account_id, role, invited_by_account_id, invited_at, accepted_at)
        VALUES (${membershipId}, ${ownerId}, ${departingId}, 'admin', ${ownerId}, now(), now())
      `;

      // Five keys, all on the OWNER's account. Only the two live ones minted by
      // the departing member may be revoked.
      const keys = {
        departingLive: randomUUID(),
        departingLive2: randomUUID(),
        ownerOwn: randomUUID(),
        otherMember: randomUUID(),
        unattributed: randomUUID(),
      };
      const rows: [string, string | null][] = [
        [keys.departingLive, departingId],
        [keys.departingLive2, departingId],
        [keys.ownerOwn, ownerId],
        [keys.otherMember, stayingId],
        [keys.unattributed, null], // written before migration 0111
      ];
      for (const [id, createdBy] of rows) {
        await client`
          INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, created_by_account_id)
          VALUES (${id}, ${ownerId}, ${`k-${id}`}, ${`ds_test_${id.slice(0, 8)}`}, ${`hash-${id}`}, ${createdBy})
        `;
      }

      const result = await repo.removeMemberWithInvites(membershipId, ownerId);

      expect(result).not.toBeNull();
      expect(result?.memberAccountId).toBe(departingId);
      expect([...(result?.revokedApiKeyIds ?? [])].sort()).toEqual(
        [keys.departingLive, keys.departingLive2].sort(),
      );

      const live = await client`
        SELECT id FROM api_keys WHERE account_id = ${ownerId} AND revoked_at IS NULL
      `;
      // The owner's own key, the remaining member's, and the unattributed one
      // all survive: revoking on a guess would break the owner's integrations.
      expect(live.map((r) => String(r.id)).sort()).toEqual(
        [keys.ownerOwn, keys.otherMember, keys.unattributed].sort(),
      );

      // ...and the membership really is gone, in the same transaction.
      const remaining = await client`SELECT id FROM team_members WHERE id = ${membershipId}`;
      expect(remaining).toHaveLength(0);
    });

    it('carries the supporting partial index for the removal sweep', async () => {
      if (!dbReachable || !client) {
        throw new Error('real PostgreSQL setup failed');
      }
      const indexes = await client`
        SELECT indexdef
          FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'api_keys'
           AND indexname = 'api_keys_account_created_by_idx'
      `;
      expect(indexes).toHaveLength(1);
      expect(String(indexes[0]?.indexdef)).toMatch(/\(account_id, created_by_account_id\)/i);
    });

    it('keeps a key alive when its minter account is deleted, dropping only the attribution', async () => {
      // ON DELETE SET NULL, not CASCADE. An unrelated account closure must not
      // take out keys the owner's systems depend on.
      if (!dbReachable || !client) {
        throw new Error('real PostgreSQL setup failed');
      }
      const ownerId = randomUUID();
      const minterId = randomUUID();
      seededAccountIds.push(ownerId, minterId);
      await client`INSERT INTO accounts (id, email) VALUES (${ownerId}, ${`o2-${ownerId}@test.local`})`;
      await client`INSERT INTO accounts (id, email) VALUES (${minterId}, ${`m2-${minterId}@test.local`})`;
      const keyId = randomUUID();
      await client`
        INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, created_by_account_id)
        VALUES (${keyId}, ${ownerId}, 'survivor', ${`ds_test_${keyId.slice(0, 8)}`}, ${`hash-${keyId}`}, ${minterId})
      `;

      await client`DELETE FROM accounts WHERE id = ${minterId}`;

      const after = await client`
        SELECT created_by_account_id, revoked_at FROM api_keys WHERE id = ${keyId}
      `;
      expect(after).toHaveLength(1);
      expect(after[0]?.created_by_account_id).toBeNull();
      expect(after[0]?.revoked_at).toBeNull();
    });
  },
);
